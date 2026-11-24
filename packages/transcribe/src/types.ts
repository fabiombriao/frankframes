// FrankFrames — proprietário. Ver LICENSE na raiz.
export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface Word {
  start: number;
  end: number;
  word: string;
}

export interface TranscriptionResult {
  text: string;
  segments: Segment[];
  words?: Word[];
  provider: string;
}

export interface Transcriber {
  name: string;
  transcribe(file: string, options?: { language?: string }): Promise<TranscriptionResult>;
}

export interface ProviderConfig {
  provider?: "local" | "groq" | "openai-compatible";
  /** Só para `openai-compatible`. */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  language?: string;
}

export const TRANSCRIBE_ERROR_CODES = [
  "E_TRANSCRIBE_UNAVAILABLE",
  "E_WHISPER_MISSING",
  "E_WHISPER_FAILED",
  "E_WHISPER_OUTPUT",
  "E_FFMPEG_MISSING",
  "E_OPENAI_HTTP",
  "E_OPENAI_RESPONSE",
  "E_MODEL_DOWNLOAD",
  "E_MODEL_HASH",
] as const;
export type TranscribeErrorCode = (typeof TRANSCRIBE_ERROR_CODES)[number];

export class TranscribeError extends Error {
  readonly code: TranscribeErrorCode;
  readonly status?: number;

  constructor(code: TranscribeErrorCode, message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TranscribeError";
    this.code = code;
    if (options?.status !== undefined) this.status = options.status;
  }
}
