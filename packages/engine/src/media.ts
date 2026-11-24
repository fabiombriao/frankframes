// FrankFrames — proprietário. Ver LICENSE na raiz.
import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Como `execFile`, mas só resolve ou rejeita depois que o processo saiu. No abort o Node rejeita na hora do kill, com o filho
 * ainda vivo e com arquivos abertos; quem limpa a saída em seguida esbarra em EBUSY (Windows) ou em arquivo novo.
 */
function runUntilExit(file: string, args: string[], options: { maxBuffer: number; signal?: AbortSignal }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error) => {
      const settle = (): void => (error === null ? resolve() : reject(error));
      // Falha ao subir o processo (sem pid) ou já saiu: nada a esperar.
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) settle();
      else child.once("exit", settle);
    });
  });
}

export interface MediaManifestEntry {
  /** `data-clip-id` do `<video>` que será substituído. */
  clipId: string;
  /** Início do clip na composição, em segundos. */
  start: number;
  /** Duração do clip, em segundos. */
  duration: number;
  /** `data-offset`: instante dentro da fonte. */
  offset: number;
  playbackRate: number;
  /** Subpasta servida em `/__ff_media/<dir>/`. */
  dir: string;
  frameCount: number;
}

export interface MediaManifest {
  fps: { num: number; den: number };
  clips: MediaManifestEntry[];
}

export interface ExtractOptions {
  ffmpeg: string;
  input: string;
  outDir: string;
  fps: { num: number; den: number };
  offset?: number;
  duration?: number;
  /** Cancela o FFmpeg em andamento. */
  signal?: AbortSignal;
}

/** Duração real da fonte, em segundos. */
export async function probeDuration(ffprobe: string, file: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await run(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    "--",
    file,
  ], signal !== undefined ? { signal } : {});
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`duração inválida em ${file}: ${stdout.trim()}`);
  return seconds;
}

/**
 * Extrai a janela do vídeo como sequência de JPEG, um por frame de saída.
 * `-ss` depois de `-i` = busca frame-exata; `-an` garante que o áudio não entra.
 */
export async function extractFrames(options: ExtractOptions): Promise<{ frameCount: number; pattern: string }> {
  await mkdir(options.outDir, { recursive: true });
  const rate = options.fps.den === 1 ? String(options.fps.num) : `${options.fps.num}/${options.fps.den}`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    options.input,
    ...(options.offset !== undefined ? ["-ss", String(options.offset)] : []),
    ...(options.duration !== undefined ? ["-t", String(options.duration)] : []),
    "-vf",
    `fps=${rate}`,
    "-an",
    "-q:v",
    "2",
    "-start_number",
    "0",
    "-y",
    `${options.outDir}/%06d.jpg`,
  ];
  await runUntilExit(options.ffmpeg, args, { maxBuffer: 16 << 20, ...(options.signal !== undefined ? { signal: options.signal } : {}) });
  const files = (await readdir(options.outDir)).filter((name) => name.endsWith(".jpg"));
  if (files.length === 0) throw new Error(`nenhum frame extraído de ${options.input}`);
  return { frameCount: files.length, pattern: `${options.outDir}/%06d.jpg` };
}
