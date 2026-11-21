// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadComposition } from "@frankframes/contract";
import { codecArgs, mixAudio } from "../src/audio.ts";
import type { AudioClip } from "../src/audio.ts";
import { resolveFfmpeg } from "../src/ffmpeg.ts";
import {
  PREVIEW_AUDIO_MAX_SECONDS,
  PreviewAudioError,
  audioClipsFor,
  previewAudioKey,
  renderPreviewAudio,
} from "../src/preview-audio.ts";

const run = promisify(execFile);

function compositionOf(body: string, duration = 3) {
  const html = `<!doctype html><html><body>
  <div data-composition-id="c" data-width="640" data-height="360" data-fps="30" data-duration="${duration}">${body}</div>
  </body></html>`;
  const parsed = loadComposition(html);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  return parsed;
}

/** WAV PCM mono 8 kHz com um tom de 440 Hz (silêncio quebraria a medição do loudnorm). */
function tone(seconds: number): Buffer {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  return buffer;
}

const FULL_CLIP = `<audio data-clip-id="m" src="a.wav" data-start="0.5" data-duration="1" data-volume="0.5"
  data-fade-in="0.2" data-audio-role="music" data-keyframes='[{"time":0,"volume":1},{"time":1,"volume":0.2}]'
  data-offset="1" data-playback-rate="1.5"></audio>
  <div data-clip-id="t" data-start="0" data-duration="1">texto</div>`;

test("audioClipsFor traz todos os campos do mix e ignora clips sem som", () => {
  const parsed = compositionOf(FULL_CLIP);
  const clips = audioClipsFor({ composition: parsed, entryDir: resolve("C:/proj"), seconds: 3 });
  assert.equal(clips.length, 1, "só o <audio> entra no mix");
  const [clip] = clips;
  assert.equal(clip?.clipId, "m");
  assert.equal(clip?.file, resolve("C:/proj", "a.wav"));
  assert.equal(clip?.start, 0.5);
  assert.equal(clip?.duration, 1);
  assert.equal(clip?.offset, 1);
  assert.equal(clip?.playbackRate, 1.5);
  assert.equal(clip?.volume, 0.5);
  assert.equal(clip?.role, "music");
  assert.equal(clip?.fadeIn, 0.2);
  assert.equal(clip?.keyframes?.length, 2);
});

test("audioClipsFor usa volume 1 e o resto da composição como duração quando o autor não informa", () => {
  const parsed = compositionOf(`<audio data-clip-id="v" src="v.wav" data-start="1"></audio>`, 4);
  const [clip] = audioClipsFor({ composition: parsed, entryDir: resolve("C:/proj"), seconds: 4 });
  assert.equal(clip?.volume, 1);
  assert.equal(clip?.duration, 3);
});

const BASE: AudioClip = { clipId: "m", file: "C:/x/a.wav", start: 0, duration: 1, offset: 0, playbackRate: 1, volume: 1 };
const STATS = { "C:/x/a.wav": { size: 10, mtimeMs: 1000 } };

test("previewAudioKey: mesma entrada, mesma chave; o que entra no mix muda a chave", () => {
  const key = previewAudioKey([BASE], 2, STATS);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(previewAudioKey([{ ...BASE }], 2, { ...STATS }), key);
  assert.notEqual(previewAudioKey([{ ...BASE, volume: 0.5 }], 2, STATS), key, "volume");
  assert.notEqual(previewAudioKey([{ ...BASE, playbackRate: 1.5 }], 2, STATS), key, "rate");
  assert.notEqual(previewAudioKey([BASE], 3, STATS), key, "duração total");
  assert.notEqual(previewAudioKey([BASE], 2, { "C:/x/a.wav": { size: 10, mtimeMs: 2000 } }), key, "mtime do arquivo");
  assert.notEqual(previewAudioKey([BASE], 2, { "C:/x/a.wav": { size: 11, mtimeMs: 1000 } }), key, "tamanho do arquivo");
});

test("codecArgs: aac para o render, pcm_s16le para o preview", () => {
  assert.deepEqual(codecArgs("aac"), ["-c:a", "aac", "-b:a", "192k"]);
  assert.deepEqual(codecArgs("wav"), ["-c:a", "pcm_s16le"]);
});

test("renderPreviewAudio sem clips de áudio devolve null", async () => {
  const parsed = compositionOf(`<div data-clip-id="t" data-start="0" data-duration="1">texto</div>`);
  const result = await renderPreviewAudio({
    prepared: { composition: parsed, entryDir: tmpdir(), seconds: 3 },
    ffmpeg: "ffmpeg-nunca-chamado",
    cacheDir: join(tmpdir(), "ff-preview-audio-nao-criado"),
  });
  assert.equal(result, null);
});

test("renderPreviewAudio falha alto com E_PREVIEW_AUDIO quando o arquivo de mídia não existe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-preview-audio-"));
  try {
    const parsed = compositionOf(`<audio data-clip-id="m" src="falta.wav" data-start="0" data-duration="1"></audio>`);
    await assert.rejects(
      renderPreviewAudio({
        prepared: { composition: parsed, entryDir: dir, seconds: 3 },
        ffmpeg: "ffmpeg-nunca-chamado",
        cacheDir: join(dir, "cache"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof PreviewAudioError);
        assert.equal(error.code, "E_PREVIEW_AUDIO");
        assert.match(error.message, /falta\.wav/);
        assert.ok(error.hint.length > 0, "erro com dica acionável");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acima de 20 min o mix do preview fica desligado, com aviso, sem chamar o FFmpeg", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-preview-audio-"));
  try {
    const seconds = PREVIEW_AUDIO_MAX_SECONDS + 1;
    const parsed = compositionOf(`<audio data-clip-id="m" src="longo.wav" data-start="0" data-duration="5"></audio>`, seconds);
    const result = await renderPreviewAudio({
      prepared: { composition: parsed, entryDir: dir, seconds },
      ffmpeg: "ffmpeg-nunca-chamado",
      cacheDir: join(dir, "cache"),
    });
    assert.ok(result !== null && "disabled" in result, "devolve { disabled }");
    assert.match(result.disabled, /20 min/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function ffmpegPair(t: { skip: (reason: string) => void }) {
  try {
    return await resolveFfmpeg();
  } catch (error) {
    t.skip(`FFmpeg indisponível: ${(error as Error).message}`);
    return null;
  }
}

async function probe(ffprobe: string, file: string, entry: string): Promise<string> {
  const { stdout } = await run(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", entry, "-of", "default=nw=1:nk=1", file]);
  return stdout.trim();
}

test("renderPreviewAudio gera o WAV com a duração da composição e reaproveita o cache", async (t) => {
  const pair = await ffmpegPair(t);
  if (pair === null) return;
  const dir = await mkdtemp(join(tmpdir(), "ff-preview-audio-"));
  try {
    await writeFile(join(dir, "tom.wav"), tone(1));
    const parsed = compositionOf(`<audio data-clip-id="m" src="tom.wav" data-start="0.5" data-duration="1"></audio>`, 2);
    const options = { prepared: { composition: parsed, entryDir: dir, seconds: 2 }, ffmpeg: pair.ffmpeg, cacheDir: join(dir, "cache") };

    const first = await renderPreviewAudio(options);
    assert.ok(first !== null && "key" in first, "devolve a chave do mix");
    assert.equal(first.file, join(dir, "cache", `${first.key}.wav`));
    const duration = Number(await probe(pair.ffprobe, first.file, "format=duration"));
    assert.ok(Math.abs(duration - 2) <= 1 / 30, `duração do mix ${duration}s, esperado 2s`);
    assert.equal(await probe(pair.ffprobe, first.file, "stream=codec_name"), "pcm_s16le");

    const mtime = (await stat(first.file)).mtimeMs;
    const second = await renderPreviewAudio(options);
    assert.ok(second !== null && "key" in second);
    assert.equal(second.key, first.key, "mesma composição, mesma chave");
    assert.equal(first.cached, false, "primeira vez mixa");
    assert.equal(second.cached, true, "segunda vez vem do cache");
    assert.equal((await stat(first.file)).mtimeMs, mtime, "cache hit não reescreve o arquivo");

    // Trocar o conteúdo do arquivo (mtime/tamanho) invalida a chave.
    await writeFile(join(dir, "tom.wav"), tone(1.5));
    const third = await renderPreviewAudio(options);
    assert.ok(third !== null && "key" in third);
    assert.notEqual(third.key, first.key, "arquivo de mídia mudou");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderPreviewAudio com sinal já cancelado falha com E_PREVIEW_AUDIO e não deixa arquivo no cache", async (t) => {
  const pair = await ffmpegPair(t);
  if (pair === null) return;
  const dir = await mkdtemp(join(tmpdir(), "ff-preview-audio-"));
  try {
    await writeFile(join(dir, "tom.wav"), tone(1));
    const parsed = compositionOf(`<audio data-clip-id="m" src="tom.wav" data-start="0" data-duration="1"></audio>`, 2);
    await assert.rejects(
      renderPreviewAudio({
        prepared: { composition: parsed, entryDir: dir, seconds: 2 },
        ffmpeg: pair.ffmpeg,
        cacheDir: join(dir, "cache"),
        signal: AbortSignal.abort(),
      }),
      (error: unknown) => error instanceof PreviewAudioError && error.code === "E_PREVIEW_AUDIO",
    );
    assert.deepEqual(await readdir(join(dir, "cache")), [], "cache sem arquivo parcial");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mixAudio com format wav entrega pcm_s16le; o padrão continua aac", async (t) => {
  const pair = await ffmpegPair(t);
  if (pair === null) return;
  const dir = await mkdtemp(join(tmpdir(), "ff-preview-audio-"));
  try {
    await writeFile(join(dir, "tom.wav"), tone(1));
    const clips: AudioClip[] = [{ ...BASE, file: join(dir, "tom.wav") }];
    await mixAudio({ ffmpeg: pair.ffmpeg, clips, totalSeconds: 1, outPath: join(dir, "out.wav"), format: "wav", loudness: false });
    await mixAudio({ ffmpeg: pair.ffmpeg, clips, totalSeconds: 1, outPath: join(dir, "out.m4a"), loudness: false });
    assert.equal(await probe(pair.ffprobe, join(dir, "out.wav"), "stream=codec_name"), "pcm_s16le");
    assert.equal(await probe(pair.ffprobe, join(dir, "out.m4a"), "stream=codec_name"), "aac");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
