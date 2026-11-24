// FrankFrames — proprietário. Ver LICENSE na raiz.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { probeDuration } from "@frankframes/engine";

const run = promisify(execFile);

/** Códigos do comando `frames` (entram no `docs/reference/diagnostics.md`). */
export const FRAMES_ERROR_CODES = ["E_FRAMES_INPUT", "E_FRAMES_TIME"] as const;
export type FramesCode = (typeof FRAMES_ERROR_CODES)[number];

/** Falha do `frames`, com código estável e dica acionável. */
export class FramesError extends Error {
  readonly code: FramesCode;
  readonly hint: string;

  constructor(code: FramesCode, message: string, hint: string) {
    super(message);
    this.name = "FramesError";
    this.code = code;
    this.hint = hint;
  }
}

/** Miniatura em cinza usada nas estatísticas: 64×36 = 2304 bytes. */
const THUMB_WIDTH = 64;
const THUMB_HEIGHT = 36;
/** Abaixo deste desvio padrão (escala 0–255) o frame é chapado: tela preta, fundo sem texto. */
const UNIFORM_STD = 2;
const TIME_HINT = "use segundos ou porcentagem, ex. `--at 10%,2.5`";

export interface FrameStat {
  /** Instante em segundos (arredondado a 1 ms). */
  t: number;
  png: string;
  meanLuma: number;
  stdLuma: number;
  /** `stdLuma < 2`: nada para ver neste instante. */
  uniform: boolean;
}

export interface FramesReport {
  file: string;
  durationSeconds: number;
  frames: FrameStat[];
}

const ms = (seconds: number): number => Math.round(seconds * 1000);

/**
 * Lê `--at`: lista separada por vírgula de segundos (`1.5`) ou porcentagens da duração (`10%`).
 * Cada instante precisa estar em `[0, duração)`. Devolve em ordem crescente, sem repetidos (a 1 ms).
 */
export function parseFrameTimes(spec: string, durationSeconds: number): number[] {
  const tokens = spec.split(",").map((token) => token.trim());
  if (tokens.some((token) => token === "")) {
    throw new FramesError("E_FRAMES_TIME", `lista de instantes vazia ou com item vazio: "${spec}"`, TIME_HINT);
  }
  const found = new Map<number, number>();
  for (const token of tokens) {
    if (!/^\d+(?:\.\d+)?%?$/.test(token)) {
      throw new FramesError("E_FRAMES_TIME", `instante inválido: "${token}"`, TIME_HINT);
    }
    const value = token.endsWith("%") ? (Number(token.slice(0, -1)) * durationSeconds) / 100 : Number(token);
    const rounded = ms(value);
    if (!(value >= 0) || rounded / 1000 >= durationSeconds) {
      throw new FramesError("E_FRAMES_TIME", `instante fora do vídeo: "${token}" (duração ${durationSeconds} s; vale de 0 até antes do fim)`, TIME_HINT);
    }
    found.set(rounded, rounded / 1000);
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, seconds]) => seconds);
}

/** Média e desvio padrão (população) dos bytes de uma miniatura em cinza. */
export function lumaStats(gray: Uint8Array): { meanLuma: number; stdLuma: number } {
  let sum = 0;
  for (const value of gray) sum += value;
  const mean = sum / gray.length;
  let squares = 0;
  for (const value of gray) squares += (value - mean) ** 2;
  return { meanLuma: mean, stdLuma: Math.sqrt(squares / gray.length) };
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

function tail(text: string): string {
  return text.trim().split("\n").slice(-3).join(" | ");
}

async function ffmpeg(binary: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await run(binary, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: Buffer };
    const detail = failure.stderr !== undefined && failure.stderr.length > 0 ? tail(failure.stderr.toString("utf8")) : failure.message;
    throw new FramesError("E_FRAMES_INPUT", `o FFmpeg não conseguiu ler o vídeo: ${detail}`, "renderize antes: `frankframes render … --preset draft`");
  }
}

export interface InspectFramesOptions {
  ffmpeg: string;
  ffprobe: string;
  input: string;
  /** Mesma forma do `--at`: `"10%,50%"` ou `"1.5,3"`. */
  at: string;
  outDir: string;
}

/**
 * Extrai um PNG por instante e mede a luminância de uma miniatura 64×36 cinza: dá ao agente (ou à pessoa) uma
 * conferência objetiva de "tem alguma coisa na tela" antes de abrir as imagens. Não decodifica nada além do necessário.
 */
export async function inspectFrames(options: InspectFramesOptions): Promise<FramesReport> {
  if (!existsSync(options.input)) {
    throw new FramesError("E_FRAMES_INPUT", `arquivo ausente: ${options.input}`, "renderize antes: `frankframes render … --preset draft`");
  }
  let durationSeconds: number;
  try {
    durationSeconds = await probeDuration(options.ffprobe, options.input);
  } catch (error) {
    throw new FramesError("E_FRAMES_INPUT", `não consegui medir a duração de ${options.input}: ${(error as Error).message}`, "renderize antes: `frankframes render … --preset draft`");
  }
  const times = parseFrameTimes(options.at, durationSeconds);
  await mkdir(options.outDir, { recursive: true });

  const frames: FrameStat[] = [];
  for (const t of times) {
    const png = join(options.outDir, `t-${ms(t)}.png`);
    await ffmpeg(options.ffmpeg, ["-ss", String(t), "-i", options.input, "-an", "-frames:v", "1", "-y", png]);
    if (!existsSync(png)) {
      throw new FramesError("E_FRAMES_TIME", `o vídeo não tem frame em t=${t} s`, "use um instante um pouco antes do fim, ex. `--at 90%`");
    }
    const gray = await ffmpeg(options.ffmpeg, [
      "-ss", String(t), "-i", options.input, "-an", "-frames:v", "1",
      "-vf", `scale=${THUMB_WIDTH}:${THUMB_HEIGHT},format=gray`, "-f", "rawvideo", "pipe:1",
    ]);
    if (gray.length !== THUMB_WIDTH * THUMB_HEIGHT) {
      throw new FramesError("E_FRAMES_INPUT", `miniatura de t=${t} s com ${gray.length} bytes (esperado ${THUMB_WIDTH * THUMB_HEIGHT})`, "renderize antes: `frankframes render … --preset draft`");
    }
    const { meanLuma, stdLuma } = lumaStats(gray);
    frames.push({ t, png, meanLuma: round1(meanLuma), stdLuma: round1(stdLuma), uniform: stdLuma < UNIFORM_STD });
  }
  return { file: options.input, durationSeconds: Math.round(durationSeconds * 1000) / 1000, frames };
}
