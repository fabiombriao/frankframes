// FrankFrames — proprietário. Ver LICENSE na raiz.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TranscribeError } from "./types.ts";
import type { Segment, Transcriber, TranscriptionResult, Word } from "./types.ts";

export interface LocalConfig {
  whisperBin: string;
  modelPath: string;
  /** Opcional: converte a entrada para WAV 16 kHz mono antes do whisper.cpp. */
  ffmpeg?: string;
}

export interface InstallLocalModelOptions {
  modelUrl: string;
  destPath: string;
  expectedSha256?: string;
}

interface WhisperEntry {
  offsets?: { from?: unknown; to?: unknown };
  text?: unknown;
}

interface WhisperJson {
  transcription?: unknown;
  result?: { text?: unknown };
}

function run(bin: string, args: string[]): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile(bin, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error) => {
    if (error) reject(error);
    else resolve();
  });
  return promise;
}

function isMissingBinary(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function milliseconds(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n / 1000 : 0;
}

function convert(entries: WhisperEntry[]): { segments: Segment[]; words: Word[] } {
  const segments: Segment[] = [];
  const words: Word[] = [];
  for (const entry of entries) {
    const text = String(entry.text ?? "").trim();
    if (!text) continue;
    const start = milliseconds(entry.offsets?.from);
    const end = milliseconds(entry.offsets?.to);
    segments.push({ start, end, text });
    words.push({ start, end, word: text });
  }
  return { segments, words };
}

/** Roda `whisper.cpp` como processo, sem rede e sem modelo embutido. */
export function createLocal(config: LocalConfig): Transcriber {
  return {
    name: "local",
    async transcribe(file, options): Promise<TranscriptionResult> {
      const dir = await mkdtemp(join(tmpdir(), "ff-whisper-"));
      try {
        let input = file;
        if (config.ffmpeg) {
          input = join(dir, "input.wav");
          try {
            await run(config.ffmpeg, ["-y", "-i", file, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", input]);
          } catch (error) {
            if (isMissingBinary(error)) {
              throw new TranscribeError("E_FFMPEG_MISSING", `FFmpeg não encontrado em ${config.ffmpeg}.`, { cause: error });
            }
            throw new TranscribeError("E_WHISPER_FAILED", `FFmpeg falhou ao preparar ${file}.`, { cause: error });
          }
        }

        const outputBase = join(dir, "transcription");
        const args = ["-m", config.modelPath, "-f", input, "-oj", "-of", outputBase];
        if (options?.language) args.push("-l", options.language);

        try {
          await run(config.whisperBin, args);
        } catch (error) {
          if (isMissingBinary(error)) {
            throw new TranscribeError(
              "E_WHISPER_MISSING",
              `whisper.cpp não encontrado em ${config.whisperBin}. Instale com "frankframes models install whisper-large-v3-turbo".`,
              { cause: error },
            );
          }
          throw new TranscribeError("E_WHISPER_FAILED", `whisper.cpp falhou ao transcrever ${file}.`, { cause: error });
        }

        let raw: WhisperJson;
        try {
          raw = JSON.parse(await readFile(`${outputBase}.json`, "utf8")) as WhisperJson;
        } catch (error) {
          throw new TranscribeError("E_WHISPER_FAILED", "whisper.cpp não gerou JSON de transcrição.", { cause: error });
        }

        const entries = Array.isArray(raw.transcription) ? (raw.transcription as WhisperEntry[]) : [];
        const { segments, words } = convert(entries);
        const fallback = typeof raw.result?.text === "string" ? raw.result.text.trim() : "";

        const result: TranscriptionResult = {
          text: segments.map((segment) => segment.text).join(" ").trim() || fallback,
          segments,
          provider: "local",
        };
        if (words.length > 0) result.words = words;
        return result;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Único caminho que baixa o modelo. Streaming para arquivo temporário, SHA-256
 * conferido antes do rename — em caso de hash errado o destino nunca aparece.
 */
export async function installLocalModel(options: InstallLocalModelOptions): Promise<{ path: string; bytes: number }> {
  let response: Response;
  try {
    response = await fetch(options.modelUrl);
  } catch (error) {
    throw new TranscribeError("E_MODEL_DOWNLOAD", `Falha ao baixar ${options.modelUrl}.`, { cause: error });
  }

  const body = response.body;
  if (!response.ok || !body) {
    throw new TranscribeError(
      "E_MODEL_DOWNLOAD",
      `Download do modelo falhou (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`,
      { status: response.status },
    );
  }

  await mkdir(dirname(options.destPath), { recursive: true });
  const tmpPath = `${options.destPath}.${process.pid}.${Date.now()}.tmp`;
  const hash = createHash("sha256");
  let bytes = 0;

  try {
    const handle = await open(tmpPath, "w");
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = Buffer.from(value);
        hash.update(buffer);
        bytes += buffer.byteLength;
        await handle.write(buffer);
      }
    } finally {
      reader.releaseLock();
      await handle.close();
    }
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw new TranscribeError("E_MODEL_DOWNLOAD", `Falha ao gravar o modelo em ${options.destPath}.`, { cause: error });
  }

  const digest = hash.digest("hex");
  if (options.expectedSha256 && digest.toLowerCase() !== options.expectedSha256.toLowerCase()) {
    await rm(tmpPath, { force: true });
    throw new TranscribeError(
      "E_MODEL_HASH",
      `SHA-256 do modelo não confere: esperado ${options.expectedSha256}, obtido ${digest}.`,
    );
  }

  try {
    await rename(tmpPath, options.destPath);
  } catch {
    // Windows não sobrescreve via rename.
    await rm(options.destPath, { force: true });
    await rename(tmpPath, options.destPath);
  }

  return { path: options.destPath, bytes };
}
