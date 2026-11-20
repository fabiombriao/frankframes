// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { prepare } from "../src/render.ts";
import { resolveFfmpeg } from "../src/ffmpeg.ts";

const run = promisify(execFile);

test("vídeo dentro de sub-composição entra no manifesto com início absoluto", { timeout: 300_000 }, async (t) => {
  const pair = await resolveFfmpeg();
  try {
    await run(pair.ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
  } catch {
    return t.skip("ffmpeg não encontrado");
  }

  const dir = await mkdtemp(join(tmpdir(), "ff-nested-"));
  await mkdir(join(dir, "cards"), { recursive: true });
  await run(pair.ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=1",
    "-c:v", "mpeg4", "-q:v", "5", "-pix_fmt", "yuv420p", "-y", join(dir, "cards", "clip.mp4"),
  ]);

  await writeFile(
    join(dir, "cards", "card.html"),
    `<html><body><div data-composition-id="card" data-duration="1">
      <video data-clip-id="v" data-start="0" data-duration="1" src="clip.mp4" style="position:fixed;left:0;top:0;width:160px;height:90px"></video>
    </div></body></html>`,
  );
  const entry = join(dir, "index.html");
  await writeFile(
    entry,
    `<html><body><div data-composition-id="main" data-root="true" data-width="320" data-height="180"
      data-fps="30" data-duration="2">
      <div data-composition-id="host" data-start="1" data-composition-src="cards/card.html"></div>
    </div></body></html>`,
  );

  const prepared = await prepare({ entry, ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe });
  assert.ok(prepared.manifest, "a sub-composição com vídeo precisa gerar manifesto");
  assert.equal(prepared.manifest.clips.length, 1);

  const clip = prepared.manifest.clips[0]!;
  assert.equal(clip.clipId, "v");
  assert.ok(Math.abs(clip.start - 1) < 1e-6, `início absoluto esperado 1s, obtido ${clip.start}`);
  assert.ok(clip.frameCount >= 28 && clip.frameCount <= 31, `frames extraídos: ${clip.frameCount}`);
});
