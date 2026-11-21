// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { evictCache, extractFramesCached, frameCacheKey } from "../src/cache.ts";
import { assetPath } from "../src/home.ts";

const run = promisify(execFile);

test("segunda extração do mesmo vídeo não chama o ffmpeg", { timeout: 300_000 }, async (t) => {
  const ffmpegPath = assetPath("ffmpeg", "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const pair = { ffmpeg: ffmpegPath };
  try {
    await run(pair.ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
  } catch {
    return t.skip("ffmpeg não encontrado");
  }

  const dir = await mkdtemp(join(tmpdir(), "ff-cache-"));
  const clip = join(dir, "clip.mp4");
  await run(pair.ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=1",
    "-c:v", "mpeg4", "-q:v", "5", "-pix_fmt", "yuv420p", "-y", clip,
  ]);
  const cacheRoot = join(dir, "cache");
  await mkdir(cacheRoot, { recursive: true });

  const options = { ffmpeg: pair.ffmpeg, input: clip, outDir: join(cacheRoot, "x"), fps: { num: 30, den: 1 }, offset: 0, duration: 1, root: cacheRoot };
  const first = await extractFramesCached(options);
  assert.equal(first.hit, false);
  assert.ok(first.frameCount >= 28);

  // Um binário que falha prova que a segunda chamada não extraiu nada.
  const broken = join(dir, "ffmpeg-quebrado");
  await writeFile(broken, "");
  const second = await extractFramesCached({ ...options, ffmpeg: broken });
  assert.equal(second.hit, true);
  assert.equal(second.frameCount, first.frameCount);
  assert.equal(second.dir, first.dir);
});

test("chave muda com janela e com conteúdo", () => {
  const base = { digest: "a".repeat(64), fps: { num: 30, den: 1 }, offset: 0, duration: 2 };
  assert.notEqual(frameCacheKey(base), frameCacheKey({ ...base, offset: 1 }));
  assert.notEqual(frameCacheKey(base), frameCacheKey({ ...base, duration: 3 }));
  assert.notEqual(frameCacheKey(base), frameCacheKey({ ...base, digest: "b".repeat(64), }));
  assert.equal(frameCacheKey(base), frameCacheKey({ ...base }));
});

test("evicção remove o mais antigo até caber no teto", async () => {
  const root = await mkdtemp(join(tmpdir(), "ff-evict-"));
  for (const [name, seconds] of [["velho", 1_000_000], ["novo", 1_100_000]] as const) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "frame.jpg"), Buffer.alloc(4096));
    await utimes(join(root, name), new Date(seconds * 1000), new Date(seconds * 1000));
  }
  const removed = await evictCache(root, 4096);
  assert.equal(removed, 1);
  assert.deepEqual(await readdir(root), ["novo"]);
});
