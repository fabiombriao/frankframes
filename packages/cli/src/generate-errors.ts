// FrankFrames — proprietário. Ver LICENSE na raiz.

/** Códigos que encerram o `generate` (entram no `docs/generate.md`). */
export const GENERATE_ERROR_CODES = [
  "E_CODEX_MISSING",
  "E_CODEX_AUTH",
  "E_CODEX_FAILED",
  "E_CODEX_TIMEOUT",
  "E_CODEX_OUTPUT",
  "E_GEN_REQUEST_INVALID",
  "E_GEN_OUT_EXISTS",
  "E_GEN_EXHAUSTED",
] as const;
export type GenerateCode = (typeof GENERATE_ERROR_CODES)[number];

/** Diagnósticos de reparo: não encerram o comando, voltam ao agente na tentativa seguinte. */
export const GENERATE_REPAIR_CODES = ["E_GEN_FORBIDDEN", "E_GEN_FORMAT_MISMATCH", "E_GEN_DURATION_MISMATCH", "W_GEN_FRAME_BLANK", "E_CODEX_OUTPUT"] as const;

/** Diagnóstico de uma tentativa (mesma forma do `lint --json`, para o agente ler um só formato). */
export interface GenerateDiagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  hint?: string;
  clipId?: string;
}

/** Falha do `generate`, com código estável e dica acionável. */
export class GenerateError extends Error {
  readonly code: GenerateCode;
  readonly hint: string;
  /** Presente em `E_GEN_EXHAUSTED`: o histórico das tentativas, igual ao do `generate.json`. */
  readonly attempts: unknown[] | undefined;

  constructor(code: GenerateCode, message: string, hint: string, attempts?: unknown[]) {
    super(message);
    this.name = "GenerateError";
    this.code = code;
    this.hint = hint;
    this.attempts = attempts;
  }
}
