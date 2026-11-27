// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveChrome } from "@frankframes/engine";
import { tempDir } from "../../../scripts/test-support/temp.ts";
import { resolveFfmpeg } from "../src/ffmpeg.ts";
import { cropForVideo, writeCefRenderPlan } from "../src/layered-encode.ts";
import { cefStatistics } from "../src/cef-render.ts";
import { prepare, renderComposition } from "../src/render.ts";

const run = promisify(execFile);

test("CEF usa texturas no grafo Vulkan e passa as dimensões da barra ao shader", async (t) => {
  const directory = await tempDir(t, "ff-cef-plan-");
  const video = { clipId: "source", fit: "cover" as const, position: [.5, .5] as [number, number],
    zoom: 1, fx: .5, fy: .5, filter: "none" };
  const progress = { x: 8, y: 8, width: 240, height: 4, radius: 2, fill: 40, rgba: [255, 106, 61, 255] as const };
  const fps = { num: 12, den: 1 };
  const viewport = { width: 256, height: 256 };
  await writeCefRenderPlan({
    capture: { frames: [{ video, glass: [], progress: { ...progress, rgba: [...progress.rgba] } }],
      hashes: new Map(), rgbFrames: new Set(), background: true },
    sources: [{ input: join(directory, "source.mp4"), timing: { clipId: "source", start: 0, offset: 0,
      playbackRate: 1, duration: 1, orientation: { rotation: 0, mirrored: false, displayWidth: 256, displayHeight: 256 } } }],
    viewport, fps, directory, outPath: join(directory, "video.mp4"), codec: "av1", preset: "high", warnings: [],
  });
  const plan = await readFile(join(directory, "cef.plan"), "utf8");
  assert.match(plan, /\[cefv0\]fps=/);
  assert.match(plan, /\[cefbackground\]libplacebo/);
  assert.match(plan, /\[cefhtml\]libplacebo/);
  assert.match(plan, /custom_shader_path=progress\.hook/);
  assert.doesNotMatch(plan, /hwupload|hwdownload|ffconcat|\.png|rawvideo/);
  assert.deepEqual((await readdir(directory)).sort(), ["cef.plan", "layers.filter", "progress.hook"]);
});

test("CEF exige a contagem integral e nenhum callback em software", () => {
  const output = "MP4 Vulkan frames=12\nframes=12 texturas=3 software=0 segundos=1.250\n";
  assert.deepEqual(cefStatistics(output, 12), { frames: 12, textures: 3, software: 0, seconds: 1.25 });
  assert.throws(() => cefStatistics(output, 13), /MP4 integral/);
  assert.throws(() => cefStatistics(output.replace("software=0", "software=1"), 12), /MP4 integral/);
  assert.throws(() => cefStatistics(output.split("\n")[1]!, 12), /MP4 integral/);
});

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

test("camadas alternam entre PNG transparente e opaco sem reiniciar a linha do tempo", { timeout: 120_000 }, async (t) => {
  const pair = await resolveFfmpeg();
  try {
    await resolveChrome();
    await run(pair.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=s=96x96", "-vf", "libplacebo",
      "-frames:v", "1", "-f", "null", "-"]);
  } catch {
    t.skip("Chrome ou libplacebo indisponível");
    return;
  }
  const dir = await tempDir(t, "ff-layered-alpha-");
  const source = join(dir, "source.mp4");
  const entry = join(dir, "index.html");
  const outPath = join(dir, "output.mp4");
  await run(pair.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=96x96:r=12:d=1",
    "-c:v", "mpeg4", "-y", source]);
  await writeFile(entry, `<!doctype html><style>
html,body{margin:0}
video,.flash{position:absolute;inset:0;width:100%;height:100%}
video{object-fit:cover}
.flash{background:red}
.corner{position:absolute;top:0;left:0;width:32px;height:32px;background:lime}
</style><main data-composition-id="flash" data-width="96" data-height="96" data-fps="12" data-duration="1">
<video src="source.mp4" data-duration="1" data-has-audio="false"></video>
<div class="flash" data-start="0.25" data-duration="0.25" data-track="1"></div>
<div class="corner" data-start="0.5" data-duration="0.5" data-track="1"></div>
</main>`);
  await renderComposition({ entry, outPath, ...pair, layered: true, gpu: "software", workers: 1, preset: "high" });
  const { stdout } = await run(pair.ffmpeg, ["-v", "error", "-xerror", "-i", outPath,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 1 << 20 });
  assert.equal(stdout.length, 12 * 96 * 96 * 3);
  const pixel = (frame: number, x: number, y: number): number[] => {
    const at = 3 * (frame * 96 * 96 + y * 96 + x);
    return [...stdout.subarray(at, at + 3)];
  };
  for (let frame = 0; frame < 12; frame += 1) {
    const [red, , blue] = pixel(frame, 60, 60);
    if (frame >= 3 && frame < 6) assert.ok(red! > blue! + 100, `flash opaco no frame ${frame}`);
    else assert.ok(blue! > red! + 100, `vídeo visível no frame ${frame}`);
    if (frame >= 6) {
      const [r, g, b] = pixel(frame, 16, 16);
      assert.ok(g! > Math.max(r!, b!) + 100, `camada seguinte no frame ${frame}`);
    }
  }
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

test("VRAM aplica a máscara de vidro no frame certo e compõe a barra em AV1 Vulkan", { timeout: 120_000 }, async (t) => {
  const pair = await resolveFfmpeg();
  const dir = await tempDir(t, "ff-layered-vram-");
  const input = join(dir, "source.mp4");
  try {
    await resolveChrome();
    await run(pair.ffmpeg, [
      "-v", "error", "-f", "lavfi", "-i", "color=s=256x256:r=12:d=1.2,geq=lum='36+176*mod(floor(X/4)+floor(Y/4),2)':cb=128:cr=128",
      "-c:v", "libopenh264", "-y", input,
    ]);
    await run(pair.ffmpeg, [
      "-v", "error", "-init_hw_device", "vulkan=vk:NVIDIA", "-filter_hw_device", "vk",
      "-hwaccel", "vulkan", "-hwaccel_device", "vk", "-hwaccel_output_format", "vulkan", "-i", input,
      "-vf", "scale_vulkan=format=nv12", "-frames:v", "1", "-c:v", "av1_vulkan", "-f", "null", "-",
    ]);
  } catch {
    t.skip("Chrome ou Vulkan Video NVIDIA indisponível");
    return;
  }
  const entry = join(dir, "index.html");
  const outPath = join(dir, "output.mp4");
  await writeFile(entry, `<!doctype html><style>
html,body{margin:0}
video{position:absolute;inset:0;width:100vw;height:100vh;object-fit:cover;filter:contrast(1.1)}
.bg{position:absolute;inset:0;background:linear-gradient(transparent,#00204050)}
.glass{position:absolute;left:48px;top:80px;width:160px;height:104px;border-radius:16px;backdrop-filter:blur(10px)}
.flash{position:absolute;inset:0;background:red}
.bar{position:absolute;left:8px;top:8px;width:240px;height:4px;overflow:hidden;border-radius:2px}
.bar i{display:block;height:100%;width:0;background:#ff6a3d;animation:fill 1s linear forwards}
@keyframes fill{to{width:100%}}
</style><main data-composition-id="vram" data-width="256" data-height="256" data-fps="12" data-duration="1">
<video src="source.mp4" data-duration="1" data-has-audio="false"></video>
<div class="bg"></div><div class="glass" data-start="0.5" data-duration="0.5"></div>
<div class="flash" data-start="0.25" data-duration="0.25"></div><div class="bar"><i></i></div>
</main>`);
  const progress: string[] = [];
  const result = await renderComposition({
    entry, outPath, ...pair, vram: true, gpu: "hardware", workers: 1, preset: "high",
    onProgress: (_stage, _percent, message) => { if (message !== undefined) progress.push(message); },
  });
  assert.equal(result.frames, 12);
  assert.ok(progress.includes("Vulkan em VRAM da decodificação ao encode"));
  const { stdout } = await run(pair.ffmpeg, [
    "-v", "error", "-i", outPath, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { encoding: "buffer", maxBuffer: 3 << 20 });
  const at = (f: number, x: number, y: number): number => 3 * (f * 256 * 256 + y * 256 + x);
  const range = (frame: number): number => {
    const values = Array.from({ length: 12 }, (_, i) => stdout[at(frame, 113 + i, 125)]!);
    return Math.max(...values) - Math.min(...values);
  };
  assert.ok(range(2) > 80, "o vidro ainda está invisível no frame 2");
  const flash = at(4, 130, 125);
  assert.ok(stdout[flash]! > stdout[flash + 2]! + 100, "o quadro opaco aparece em VRAM");
  assert.ok(range(7) < 30, "o vidro borra o fundo depois de entrar");
  const fill = at(10, 130, 9);
  assert.ok(stdout[fill]! > stdout[fill + 1]! + 65, "a barra laranja chegou ao meio");
  const redAverage = (y: number): number => {
    const values = Array.from({ length: 16 }, (_, x) => stdout[at(11, 96 + x, y)]!);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  assert.ok(redAverage(40) - redAverage(240) > 15, "o gradiente escurece a base até o último frame");
});
