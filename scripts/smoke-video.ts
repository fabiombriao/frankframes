// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Valida o pipeline com um vídeo real do usuário.
 *
 *   node scripts/smoke-video.ts <video> [--seconds 3] [--offset 2] [--keep]
 *
 * Monta uma composição temporária (vídeo + título), renderiza duas vezes e
 * compara os hashes de frame. Não copia o vídeo para o repositório: cria um
 * hardlink no diretório de trabalho e apaga tudo no fim.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { renderComposition } from "../packages/producer/src/render.ts";
import { assetPath } from "../packages/engine/src/home.ts";

const run = promisify(execFile);
const args = process.argv.slice(2);
const source = args[0];
if (source === undefined || source.startsWith("-")) {
  process.stderr.write("uso: node scripts/smoke-video.ts <video> [--seconds 3] [--offset 2] [--keep]\n");
  process.exit(2);
}

const numeric = (flag: string, fallback: number): number => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback;
};

const ffmpeg = assetPath("ffmpeg", "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const ffprobe = assetPath("ffmpeg", "bin", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
if (!existsSync(ffmpeg)) {
  process.stderr.write("FFmpeg pinado ausente: rode `node scripts/vendor-ffmpeg.ts`\n");
  process.exit(1);
}
if (!existsSync(resolve(source))) {
  process.stderr.write(`arquivo inexistente: ${source}\n`);
  process.exit(1);
}

const windowSeconds = numeric("--seconds", 3);
const offset = numeric("--offset", 0);

const probe = await run(ffprobe, [
  "-v", "error",
  "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate",
  "-show_entries", "format=duration,size",
  "-of", "json",
  resolve(source),
]);
const info = JSON.parse(probe.stdout) as {
  streams: Array<{ codec_type: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string }>;
  format: { duration: string; size: string };
};
const videoStream = info.streams.find((stream) => stream.codec_type === "video");
const hasAudio = info.streams.some((stream) => stream.codec_type === "audio");
if (!videoStream) {
  process.stderr.write("o arquivo não tem trilha de vídeo\n");
  process.exit(1);
}

const sourceDuration = Number(info.format.duration);
const clipSeconds = Math.max(1, Math.min(windowSeconds, sourceDuration - offset));

process.stdout.write(
  `origem  ${basename(source)} · ${videoStream.codec_name} ${videoStream.width}x${videoStream.height} ` +
    `· ${(Number(info.format.size) / 1e6).toFixed(1)} MB · ${sourceDuration.toFixed(2)}s · áudio: ${hasAudio ? "sim" : "não"}\n`,
);

const workspace = await mkdtemp(join(tmpdir(), "ff-real-"));
try {
  const extension = extname(source).toLowerCase();
  const clipName = `clip${extension}`;
  const clipPath = join(workspace, clipName);
  try {
    await link(resolve(source), clipPath);
  } catch {
    await writeFile(clipPath, await readFile(resolve(source)));
  }

  const composition = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #000; }
  #stage { position: relative; width: 1280px; height: 720px; overflow: hidden; }
  video { position: absolute; inset: 0; width: 1280px; height: 720px; object-fit: cover; }
  .kicker { position: absolute; left: 64px; bottom: 96px; color: #fff; font-family: "Inter"; font-size: 22px; letter-spacing: .18em; text-transform: uppercase; }
  .title  { position: absolute; left: 64px; bottom: 48px; color: #fff; font-family: "Poppins"; font-weight: 700; font-size: 56px; }
</style></head><body>
<div id="stage" data-composition-id="validacao" data-root="true" data-width="1280" data-height="720" data-fps="30">
  <video data-clip-id="clip" data-start="0" data-duration="${clipSeconds}" data-offset="${offset}"
         ${hasAudio ? "" : 'data-has-audio="false"'} src="${clipName}"></video>
  <div class="kicker" data-clip-id="kicker" data-start="0.2" data-duration="${Math.max(0.5, clipSeconds - 0.2)}">validação com vídeo real</div>
  <div class="title"  data-clip-id="title"  data-start="0.4" data-duration="${Math.max(0.5, clipSeconds - 0.4)}">FrankFrames</div>
</div></body></html>`;

  const entry = join(workspace, "index.html");
  await writeFile(entry, composition);

  const gpuFlag = args.indexOf("--gpu");
  const gpu = gpuFlag >= 0 ? (args[gpuFlag + 1] as "auto" | "software" | "hardware") : "auto";
  const renderOptions = { entry, ffmpeg, ffprobe, codec: "av1" as const, preset: "draft" as const, workers: 2, gpu };
  const first = await renderComposition({ ...renderOptions, outPath: join(workspace, "a.mp4") });
  const second = await renderComposition({ ...renderOptions, outPath: join(workspace, "b.mp4") });

  const divergent = [...first.hashes.keys()].filter((frame) => first.hashes.get(frame) !== second.hashes.get(frame));
  const output = await stat(first.outPath);
  const outputProbe = await run(ffprobe, [
    "-v", "error", "-show_entries", "stream=codec_name,nb_frames:format=duration", "-of", "default=nw=1", first.outPath,
  ]);

  process.stdout.write(`frames  ${first.frames} · ${first.durationSeconds.toFixed(3)}s · áudio no MP4: ${first.hasAudio ? "sim" : "não"}\n`);
  process.stdout.write(`saída   ${(output.size / 1e6).toFixed(2)} MB\n${outputProbe.stdout.trim().split("\n").map((line) => `        ${line}`).join("\n")}\n`);
  process.stdout.write(`determinismo  ${divergent.length === 0 ? "2 renders idênticos" : `${divergent.length} frame(s) divergentes`}\n`);
  if (divergent.length > 0) {
    const lagged = [...first.hashes.keys()].filter((frame) => first.hashes.get(frame) === second.hashes.get(frame + 1)).length;
    const leaded = [...first.hashes.keys()].filter((frame) => first.hashes.get(frame) === second.hashes.get(frame - 1)).length;
    process.stdout.write(`frames divergentes: ${divergent.slice(0, 12).join(", ")}\n`);
    process.stdout.write(`a[n] == b[n+1] em ${lagged} frame(s); a[n] == b[n-1] em ${leaded} frame(s)\n`);
  }

  const outFlag = args.indexOf("--out");
  if (outFlag >= 0 && args[outFlag + 1] !== undefined) {
    const destination = resolve(args[outFlag + 1]!);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(first.outPath, destination);
    process.stdout.write(`copia   ${destination}\n`);
  }

  const keep = args.includes("--keep");
  if (keep) process.stdout.write(`mantido em ${workspace}\n`);
  else await rm(workspace, { recursive: true, force: true });
  process.exit(divergent.length === 0 ? 0 : 1);
} catch (error) {
  process.stderr.write(`falhou: ${(error as Error).message}\nworkspace: ${workspace}\n`);
  process.exit(1);
}
