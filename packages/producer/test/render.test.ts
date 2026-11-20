// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderComposition } from "../src/render.ts";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run(FFMPEG, ["-hide_banner", "-version"], { timeout: 15_000 });
    await run(FFPROBE, ["-hide_banner", "-version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const COMPOSITION = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#0b0b0f;color:#fff}
  #stage{position:relative;width:640px;height:360px;font-family:"FF Inter"}
  .title{position:absolute;left:40px;top:60px;font-size:44px;font-weight:700}
  .bar{position:absolute;left:40px;top:150px;height:10px;background:#ff2d55;animation:grow 1.5s linear forwards}
  @keyframes grow{from{width:0}to{width:560px}}
  .mono{position:absolute;left:40px;top:200px;font-family:"FF Mono";font-size:20px}
</style></head><body>
<div id="stage" data-composition-id="e2e" data-root="true" data-width="640" data-height="360" data-fps="30">
  <div class="title">FrankFrames</div>
  <div class="bar"></div>
  <div class="mono">render ponta a ponta</div>
  <audio data-clip-id="beep" data-start="0" data-duration="1.5" data-volume="0.4" src="beep.wav"></audio>
</div></body></html>`;

test("render ponta a ponta: HTML -> MP4 com áudio, 45 frames, dois renders idênticos", { timeout: 900_000 }, async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg/ffprobe não encontrados");

  const workspace = await mkdtemp(join(tmpdir(), "ff-e2e-"));
  const entry = join(workspace, "index.html");
  await writeFile(entry, COMPOSITION);
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-ac", "2", "-y", join(workspace, "beep.wav"),
  ]);

  const first = await renderComposition({
    entry,
    outPath: join(workspace, "a.mp4"),
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    codec: "av1",
    preset: "draft",
    workers: 2,
  });

  assert.equal(first.frames, 45, `1,5 s a 30 fps = 45 frames, obtido ${first.frames}`);
  assert.equal(first.hasAudio, true, "o áudio da composição precisa entrar no MP4");
  assert.equal(first.hashes.size, 45);
  const info = await stat(first.outPath);
  assert.ok(info.size > 5_000, `MP4 pequeno demais: ${info.size} bytes`);

  const probe = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "stream=codec_name,nb_frames,channels:format=duration",
    "-of", "default=nw=1",
    first.outPath,
  ]);
  assert.match(probe.stdout, /codec_name=av1/);
  assert.match(probe.stdout, /nb_frames=45/);
  assert.match(probe.stdout, /channels=2/);
  const duration = Number(/duration=([\d.]+)/.exec(probe.stdout)?.[1]);
  assert.ok(duration > 1.45 && duration < 1.55, `duração inesperada: ${duration}`);

  const second = await renderComposition({
    entry,
    outPath: join(workspace, "b.mp4"),
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    codec: "av1",
    preset: "draft",
    workers: 3,
  });
  const divergent = [...first.hashes.keys()].filter((frame) => first.hashes.get(frame) !== second.hashes.get(frame));
  assert.deepEqual(divergent.slice(0, 10), [], "dois renders do mesmo HTML produziram frames diferentes");

  await stat(join(workspace, "b.mp4"));
  assert.ok((await readFile(entry, "utf8")).length > 0);
});
