// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractFrames, openSession, resolveChrome, startServer } from "../src/index.ts";
import type { MediaManifest } from "../src/media.ts";

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

  const workspace = await mkdtemp(join(tmpdir(), "ff-media-"));
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
    const session = await openSession({ url: server.url, viewport: { width: 640, height: 360 }, gpu: "auto" });
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

test("imagem substituta respeita a janela do clip", { timeout: 300_000 }, async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg não encontrado");
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  const workspace = await mkdtemp(join(tmpdir(), "ff-media-window-"));
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
  const session = await openSession({ url: server.url, viewport: { width: 640, height: 360 }, gpu: "auto" });
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
