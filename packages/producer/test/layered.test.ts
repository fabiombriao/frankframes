// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveChrome } from "@frankframes/engine";
import { tempDir } from "../../../scripts/test-support/temp.ts";
import { resolveFfmpeg } from "../src/ffmpeg.ts";
import { cropForVideo } from "../src/layered-encode.ts";
import { prepare, renderComposition } from "../src/render.ts";

const run = promisify(execFile);

test("câmera por camadas reproduz o recorte fracionário medido no pintor do Chrome", () => {
  const [width, height, x, y] = cropForVideo({
    clipId: "cut", fit: "cover", position: [0.5, 0.5], zoom: 1.04535,
    fx: 0.5, fy: 0.34, filter: "none",
  }, { width: 1080, height: 1920 }, { width: 1080, height: 1920 });
  assert.ok(Math.abs(width - 1034.04260) < 1e-4);
  assert.ok(Math.abs(height - 1836.77136) < 1e-4);
  assert.ok(Math.abs(x - 24 * 1080 / 1128) < 1e-8);
  assert.ok(Math.abs(y - 30 * 1920 / 2007) < 1e-8);
  assert.deepEqual(cropForVideo({
    clipId: "cover", fit: "cover", position: [.75, .5], zoom: 1.25, fx: .25, fy: .75, filter: "none",
  }, { width: 200, height: 100 }, { width: 100, height: 100 }), [80, 80, 69.6, 15.2]);
});

test("render por camadas une os cortes, o vidro e a barra animada sem recapturar o HTML estático", { timeout: 120_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    t.skip("Chrome pinado indisponível");
    return;
  }
  const pair = await resolveFfmpeg();
  try {
    await run(pair.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=s=64x64:d=0.1", "-vf", "libplacebo", "-frames:v", "1", "-f", "null", "-"]);
  } catch {
    t.skip("FFmpeg com libplacebo e dispositivo Vulkan indisponível");
    return;
  }
  const dir = await tempDir(t, "ff-layered-");
  const source = join(dir, "source.mp4");
  const entry = join(dir, "index.html");
  const outPath = join(dir, "video.mp4");
  const checker = "mod(floor(X/4)+floor(Y/4),2)";
  await run(pair.ffmpeg, [
    "-v", "error", "-f", "lavfi", "-i",
    `color=s=96x96:r=12:d=2,geq=lum='47+128*(${checker})+40*gte(T,1)':cb=128:cr=128`,
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=2",
    "-c:v", "mpeg4", "-c:a", "aac", "-y", source,
  ]);
  await writeFile(entry, `<!doctype html><style>
html,body {margin:0}
video {position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:brightness(.9)}
.glass {position:absolute;left:24px;top:24px;width:48px;height:48px;border-radius:6px;backdrop-filter:blur(5px)}
.bar {position:absolute;left:4px;top:4px;width:88px;height:6px;overflow:hidden;border-radius:3px}
.bar i {display:block;height:100%;width:0;background:rgb(17,247,111);animation:fill 1.5s linear forwards}
.container {position:absolute;inset:0;z-index:5;outline:3px none}
.container span {position:absolute;top:84px;left:8px}
@keyframes fill {to {width:100%}}
</style><main data-composition-id="demo" data-width="96" data-height="96" data-fps="12" data-duration="1.5">
<video src="source.mp4" data-clip-id="a" data-start="0" data-duration="0.75" data-camera="aproximar amount=1.08"></video>
<video src="source.mp4" data-clip-id="b" data-start="0.75" data-duration="0.75" data-offset="1"></video>
<div class="glass"></div><div class="bar"><i></i></div><div class="container"><span>Texto</span></div></main>`);
  const prepared = await prepare({ entry, layered: true, ...pair });
  assert.equal(prepared.manifest, undefined);
  assert.deepEqual(prepared.layeredSources?.map(({ timing }) => [timing.clipId, timing.start, timing.offset]), [
    ["a", 0, 0], ["b", 0.75, 1],
  ]);
  const result = await renderComposition({ entry, outPath, ...pair, layered: true, gpu: "software", workers: 1, preset: "draft" });
  assert.equal(result.frames, 18);
  assert.equal(result.hashes.size, 1, "a barra varia sem exigir novos PNGs do restante do HTML");
  const { stdout } = await run(pair.ffmpeg, [
    "-v", "error", "-i", outPath, "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { encoding: "buffer", maxBuffer: 1 << 20 });
  assert.equal(stdout.length, 18 * 96 * 96 * 3);
  const pixel = (frame: number, x: number, y: number): number[] => {
    const index = 3 * (frame * 96 * 96 + y * 96 + x);
    return [...stdout.subarray(index, index + 3)];
  };
  const samples = (frame: number, left: number, top: number): number[] =>
    Array.from({ length: 64 }, (_, i) => pixel(frame, left + i % 8, top + Math.floor(i / 8))[0]!);
  const span = (values: number[]): number => Math.max(...values) - Math.min(...values);
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(span(samples(0, 6, 30)) > 65, "o padrão fora do vidro mantém o contraste");
  assert.ok(span(samples(0, 38, 38)) < 35, "o vidro reduz o contraste no interior da máscara");
  assert.ok(mean(samples(12, 6, 30)) > mean(samples(0, 6, 30)) + 25, "o segundo corte usa o offset da fonte");
  const [r, g, b] = pixel(17, 60, 7);
  assert.ok(g! > 180 && r! < 75 && b! > 60, "o compositor preenche a barra com a cor da página");
});

test("a opção por camadas sem vídeo mantém os frames integrais do produtor", { timeout: 120_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    t.skip("Chrome pinado indisponível");
    return;
  }
  const pair = await resolveFfmpeg();
  try {
    await run(pair.ffmpeg, ["-version"]);
  } catch {
    t.skip("FFmpeg indisponível");
    return;
  }
  const dir = await tempDir(t, "ff-layered-no-video-");
  const entry = join(dir, "index.html");
  await writeFile(entry, '<!doctype html><main data-composition-id="html" data-width="96" data-height="96" data-fps="12" data-duration="0.25">HTML</main>');
  const options = { entry, ...pair, gpu: "software", workers: 1, preset: "draft" } as const;
  const standard = await renderComposition({ ...options, outPath: join(dir, "standard.mp4") });
  const layered = await renderComposition({ ...options, outPath: join(dir, "layered.mp4"), layered: true });
  assert.deepEqual(layered.hashes, standard.hashes);
});

test("o render por camadas usa NVDEC na fonte aprovada quando NVENC está ativo", { timeout: 120_000 }, async (t) => {
  const pair = await resolveFfmpeg();
  try {
    await resolveChrome();
    await run(pair.ffmpeg, [
      "-v", "error", "-f", "lavfi", "-i", "color=s=256x256:d=0.25",
      "-vf", "libplacebo", "-frames:v", "1", "-c:v", "av1_nvenc", "-f", "null", "-",
    ]);
  } catch {
    t.skip("Chrome, Vulkan ou AV1 NVENC indisponível");
    return;
  }
  const dir = await tempDir(t, "ff-layered-nvdec-");
  const input = join(dir, "input.mp4");
  try {
    await run(pair.ffmpeg, [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=256x256:r=12:d=0.25",
      "-c:v", "libopenh264", "-y", input,
    ]);
  } catch {
    t.skip("fixture H.264 indisponível no FFmpeg local");
    return;
  }
  try {
    const { stderr } = await run(pair.ffmpeg, [
      "-v", "debug", "-hwaccel", "cuda", "-hwaccel_output_format", "nv12",
      "-i", input, "-frames:v", "1", "-f", "null", "-",
    ]);
    if (!stderr.includes("Format cuda chosen by get_format()")) {
      t.skip("NVDEC H.264 indisponível");
      return;
    }
  } catch {
    t.skip("NVDEC H.264 indisponível");
    return;
  }
  const entry = join(dir, "index.html");
  await writeFile(entry, `<!doctype html><style>html,body{margin:0}
    video{position:absolute;inset:0;width:100vw;height:100vh;object-fit:fill;object-position:50% 50%}</style>
    <main data-composition-id="nvdec" data-width="256" data-height="256" data-fps="12" data-duration="0.25">
    <video src="input.mp4" data-duration="0.25" data-has-audio="false"></video></main>`);
  const progress: string[] = [];
  const result = await renderComposition({
    entry, outPath: join(dir, "output.mp4"), ...pair, layered: true, gpu: "hardware", workers: 1, preset: "draft",
    onProgress: (stage, _percent, message) => { if (stage === "encode" && message !== undefined) progress.push(message); },
  });
  assert.equal(result.frames, 3);
  assert.ok(progress.includes("NVDEC em 1 fonte(s)"));
  assert.equal(result.warnings.some((warning) => warning.includes("NVDEC")), false);
});
