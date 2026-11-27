// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractFrames, openSession, openSessionFor, resolveChrome, startServer } from "../src/index.ts";
import type { MediaManifest } from "../src/media.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FPS = { num: 30, den: 1 };
const FRAMES = 30;

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run(FFMPEG, ["-hide_banner", "-version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const COMPOSITION = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#101014}
  #stage{position:relative;width:640px;height:360px}
  #v{position:fixed;left:0;top:0;width:320px;height:180px}
</style></head>
<body><div id="stage" data-composition-id="media" data-root="true" data-width="640" data-height="360" data-fps="30">
  <video id="v" data-clip-id="v" data-start="0" data-duration="2" src="clip.mp4"></video>
  <div style="position:fixed;left:340px;top:20px;color:#fff;font:20px monospace">vídeo fora de banda</div>
</div></body></html>`;

test("vídeo fora de banda: <video> vira <img> e o frame é estável", { timeout: 900_000 }, async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg não encontrado");
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  const workspace = await tempDir(t, "ff-media-");
  const video = join(workspace, "clip.mp4");
  // mpeg4 embutido: nada de libx264 nem no fixture.
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
    "-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p", "-y", video,
  ]);

  const mediaDir = join(workspace, "media");
  const { frameCount } = await extractFrames({
    ffmpeg: FFMPEG,
    input: video,
    outDir: join(mediaDir, "v"),
    fps: FPS,
  });
  assert.ok(frameCount >= 58, `extração devolveu ${frameCount} frames, esperado ~60`);

  const manifest: MediaManifest = {
    fps: FPS,
    clips: [{ clipId: "v", start: 0, duration: 2, offset: 0, playbackRate: 1, dir: "v", frameCount }],
  };
  await writeFile(join(workspace, "index.html"), COMPOSITION);

  const captureRun = async (order: number[]): Promise<Map<number, string>> => {
    const server = await startServer(workspace, { mediaRoot: mediaDir, manifest });
    const session = await openSessionFor(server, { url: server.url, viewport: { width: 640, height: 360 }, gpu: "auto" });
    const hashes = new Map<number, string>();
    try {
      for (const frame of order) {
        await session.seekFrame(frame, FPS);
        const clock = await session.evaluate<number>("window.__ff.now()");
        assert.ok(Math.abs(clock - (frame * 1000) / 30) < 1e-3, `clock em ${clock} ms no frame ${frame}: seek precisa ser em ms`);
        hashes.set(frame, (await session.capture()).sha256);
      }
      const dom = await session.evaluate<{ images: number; videoHidden: boolean }>(`(() => {
        const video = document.querySelector("video");
        return {
          images: document.querySelectorAll("img[data-ff-media]").length,
          videoHidden: video ? video.style.display === "none" : false,
        };
      })()`);
      assert.equal(dom.images, 1, "o <video> precisa ter sido substituído por um <img>");
      assert.equal(dom.videoHidden, true, "o <video> original precisa estar oculto");
      assert.deepEqual(session.pageErrors(), [], "erros na página durante a captura");
    } finally {
      await session.close();
      await server.close();
    }
    return hashes;
  };

  const order = [...Array(FRAMES).keys()];
  const first = await captureRun(order);
  const second = await captureRun(order);
  const reversed = await captureRun([...order].reverse());

  const divergent = order.filter((f) => first.get(f) !== second.get(f) || first.get(f) !== reversed.get(f));
  assert.deepEqual(divergent.slice(0, 10), [], "frames divergentes entre execuções");
  assert.ok(new Set(first.values()).size > 20, "o vídeo precisa mudar de frame, senão o teste não prova nada");
  await mkdir(join(workspace, "done"), { recursive: true });
});

test("extração com início entre quadros preserva a sequência sem duplicar o primeiro JPEG", async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg não encontrado");
  const workspace = await tempDir(t, "ff-media-fractional-");
  const input = join(workspace, "clip.mp4");
  await run(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=30:d=0.6",
    "-c:v", "mpeg4", "-y", input]);
  const reference = join(workspace, "reference");
  const cut = join(workspace, "cut");
  await extractFrames({ ffmpeg: FFMPEG, input, outDir: reference, fps: FPS });
  await extractFrames({ ffmpeg: FFMPEG, input, outDir: cut, fps: FPS, offset: 0.25, duration: 0.2 });
  assert.deepEqual(await readFile(join(cut, "000000.jpg")), await readFile(join(reference, "000008.jpg")));
  assert.deepEqual(await readFile(join(cut, "000001.jpg")), await readFile(join(reference, "000009.jpg")));
});

test("imagem substituta respeita a janela do clip", { timeout: 300_000 }, async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg não encontrado");
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  const workspace = await tempDir(t, "ff-media-window-");
  const video = join(workspace, "clip.mp4");
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
    "-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p", "-y", video,
  ]);
  const mediaDir = join(workspace, "media");
  const { frameCount } = await extractFrames({ ffmpeg: FFMPEG, input: video, outDir: join(mediaDir, "v"), fps: FPS });

  const manifest: MediaManifest = {
    fps: FPS,
    clips: [{ clipId: "v", start: 1, duration: 1, offset: 0, playbackRate: 1, dir: "v", frameCount }],
  };
  await writeFile(
    join(workspace, "index.html"),
    `<html><body><div data-composition-id="w" data-duration="2">
      <video data-clip-id="v" data-start="1" data-duration="1" data-ff-start="1000" data-ff-end="2000"
             src="clip.mp4" style="position:fixed;left:0;top:0;width:320px;height:180px"></video>
    </div></body></html>`,
  );

  const server = await startServer(workspace, { mediaRoot: mediaDir, manifest });
  const session = await openSessionFor(server, { url: server.url, viewport: { width: 640, height: 360 }, gpu: "auto" });
  try {
    const visibility = () => session.evaluate<string>(`getComputedStyle(document.querySelector("img[data-ff-media]")).visibility`);

    await session.seekFrame(0, FPS);
    assert.equal(await visibility(), "hidden", "antes do início a imagem não pode aparecer");

    await session.seekFrame(45, FPS);
    assert.equal(await visibility(), "visible", "dentro da janela precisa aparecer");

    await session.seekFrame(80, FPS);
    assert.equal(await visibility(), "hidden", "depois do fim a imagem precisa sumir");
  } finally {
    await session.close();
    await server.close();
  }
});

test("EDT-100: imagem substituta herda filtro CSS, opacidade, borda, clip-path, z-index e transform por classe e por tipo", { timeout: 300_000 }, async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg não encontrado");
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  const workspace = await tempDir(t, "ff-media-style-");
  const video = join(workspace, "clip.mp4");
  // Quadro azul sólido 64x64: com filter: invert(1) vira amarelo (#ffff00).
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=blue:s=64x64:rate=10:duration=1",
    "-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p", "-y", video,
  ]);
  const mediaDir = join(workspace, "media");
  const { frameCount } = await extractFrames({ ffmpeg: FFMPEG, input: video, outDir: join(mediaDir, "v"), fps: { num: 10, den: 1 } });

  const manifest: MediaManifest = {
    fps: { num: 10, den: 1 },
    clips: [
      { clipId: "v-class", start: 0, duration: 1, offset: 0, playbackRate: 1, dir: "v", frameCount },
      { clipId: "v-type", start: 0, duration: 1, offset: 0, playbackRate: 1, dir: "v", frameCount },
    ],
  };
  await writeFile(
    join(workspace, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;background:#000}
      video{filter:contrast(1.5) brightness(0.8);border-radius:10px}
      .fx{position:fixed;left:0;top:0;width:80px;height:80px;object-fit:fill;filter:invert(1);opacity:0.8;clip-path:inset(0px);mix-blend-mode:normal;z-index:5}
      #v2{position:fixed;left:100px;top:0;width:80px;height:80px;object-fit:fill;transform:scaleX(-1)}
      #cover{position:fixed;left:0;top:0;width:80px;height:80px;background:#00ff00;z-index:2}
    </style></head><body>
    <div data-composition-id="s" data-width="200" data-height="100" data-fps="10" data-duration="1">
      <div id="cover"></div>
      <video class="fx" data-clip-id="v-class" data-start="0" data-duration="1" data-ff-start="0" data-ff-end="1000" src="clip.mp4"></video>
      <video id="v2" data-clip-id="v-type" data-start="0" data-duration="1" data-ff-start="0" data-ff-end="1000" src="clip.mp4"></video>
    </div></body></html>`,
  );

  const server = await startServer(workspace, { mediaRoot: mediaDir, manifest });
  const session = await openSessionFor(server, { url: server.url, viewport: { width: 200, height: 100 }, gpu: "software" });
  try {
    await session.seekFrame(0, { num: 10, den: 1 });
    const styles = await session.evaluate<{
      byClass: { filter: string; opacity: string; radius: string; zIndex: string };
      byType: { filter: string; radius: string; transform: string; width: number; height: number };
    }>(`(() => {
      const a = getComputedStyle(document.querySelector('img[data-ff-media="v-class"]'));
      const bEl = document.querySelector('img[data-ff-media="v-type"]');
      const b = getComputedStyle(bEl);
      const rect = bEl.getBoundingClientRect();
      return {
        byClass: { filter: a.filter, opacity: a.opacity, radius: a.borderTopLeftRadius, zIndex: a.zIndex },
        byType: { filter: b.filter, radius: b.borderTopLeftRadius, transform: b.transform, width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    })()`);
    assert.equal(styles.byClass.filter, "invert(1)", "regra por classe (.fx) precisa chegar à <img>");
    assert.equal(styles.byClass.opacity, "0.8", "opacity da classe precisa chegar à <img>");
    assert.equal(styles.byClass.radius, "10px", "border-radius da regra video precisa chegar à <img>");
    assert.equal(styles.byClass.zIndex, "5", "z-index precisa manter o vídeo acima de #cover (z-index:2)");
    assert.equal(styles.byType.filter, "contrast(1.5) brightness(0.8)", "regra por tipo video {} precisa chegar à <img>");
    assert.equal(styles.byType.radius, "10px");
    assert.equal(styles.byType.transform, "matrix(-1, 0, 0, 1, 0, 0)", "transform precisa chegar à <img>");
    assert.deepEqual([styles.byType.width, styles.byType.height], [80, 80]);

    const png = join(workspace, "frame.png");
    await writeFile(png, (await session.capture()).png);
    const { stdout } = await run(
      FFMPEG,
      ["-hide_banner", "-loglevel", "error", "-i", png, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { encoding: "buffer", maxBuffer: 8 << 20 },
    );
    // Pixel (40, 40) dentro do primeiro vídeo: azul (#0000ff) invertido sobre #00ff00 com opacity 0.8 dá R > 180, G > 180, B < 60.
    const idx = (40 * 200 + 40) * 3;
    const [r, g, b] = [stdout[idx]!, stdout[idx + 1]!, stdout[idx + 2]!];
    assert.ok(r > 180 && g > 180 && b < 60, `pixel esperado amarelo (invertido), obtido rgb(${r},${g},${b})`);
  } finally {
    await session.close();
    await server.close();
  }
});
