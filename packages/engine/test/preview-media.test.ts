// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractFrames } from "../src/media.ts";
import { openSession, resolveChrome, startServer } from "../src/index.ts";
import { assetPath } from "../src/home.ts";
import type { MediaManifest } from "../src/media.ts";

const run = promisify(execFile);
const ffmpeg = assetPath("ffmpeg", "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("preview toca o vídeo fora de banda em tempo real", { timeout: 300_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }
  try {
    await run(ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
  } catch {
    return t.skip("ffmpeg ausente");
  }

  const dir = await mkdtemp(join(tmpdir(), "ff-preview-media-"));
  const clip = join(dir, "clip.mp4");
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
    "-c:v", "mpeg4", "-q:v", "5", "-pix_fmt", "yuv420p", "-y", clip,
  ]);
  const { frameCount } = await extractFrames({ ffmpeg, input: clip, outDir: join(dir, "media", "v"), fps: { num: 30, den: 1 } });
  const manifest: MediaManifest = {
    fps: { num: 30, den: 1 },
    clips: [{ clipId: "v", start: 0, duration: 2, offset: 0, playbackRate: 1, dir: "v", frameCount }],
  };
  await writeFile(
    join(dir, "index.html"),
    `<html><body><div data-composition-id="p" data-duration="2">
      <video data-clip-id="v" data-start="0" data-duration="2" data-ff-start="0" data-ff-end="2000"
             src="clip.mp4" style="position:fixed;left:0;top:0;width:320px;height:180px"></video>
    </div></body></html>`,
  );

  const server = await startServer(dir, {
    mediaRoot: join(dir, "media"),
    manifest,
    live: true,
    preview: { fps: { num: 30, den: 1 }, frames: 60 },
  });
  const session = await openSession({ url: server.url, viewport: { width: 320, height: 180 }, gpu: "software" });
  try {
    await sleep(400);
    const first = await session.evaluate<string>(`document.querySelector("img[data-ff-media]").src`);
    await sleep(700);
    const second = await session.evaluate<string>(`document.querySelector("img[data-ff-media]").src`);
    assert.match(first, /\/__ff_media\/v\/\d{6}\.jpg$/, "preview precisa servir frames extraídos");
    assert.notEqual(first, second, "o frame do vídeo precisa avançar sozinho no preview");
    assert.equal(await session.evaluate<string>(`document.querySelector("img[data-ff-media]").style.visibility`), "", "dentro da janela, visível");
  } finally {
    await session.close();
    await server.close();
  }
});
