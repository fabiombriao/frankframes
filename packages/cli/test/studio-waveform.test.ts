// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileDigest } from "@frankframes/engine";
import { resolveFfmpeg } from "@frankframes/producer";
import { PeakAccumulator, WaveformError, peaksFromPcm, waveformFor } from "../src/studio-waveform.ts";

/** PCM s16le: `count` amostras de `value`, ou ±`value` alternando quando `alternate`. */
function pcm(count: number, value: number, alternate = false): Buffer {
  const buffer = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index++) buffer.writeInt16LE(alternate && index % 2 === 1 ? -value : value, index * 2);
  return buffer;
}

/** WAV mono de 8 kHz: primeira metade silêncio, segunda onda quadrada cheia. */
function halfSilentWav(seconds: number): Buffer {
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
  for (let index = Math.floor(samples / 2); index < samples; index++) buffer.writeInt16LE(index % 2 === 0 ? 32767 : -32767, 44 + index * 2);
  return buffer;
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function ffmpegOrSkip(t: TestContext): Promise<string | undefined> {
  try {
    const { ffmpeg } = await resolveFfmpeg();
    if (spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status !== 0) throw new Error("não executa");
    return ffmpeg;
  } catch (error) {
    t.skip(`ffmpeg indisponível: ${(error as Error).message}`);
    return undefined;
  }
}

async function withTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ff-waveform-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("peaksFromPcm: silêncio e onda cheia viram 0 e 255, e byte solto no fim é ignorado", () => {
  const buffer = Buffer.concat([pcm(80, 0), pcm(80, 32767, true)]);
  assert.deepEqual(peaksFromPcm(buffer, 80), [0, 255]);
  const odd = Buffer.concat([buffer, Buffer.from([0x7f])]);
  assert.deepEqual(peaksFromPcm(odd, 80), [0, 255], "a amostra incompleta não vira pico");
  assert.deepEqual(peaksFromPcm(pcm(80, -32768), 80), [255], "-32768 não passa de 255");
  assert.deepEqual(peaksFromPcm(pcm(80, 16384), 80), [128]);
});

test("peaksFromPcm: janela final só conta com pelo menos metade das amostras", () => {
  assert.deepEqual(peaksFromPcm(Buffer.concat([pcm(80, 0), pcm(40, 32767)]), 80), [0, 255]);
  assert.deepEqual(peaksFromPcm(Buffer.concat([pcm(80, 0), pcm(39, 32767)]), 80), [0]);
  assert.deepEqual(peaksFromPcm(Buffer.alloc(0), 80), []);
});

test("PeakAccumulator dá o mesmo resultado em pedaços quebrados no meio de uma amostra", () => {
  const whole = Buffer.concat([pcm(80, 0), pcm(80, 32767, true), pcm(80, 8000)]);
  const accumulator = new PeakAccumulator(80);
  for (let at = 0; at < whole.length; at += 7) accumulator.push(whole.subarray(at, at + 7));
  assert.deepEqual(accumulator.finish(), peaksFromPcm(whole, 80));
  assert.equal(accumulator.samples, 240);
});

test("waveformFor: meio silêncio e meio onda cheia, 100 picos por segundo, e grava o cache", async (t) => {
  const ffmpeg = await ffmpegOrSkip(t);
  if (ffmpeg === undefined) return;
  await withTemp(async (dir) => {
    const file = join(dir, "meia.wav");
    await writeFile(file, halfSilentWav(1));
    const cacheDir = join(dir, "cache");
    const waveform = await waveformFor(ffmpeg, file, { cacheDir });
    assert.equal(waveform.peaksPerSecond, 100);
    assert.equal(waveform.peaks.length, 100);
    assert.equal(waveform.peaks[10], 0);
    assert.ok(waveform.peaks[90]! > 200, `pico da metade cheia: ${String(waveform.peaks[90])}`);
    assert.ok(Math.abs(waveform.duration - 1) < 0.02, `duração ${waveform.duration}`);
    assert.equal(waveform.digest, await fileDigest(file));
    // Gravação atômica: só o JSON final fica na pasta, nenhum .tmp.
    assert.deepEqual(await readdir(cacheDir), [`${waveform.digest}.v1.json`]);
  });
});

test("waveformFor: a segunda chamada não roda o FFmpeg e pedidos simultâneos dividem uma análise", async (t) => {
  const ffmpeg = await ffmpegOrSkip(t);
  if (ffmpeg === undefined) return;
  await withTemp(async (dir) => {
    const file = join(dir, "meia.wav");
    await writeFile(file, halfSilentWav(1));
    let calls = 0;
    const spawnImpl = ((command: string, args: string[]) => {
      calls += 1;
      return spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    }) as NonNullable<Parameters<typeof waveformFor>[2]>["spawnImpl"];
    const options = { cacheDir: join(dir, "cache"), spawnImpl };

    const [first, concurrent] = await Promise.all([waveformFor(ffmpeg, file, options), waveformFor(ffmpeg, file, options)]);
    assert.equal(calls, 1, "dois pedidos ao mesmo tempo, uma análise");
    assert.deepEqual(concurrent, first);

    const second = await waveformFor(ffmpeg, file, options);
    assert.equal(calls, 1, "do cache, sem FFmpeg");
    assert.deepEqual(second, first);
  });
});

test("waveformFor: imagem não tem áudio e falha alto, nunca devolve picos vazios", async (t) => {
  const ffmpeg = await ffmpegOrSkip(t);
  if (ffmpeg === undefined) return;
  await withTemp(async (dir) => {
    const file = join(dir, "pixel.png");
    await writeFile(file, PNG);
    await assert.rejects(
      waveformFor(ffmpeg, file, { cacheDir: join(dir, "cache") }),
      (error: unknown) => error instanceof WaveformError && (error.code === "E_WAVEFORM_NO_AUDIO" || error.code === "E_WAVEFORM_FAILED"),
    );
    assert.deepEqual(await readdir(dir), ["pixel.png"], "falha não deixa cache");
  });
});

test("waveformFor: cache corrompido falha com E_WAVEFORM_FAILED e manda apagar o arquivo", async () => {
  await withTemp(async (dir) => {
    const file = join(dir, "meia.wav");
    await writeFile(file, halfSilentWav(1));
    const cacheDir = join(dir, "cache");
    const digest = await fileDigest(file);
    const cached = join(cacheDir, `${digest}.v1.json`);
    const boom = (() => {
      throw new Error("o FFmpeg não deveria rodar com cache presente");
    }) as NonNullable<Parameters<typeof waveformFor>[2]>["spawnImpl"];

    await mkdir(cacheDir, { recursive: true });
    const broken: Array<[string, string]> = [
      ["JSON truncado", '{"digest":"x","peaks":[1,2'],
      ["formato inesperado", JSON.stringify({ digest, peaksPerSecond: 100, duration: 1, peaks: [] })],
      ["pico fora de 0–255", JSON.stringify({ digest, peaksPerSecond: 100, duration: 1, peaks: [1, 300] })],
      ["digest de outro arquivo", JSON.stringify({ digest: "0".repeat(64), peaksPerSecond: 100, duration: 1, peaks: [1] })],
    ];
    for (const [label, content] of broken) {
      await writeFile(cached, content, "utf8");
      await assert.rejects(
        waveformFor("ffmpeg-nao-usado", file, { cacheDir, spawnImpl: boom }),
        (error: unknown) => {
          assert.ok(error instanceof WaveformError, `${label}: ${String(error)}`);
          assert.equal(error.code, "E_WAVEFORM_FAILED", label);
          assert.match(error.hint, /apague .*\.v1\.json/, label);
          assert.ok(error.message.includes(cached), `${label}: a mensagem aponta o arquivo`);
          return true;
        },
      );
      assert.equal(await readFile(cached, "utf8"), content, `${label}: o cache ruim não é reescrito em silêncio`);
    }
  });
});
