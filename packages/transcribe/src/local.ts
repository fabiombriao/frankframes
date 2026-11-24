// FrankFrames — proprietário. Ver LICENSE na raiz.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
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

function offsetMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Converte o JSON do `whisper.cpp` (`-oj`) em texto, segmentos e palavras.
 * `offsets` vêm em milissegundos; o resultado usa segundos.
 */
export function parseWhisperJson(raw: string): { text: string; segments: Segment[]; words?: Word[] } {
  let parsed: WhisperJson;
  try {
    parsed = JSON.parse(raw) as WhisperJson;
  } catch (error) {
    throw new TranscribeError("E_WHISPER_OUTPUT", "whisper.cpp gerou JSON inválido.", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.transcription)) {
    throw new TranscribeError("E_WHISPER_OUTPUT", 'JSON do whisper.cpp sem a lista "transcription".');
  }

  const entries = parsed.transcription as (WhisperEntry | null)[];
  const segments: Segment[] = [];
  const words: Word[] = [];
  let complete = true;
  for (const entry of entries) {
    const text = String(entry?.text ?? "").trim();
    if (!text) continue;
    const from = offsetMilliseconds(entry?.offsets?.from);
    const to = offsetMilliseconds(entry?.offsets?.to);
    const start = from === undefined ? 0 : from / 1000;
    const end = to === undefined ? 0 : to / 1000;
    segments.push({ start, end, text });
    if (from === undefined || to === undefined) complete = false;
    else words.push({ start, end, word: text });
  }

  const fallback = typeof parsed.result?.text === "string" ? parsed.result.text.trim() : "";
  const result: { text: string; segments: Segment[]; words?: Word[] } = {
    text: segments.map((segment) => segment.text).join(" ").trim() || fallback,
    segments,
  };
  if (complete && words.length > 0) result.words = words;
  return result;
}

/**
 * Remove um temporário sem trocar o erro (ou o resultado) de quem chama: a falha vai ao stderr com o caminho.
 * Cópia local do `removeOrWarn` do engine, porque este pacote não depende do engine.
 */
async function removeOrWarn(path: string, options: { recursive?: boolean } = {}): Promise<void> {
  try {
    await rm(path, { recursive: options.recursive ?? false });
  } catch (error) {
    process.stderr.write(`[frankframes] não consegui remover ${path}: ${error instanceof Error ? error.message : String(error)}
`);
  }
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

        let raw: string;
        try {
          raw = await readFile(`${outputBase}.json`, "utf8");
        } catch (error) {
          throw new TranscribeError("E_WHISPER_FAILED", "whisper.cpp não gerou JSON de transcrição.", { cause: error });
        }

        const parsed = parseWhisperJson(raw);
        const result: TranscriptionResult = {
          text: parsed.text,
          segments: parsed.segments,
          provider: "local",
        };
        if (parsed.words) result.words = parsed.words;
        return result;
      } finally {
        // A transcrição já está pronta (ou o erro do corpo sobe): falha ao remover o diretório só avisa no stderr.
        await removeOrWarn(dir, { recursive: true });
      }
    },
  };
}

/**
 * Único caminho que baixa o modelo. Streaming para arquivo temporário, SHA-256
 * conferido antes do rename — em caso de hash errado o destino nunca aparece.
 */
export interface InstallLocalModelOptions {
  modelUrl: string;
  destPath: string;
  expectedSha256?: string;
  onProgress?: (info: { bytes: number; total?: number }) => void;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function fileSize(path: string): Promise<number> {
  return stat(path).then((info) => info.size).catch(() => 0);
}

/**
 * Baixa o modelo com retomada (Range sobre `.part`), verifica o SHA-256 antes
 * de publicar e nunca chama a rede quando o destino já está íntegro.
 */
export async function installLocalModel(options: InstallLocalModelOptions): Promise<{
  path: string;
  bytes: number;
  sha256: string;
  resumed: boolean;
}> {
  await mkdir(dirname(options.destPath), { recursive: true });
  const partPath = `${options.destPath}.part`;

  if (await fileSize(options.destPath) > 0) {
    const digest = await sha256File(options.destPath);
    if (options.expectedSha256 === undefined || digest.toLowerCase() === options.expectedSha256.toLowerCase()) {
      return { path: options.destPath, bytes: await fileSize(options.destPath), sha256: digest, resumed: false };
    }
    // O destino existe (fileSize > 0) e está corrompido: sem force. Se não sair, o erro sobe antes de baixar de novo.
    await rm(options.destPath);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const offset = await fileSize(partPath);
    let response: Response;
    try {
      response = await fetch(options.modelUrl, offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {});
    } catch (error) {
      if (attempt === 1) throw new TranscribeError("E_MODEL_DOWNLOAD", `Falha ao baixar ${options.modelUrl}.`, { cause: error });
      continue;
    }

    if (response.status === 416) break; // já temos tudo
    if (!response.ok || response.body === null) {
      throw new TranscribeError(
        "E_MODEL_DOWNLOAD",
        `Download do modelo falhou (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`,
        { status: response.status },
      );
    }

    const append = response.status === 206 && offset > 0;
    let written = append ? offset : 0;
    const handle = await open(partPath, append ? "a" : "w");
    try {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const buffer = Buffer.from(value);
          written += buffer.byteLength;
          await handle.write(buffer);
          options.onProgress?.({ bytes: written });
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (attempt === 1) {
        throw new TranscribeError("E_MODEL_DOWNLOAD", `Falha ao gravar o modelo em ${options.destPath}.`, { cause: error });
      }
      continue;
    } finally {
      await handle.close();
    }
    break;
  }

  const digest = await sha256File(partPath);
  if (options.expectedSha256 !== undefined && digest.toLowerCase() !== options.expectedSha256.toLowerCase()) {
    // O `.part` acabou de ser lido: existe. Falha de remoção vai ao stderr e não troca o E_MODEL_HASH.
    await removeOrWarn(partPath);
    throw new TranscribeError(
      "E_MODEL_HASH",
      `SHA-256 do modelo não confere: esperado ${options.expectedSha256}, obtido ${digest}.`,
    );
  }

  try {
    await rename(partPath, options.destPath);
  } catch {
    // Rename sobre destino existente falha em alguns SO: apaga o destino e tenta de novo (o segundo rename falha alto).
    // force:true: o primeiro rename pode ter falhado por outro motivo, com o destino ausente (ENOENT esperado).
    await rm(options.destPath, { force: true });
    await rename(partPath, options.destPath);
  }

  return {
    path: options.destPath,
    bytes: await fileSize(options.destPath),
    sha256: digest,
    resumed: false,
  };
}
