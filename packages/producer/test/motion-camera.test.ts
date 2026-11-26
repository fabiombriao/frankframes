// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-53: câmera (zoom/foco) em <img> e <video>, com Chrome e FFmpeg reais. Spec: docs/contract.md §7b.9.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { openSessionFor, resolveChrome, startServer } from "@frankframes/engine";
import type { Session } from "@frankframes/engine";
import { compileComposition } from "../src/compile.ts";
import { resolveFfmpeg } from "../src/ffmpeg.ts";
import type { FfmpegPair } from "../src/ffmpeg.ts";
import { prepare } from "../src/render.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const run = promisify(execFile);
const FPS = { num: 30, den: 1 };

async function environmentOrSkip(t: TestContext): Promise<FfmpegPair | undefined> {
  try {
    await resolveChrome();
  } catch {
    t.skip("Chrome não encontrado");
    return undefined;
  }
  const pair = await resolveFfmpeg();
  try {
    await run(pair.ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
  } catch {
    t.skip("ffmpeg não encontrado");
    return undefined;
  }
  return pair;
}

/** Centroide X (px) dos pixels vermelhos do screenshot; decodifica o PNG com o próprio FFmpeg. */
async function redCentroid(ffmpeg: string, dir: string, png: Buffer, width: number): Promise<{ x: number; count: number }> {
  const file = join(dir, "shot.png");
  await writeFile(file, png);
  const { stdout } = await run(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  let sum = 0;
  let count = 0;
  for (let i = 0; i < stdout.length; i += 3) {
    if (stdout[i]! > 200 && stdout[i + 1]! < 60) {
      sum += (i / 3) % width;
      count++;
    }
  }
  return { x: count === 0 ? NaN : sum / count, count };
}

test("câmera em <img>: panorâmica move o quadro sem degraus e o seek é determinístico", { timeout: 600_000 }, async (t) => {
  const pair = await environmentOrSkip(t);
  if (pair === undefined) return;

  const dir = await tempDir(t, "ff-camera-img-");
  // Foto 4K cinza com um quadrado vermelho no centro: o centroide dele revela o deslocamento da câmera.
  await run(pair.ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0x202020:s=3840x2160,drawbox=x=1880:y=1000:w=80:h=80:color=red:t=fill",
    "-frames:v", "1", "-y", join(dir, "foto.png"),
  ]);

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style></head><body>
<div data-composition-id="main" data-root="true" data-width="1920" data-height="1080" data-fps="30" data-duration="2">
<img id="p" src="foto.png" data-clip-id="p" data-start="0" data-duration="2" data-camera="panoramica-direita"
     style="position:fixed;left:0;top:0;width:1920px;height:1080px;object-fit:cover">
</div></body></html>`;
  const compiled = await compileComposition({ entryHtml: html, entryDir: dir });
  assert.equal(compiled.composition.ok, true, JSON.stringify(compiled.composition.diagnostics));
  assert.ok(compiled.html.includes("--ff-fx"), "o compilador precisa anotar a câmera");

  const server = await startServer(dir, { page: { path: "index.html", html: compiled.html } });
  const session = await openSessionFor(server, { url: `${server.url}index.html`, viewport: { width: 1920, height: 1080 }, gpu: "auto" });
  try {
    const frames = [...Array(30).keys()];
    const hashes = new Map<number, string>();
    const xs: number[] = [];
    for (const frame of frames) {
      await session.seekFrame(frame, FPS);
      const shot = await session.capture();
      hashes.set(frame, shot.sha256);
      const { x, count } = await redCentroid(pair.ffmpeg, dir, shot.png, 1920);
      assert.ok(count > 500, `frame ${frame}: o quadrado vermelho sumiu (${count} px)`);
      xs.push(x);
    }

    // Panorâmica para a direita: a câmera vai para a direita, então o conteúdo anda para a esquerda.
    for (let i = 1; i < xs.length; i++) {
      assert.ok(xs[i]! < xs[i - 1]!, `x deveria diminuir a cada frame: frame ${i} ${xs[i]!.toFixed(2)} >= ${xs[i - 1]!.toFixed(2)}`);
    }
    // Movimento linear: a segunda diferença é ruído de sub-pixel, não degrau.
    for (let i = 2; i < xs.length; i++) {
      const second = xs[i]! - 2 * xs[i - 1]! + xs[i - 2]!;
      assert.ok(Math.abs(second) <= 1.0, `degrau no frame ${i}: Δ²x = ${second.toFixed(3)} px`);
    }

    // Seek em ordem, repetido e invertido dá os mesmos pixels.
    for (const order of [frames, frames, [...frames].reverse()]) {
      for (const frame of order) {
        await session.seekFrame(frame, FPS);
        assert.equal((await session.capture()).sha256, hashes.get(frame), `frame ${frame} mudou com a ordem do seek`);
      }
    }
    assert.deepEqual(session.pageErrors(), []);
  } finally {
    await session.close();
    await server.close();
  }
});

interface VideoProbe {
  videoHidden: boolean;
  images: number;
  motionOnImg: number;
  motionOnVideo: number;
  decodedFrames: number;
  fit: string;
  viewBox: string;
}

async function probeVideo(session: Session): Promise<VideoProbe> {
  return session.evaluate<VideoProbe>(`(() => {
    const video = document.querySelector("video");
    const img = document.querySelector("img[data-ff-media]");
    const motion = document.getAnimations().filter((a) => a.id === "ff-motion");
    return {
      videoHidden: video.style.display === "none",
      images: document.querySelectorAll("img[data-ff-media]").length,
      motionOnImg: motion.filter((a) => a.effect.target.tagName === "IMG").length,
      motionOnVideo: motion.filter((a) => a.effect.target.tagName === "VIDEO").length,
      decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames,
      fit: getComputedStyle(img).objectFit,
      viewBox: getComputedStyle(img).objectViewBox,
    };
  })()`);
}

/** Prepara e abre uma composição 640x360 com um <video> de 2 s e os atributos dados. */
async function openVideoComposition(t: TestContext, pair: FfmpegPair, videoAttrs: string, style = "") {
  const dir = await tempDir(t, "ff-camera-video-");
  await run(pair.ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
    "-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p", "-y", join(dir, "clip.mp4"),
  ]);
  const entry = join(dir, "index.html");
  await writeFile(
    entry,
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style></head><body>
<div data-composition-id="main" data-root="true" data-width="640" data-height="360" data-fps="30" data-duration="2">
<video id="v" data-clip-id="v" data-start="0" data-duration="2" src="clip.mp4" ${videoAttrs}
       style="position:fixed;left:0;top:0;width:640px;height:360px;${style}"></video>
</div></body></html>`,
  );
  const prepared = await prepare({ entry, ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe });
  assert.ok(prepared.manifest, "o vídeo precisa gerar manifesto");
  assert.ok(prepared.compiledHtml.includes("data-ff-motion"), "o compilador precisa anotar o motion no <video>");
  const server = await startServer(prepared.entryDir, {
    mediaRoot: prepared.mediaDir!,
    manifest: prepared.manifest,
    page: { path: "index.html", html: prepared.compiledHtml },
  });
  const session = await openSessionFor(server, { url: `${server.url}index.html`, viewport: { width: 640, height: 360 }, gpu: "auto" });
  return { session, server };
}

test("câmera em <video>: o movimento vai para a <img> do shim e o Chrome não decodifica o vídeo", { timeout: 600_000 }, async (t) => {
  const pair = await environmentOrSkip(t);
  if (pair === undefined) return;

  const { session, server } = await openVideoComposition(t, pair, 'data-camera="aproximar"');
  try {
    await session.seekFrame(0, FPS);
    const first = await probeVideo(session);
    assert.equal(first.videoHidden, true, "o <video> precisa estar oculto após o primeiro seek");
    assert.equal(first.images, 1, "o <video> precisa ter sido substituído por uma <img>");
    assert.ok(first.motionOnImg >= 1, "a câmera precisa animar a <img> substituta");
    assert.equal(first.motionOnVideo, 0, "o <video> nunca é animado");
    assert.equal(first.decodedFrames, 0, "o Chrome não pode decodificar o vídeo");

    const hashes = new Set<string>();
    for (let frame = 0; frame < 60; frame += 3) {
      await session.seekFrame(frame, FPS);
      hashes.add((await session.capture()).sha256);
    }
    assert.ok(hashes.size >= 15, `os frames precisam ser distintos (${hashes.size})`);

    await session.seekFrame(59, FPS);
    const last = await probeVideo(session);
    assert.notEqual(last.viewBox, first.viewBox, "o recorte da câmera precisa mudar entre o início e o fim");
    assert.equal(last.decodedFrames, 0, "o Chrome não pode decodificar o vídeo");
    assert.deepEqual(session.pageErrors(), []);
  } finally {
    await session.close();
    await server.close();
  }
});

test("câmera em <video>: a <img> herda object-fit do vídeo", { timeout: 600_000 }, async (t) => {
  const pair = await environmentOrSkip(t);
  if (pair === undefined) return;

  const { session, server } = await openVideoComposition(t, pair, 'data-camera="aproximar"', "object-fit:cover;");
  try {
    await session.seekFrame(0, FPS);
    assert.equal((await probeVideo(session)).fit, "cover");
  } finally {
    await session.close();
    await server.close();
  }
});

test("motion de entrada num <video> também chega à <img> (EDT-53)", { timeout: 600_000 }, async (t) => {
  const pair = await environmentOrSkip(t);
  if (pair === undefined) return;

  const { session, server } = await openVideoComposition(t, pair, 'data-enter="surgir dur=1"');
  try {
    await session.seekFrame(0, FPS);
    const opacity = (): Promise<number> => session.evaluate<number>('Number(getComputedStyle(document.querySelector("img[data-ff-media]")).opacity)');
    assert.equal(await opacity(), 0, "início da entrada");
    await session.seekFrame(45, FPS);
    assert.equal(await opacity(), 1, "entrada concluída");
    assert.equal((await probeVideo(session)).motionOnVideo, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test("EDT-100: filtro CSS por classe e por tipo convive com data-camera no <video>", { timeout: 600_000 }, async (t) => {
  const pair = await environmentOrSkip(t);
  if (pair === undefined) return;

  const dir = await tempDir(t, "ff-camera-filter-");
  await run(pair.ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
    "-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p", "-y", join(dir, "clip.mp4"),
  ]);
  const entry = join(dir, "index.html");
  await writeFile(
    entry,
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;background:#000}
      video{opacity:0.9}
      .fill{position:fixed;left:0;top:0;width:640px;height:360px;object-fit:cover;filter:contrast(1.08) saturate(0.88) brightness(0.92)}
    </style></head><body>
    <div data-composition-id="main" data-root="true" data-width="640" data-height="360" data-fps="30" data-duration="2">
      <video id="v" class="fill" data-clip-id="v" data-start="0" data-duration="2" src="clip.mp4" data-camera="aproximar"></video>
    </div></body></html>`,
  );
  const prepared = await prepare({ entry, ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe });
  const server = await startServer(prepared.entryDir, {
    mediaRoot: prepared.mediaDir!,
    manifest: prepared.manifest!,
    page: { path: "index.html", html: prepared.compiledHtml },
  });
  const session = await openSessionFor(server, { url: `${server.url}index.html`, viewport: { width: 640, height: 360 }, gpu: "software" });
  try {
    await session.seekFrame(0, FPS);
    const first = await session.evaluate<{ filter: string; opacity: string; fit: string; viewBox: string }>(`(() => {
      const s = getComputedStyle(document.querySelector("img[data-ff-media]"));
      return { filter: s.filter, opacity: s.opacity, fit: s.objectFit, viewBox: s.objectViewBox };
    })()`);
    assert.equal(first.filter, "contrast(1.08) saturate(0.88) brightness(0.92)");
    assert.equal(first.opacity, "0.9");
    assert.equal(first.fit, "cover");
    await session.seekFrame(59, FPS);
    const lastViewBox = await session.evaluate<string>(`getComputedStyle(document.querySelector("img[data-ff-media]")).objectViewBox`);
    assert.notEqual(lastViewBox, first.viewBox, "a câmera continua animando a <img> com filtro herdado");
  } finally {
    await session.close();
    await server.close();
  }
});
