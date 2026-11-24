// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { MediaRotationError } from "@frankframes/engine";
import { resolveFfmpeg } from "@frankframes/producer";
import type { FfmpegPair } from "@frankframes/producer";
import { IMAGE_SECONDS, measureMedia } from "../src/studio-media.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

/** EDT-86: o import do Studio mede o vídeo com a mesma orientação de exibição que o render usa. */
const run = promisify(execFile);

async function ffmpegOrSkip(t: TestContext): Promise<FfmpegPair | undefined> {
  const pair = await resolveFfmpeg();
  try {
    await run(pair.ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
    return pair;
  } catch {
    t.skip("ffmpeg não encontrado");
    return undefined;
  }
}

/** Vídeo mpeg4 160x96 e uma cópia só com a Display Matrix pedida no contêiner. */
async function makeVideo(pair: FfmpegPair, dir: string, name: string, flags: string[]): Promise<string> {
  const base = join(dir, `${name}-base.mp4`);
  await run(pair.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=160x96:r=10:d=1", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-y", base]);
  const out = join(dir, `${name}.mp4`);
  await run(pair.ffmpeg, ["-hide_banner", "-loglevel", "error", ...flags, "-i", base, "-c", "copy", "-y", out]);
  return out;
}

test("measureMedia: vídeo em retrato devolve a orientação de exibição", { timeout: 60_000 }, async (t) => {
  const pair = await ffmpegOrSkip(t);
  if (pair === undefined) return;
  const dir = await tempDir(t, "ff-media-");
  const measured = await measureMedia(pair.ffprobe, await makeVideo(pair, dir, "retrato", ["-display_rotation", "270"]), "video");
  assert.deepEqual(measured.orientation, { rotation: -90, mirrored: false, displayWidth: 96, displayHeight: 160 });
  assert.ok(measured.duration > 0.9 && measured.duration < 1.2);

  const plain = await measureMedia(pair.ffprobe, await makeVideo(pair, dir, "plano", []), "video");
  assert.deepEqual(plain.orientation, { rotation: 0, mirrored: false, displayWidth: 160, displayHeight: 96 });
});

test("measureMedia: rotação de 45 graus falha com E_MEDIA_ROTATION e hint", { timeout: 60_000 }, async (t) => {
  const pair = await ffmpegOrSkip(t);
  if (pair === undefined) return;
  const dir = await tempDir(t, "ff-media-");
  await assert.rejects(
    measureMedia(pair.ffprobe, await makeVideo(pair, dir, "giro", ["-display_rotation", "45"]), "video"),
    (error: unknown) => error instanceof MediaRotationError && error.code === "E_MEDIA_ROTATION" && error.hint.length > 0,
  );
});

test("measureMedia: imagem usa a duração padrão e áudio é medido pelo ffprobe, sem orientação", { timeout: 60_000 }, async (t) => {
  const pair = await ffmpegOrSkip(t);
  if (pair === undefined) return;
  const dir = await tempDir(t, "ff-media-");
  assert.deepEqual(await measureMedia(pair.ffprobe, join(dir, "nao-lido.png"), "img"), { duration: IMAGE_SECONDS });

  const wav = join(dir, "tom.wav");
  await run(pair.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-y", wav]);
  const audio = await measureMedia(pair.ffprobe, wav, "audio");
  assert.equal(audio.orientation, undefined);
  assert.ok(audio.duration > 0.9 && audio.duration < 1.1);
});
