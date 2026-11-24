// FrankFrames — proprietário. Ver LICENSE na raiz.

/** Códigos que o próprio `frankframes` emite fora de render/generate (entram no `docs/reference/diagnostics.md`). */
export const CLI_ERROR_CODES = ["E_VERSION_UNREADABLE"] as const;
export type CliCode = (typeof CLI_ERROR_CODES)[number];
