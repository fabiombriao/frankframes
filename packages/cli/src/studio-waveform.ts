// FrankFrames — proprietário. Ver LICENSE na raiz.
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { assetPath, fileDigest } from "@frankframes/engine";

/** Picos de 10 ms: 8000 amostras/s ÷ 80 amostras por pico. */
const SAMPLE_RATE = 8000;
const SAMPLES_PER_PEAK = 80;
export const PEAKS_PER_SECOND = SAMPLE_RATE / SAMPLES_PER_PEAK;
const CACHE_VERSION = "v1";
const MAX_CONCURRENT = 2;
const STDERR_TAIL = 1200;

export interface Waveform {
  /** sha256 do arquivo-fonte inteiro. */
  digest: string;
  peaksPerSecond: number;
  /** Duração do áudio da fonte, em segundos. */
  duration: number;
  /** Máximo do valor absoluto por janela de 10 ms, de 0 a 255. */
  peaks: number[];
}

export type WaveformErrorCode = "E_WAVEFORM_NO_AUDIO" | "E_WAVEFORM_FAILED";

export class WaveformError extends Error {
  readonly code: WaveformErrorCode;
  readonly hint: string;

  constructor(code: WaveformErrorCode, message: string, hint: string) {
    super(message);
    this.name = "WaveformError";
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Acumula picos de PCM s16le mono sem exigir o buffer inteiro: o FFmpeg entrega o áudio em pedaços.
 * Um byte solto no fim de um pedaço espera o próximo; um byte solto no fim do fluxo é ignorado.
 */
export class PeakAccumulator {
  readonly peaks: number[] = [];
  samples = 0;
  private readonly samplesPerPeak: number;
  private carry: Buffer = Buffer.alloc(0);
  private windowMax = 0;
  private windowCount = 0;

  constructor(samplesPerPeak: number) {
    if (!Number.isInteger(samplesPerPeak) || samplesPerPeak < 1) throw new RangeError("samplesPerPeak precisa ser inteiro >= 1");
    this.samplesPerPeak = samplesPerPeak;
  }

  push(chunk: Buffer): void {
    const data = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const usable = data.length - (data.length % 2);
    for (let at = 0; at < usable; at += 2) {
      const magnitude = Math.abs(data.readInt16LE(at));
      if (magnitude > this.windowMax) this.windowMax = magnitude;
      this.samples += 1;
      this.windowCount += 1;
      if (this.windowCount === this.samplesPerPeak) this.flush();
    }
    this.carry = usable < data.length ? Buffer.from(data.subarray(usable)) : Buffer.alloc(0);
  }

  /** Fecha o fluxo. A janela final só conta se tiver ao menos metade das amostras. */
  finish(): number[] {
    if (this.windowCount * 2 >= this.samplesPerPeak) this.flush();
    this.windowMax = 0;
    this.windowCount = 0;
    return this.peaks;
  }

  private flush(): void {
    this.peaks.push(Math.min(255, Math.round((this.windowMax / 32767) * 255)));
    this.windowMax = 0;
    this.windowCount = 0;
  }
}

/** Picos de um buffer s16le mono completo: `samplesPerPeak` amostras por pico, de 0 a 255. */
export function peaksFromPcm(buf: Buffer, samplesPerPeak: number): number[] {
  const accumulator = new PeakAccumulator(samplesPerPeak);
  accumulator.push(buf);
  return accumulator.finish();
}

type Spawner = (command: string, args: string[]) => ChildProcessByStdio<null, Readable, Readable>;

export interface WaveformOptions {
  /** Pasta do cache; padrão `cache/waveform` do FRANKFRAMES_HOME. */
  cacheDir?: string;
  /** Troca o `spawn` (testes contam as chamadas ao FFmpeg). */
  spawnImpl?: Spawner;
}

const realSpawn: Spawner = (command, args) => spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

/** Hash do arquivo guardado por (caminho, tamanho, mtime): o mesmo arquivo não é relido a cada pedido. */
const digests = new Map<string, { size: number; mtimeMs: number; digest: string }>();

async function digestOf(file: string): Promise<string> {
  const info = await stat(file);
  const known = digests.get(file);
  if (known !== undefined && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.digest;
  const digest = await fileDigest(file);
  digests.set(file, { size: info.size, mtimeMs: info.mtimeMs, digest });
  return digest;
}

const inFlight = new Map<string, Promise<Waveform>>();
let running = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((release) => waiting.push(release));
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function isWaveform(value: unknown, digest: string): value is Waveform {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.digest !== digest || record.peaksPerSecond !== PEAKS_PER_SECOND) return false;
  if (typeof record.duration !== "number" || !Number.isFinite(record.duration)) return false;
  const peaks = record.peaks;
  if (!Array.isArray(peaks) || peaks.length === 0) return false;
  return peaks.every((peak) => typeof peak === "number" && Number.isInteger(peak) && peak >= 0 && peak <= 255);
}

/** Cache sem arquivo é `undefined`; arquivo ilegível ou fora do formato falha alto, nunca é ignorado. */
async function readCache(path: string, digest: string): Promise<Waveform | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new WaveformError("E_WAVEFORM_FAILED", `cache de waveform ilegível: ${path} (${(error as Error).message})`, `apague ${path} e tente de novo`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new WaveformError("E_WAVEFORM_FAILED", `cache de waveform corrompido: ${path} (${(error as Error).message})`, `apague ${path} e tente de novo`);
  }
  if (!isWaveform(parsed, digest)) {
    throw new WaveformError("E_WAVEFORM_FAILED", `cache de waveform com formato inesperado: ${path}`, `apague ${path} e tente de novo`);
  }
  return parsed;
}

async function writeCache(path: string, waveform: Waveform): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(waveform), "utf8");
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw new WaveformError("E_WAVEFORM_FAILED", `não foi possível gravar o cache de waveform: ${(error as Error).message}`, "confira o espaço e a permissão da pasta cache/waveform");
  }
}

function analyze(ffmpeg: string, file: string, spawnImpl: Spawner): Promise<{ peaks: number[]; samples: number }> {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"];
    const child = spawnImpl(ffmpeg, args);
    const accumulator = new PeakAccumulator(SAMPLES_PER_PEAK);
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => accumulator.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    child.once("error", (error) => {
      reject(new WaveformError("E_WAVEFORM_FAILED", `não foi possível iniciar o FFmpeg: ${error.message}`, "rode `frankframes doctor` para conferir o FFmpeg"));
    });
    child.once("close", (code) => {
      const tail = stderr.trim();
      if (code !== 0) {
        if (/matches no streams|does not contain any stream/i.test(tail)) {
          reject(new WaveformError("E_WAVEFORM_NO_AUDIO", "o arquivo não tem faixa de áudio", "só áudio/vídeo com som tem waveform"));
          return;
        }
        reject(new WaveformError("E_WAVEFORM_FAILED", `FFmpeg saiu com código ${String(code)}: ${tail || "(sem mensagem)"}`, "confira o arquivo com ffprobe"));
        return;
      }
      const peaks = accumulator.finish();
      if (peaks.length === 0) {
        reject(new WaveformError("E_WAVEFORM_FAILED", "FFmpeg não entregou amostras de áudio", "confira o arquivo com ffprobe"));
        return;
      }
      resolve({ peaks, samples: accumulator.samples });
    });
  });
}

/**
 * Picos de 10 ms do arquivo-fonte inteiro (mono), guardados em `cache/waveform/<sha256>.v1.json`:
 * o mesmo arquivo nunca é analisado duas vezes. Pedidos simultâneos do mesmo arquivo dividem uma análise.
 */
export function waveformFor(ffmpeg: string, file: string, options: WaveformOptions = {}): Promise<Waveform> {
  const spawnImpl = options.spawnImpl ?? realSpawn;
  const cacheDir = options.cacheDir ?? assetPath("cache", "waveform");

  const compute = async (): Promise<Waveform> => {
    const digest = await digestOf(file);
    const path = join(cacheDir, `${digest}.${CACHE_VERSION}.json`);
    const pending = inFlight.get(path);
    if (pending !== undefined) return pending;
    const promise = (async (): Promise<Waveform> => {
      const cached = await readCache(path, digest);
      if (cached !== undefined) return cached;
      const { peaks, samples } = await withSlot(() => analyze(ffmpeg, file, spawnImpl));
      const waveform: Waveform = { digest, peaksPerSecond: PEAKS_PER_SECOND, duration: samples / SAMPLE_RATE, peaks };
      await writeCache(path, waveform);
      return waveform;
    })();
    inFlight.set(path, promise);
    const clear = (): void => {
      if (inFlight.get(path) === promise) inFlight.delete(path);
    };
    promise.then(clear, clear);
    return promise;
  };
  return compute();
}
