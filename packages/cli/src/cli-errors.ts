// FrankFrames — proprietário. Ver LICENSE na raiz.

/** Códigos que o próprio `frankframes` emite fora de render/generate (entram no `docs/reference/diagnostics.md`). */
export const CLI_ERROR_CODES = ["E_VERSION_UNREADABLE", "E_CAPTIONS", "E_TRANSCRIBE", "E_PREPARE"] as const;
export type CliCode = (typeof CLI_ERROR_CODES)[number];

/** Códigos das respostas HTTP do Studio (`studio-server`, export, histórico, mídia, waveform). */
export const STUDIO_ERROR_CODES = [
  "E_STUDIO",
  "E_BODY_INVALID",
  "E_BODY_TOO_LARGE",
  "E_ROOT_NOT_FOUND",
  "E_BLOCK_UNKNOWN",
  "E_CATALOG",
  "E_TEMPLATE_INVALID",
  "E_CONTRACT_INVALID",
  "E_HISTORY_STALE",
  "E_MEDIA_EMPTY",
  "E_MEDIA_TOO_LARGE",
  "E_MEDIA_UNSUPPORTED",
  "E_WAVEFORM_FAILED",
  "E_WAVEFORM_NO_AUDIO",
  "E_WAVEFORM_UNSUPPORTED",
  "E_EXPORT_BUSY",
  "E_EXPORT_EXISTS",
  "E_EXPORT_IDLE",
  "E_EXPORT_NOT_DONE",
  "E_EXPORT_OUTPUT_INVALID",
  "E_REVEAL_FAILED",
] as const;
export type StudioCode = (typeof STUDIO_ERROR_CODES)[number];
