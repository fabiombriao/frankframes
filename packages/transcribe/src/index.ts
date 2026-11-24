// FrankFrames — proprietário. Ver LICENSE na raiz.
export { createOpenAiCompatible } from "./openai.ts";
export type { OpenAiCompatibleConfig } from "./openai.ts";
export { createLocal, installLocalModel } from "./local.ts";
export type { InstallLocalModelOptions, LocalConfig } from "./local.ts";
export { resolveProvider } from "./resolve.ts";
export { TRANSCRIBE_ERROR_CODES, TranscribeError } from "./types.ts";
export type {
  ProviderConfig,
  Segment,
  TranscribeErrorCode,
  Transcriber,
  TranscriptionResult,
  Word,
} from "./types.ts";
