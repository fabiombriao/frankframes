// FrankFrames — proprietário. Ver LICENSE na raiz.
import type { Diagnostic } from "@frankframes/contract";

/** Códigos que podem sair em `render --json`. Allowlist: nunca derivado da mensagem. */
export const RENDER_ERROR_CODES = ["E_CONTRACT", "E_MEDIA_PROBE", "E_DURATION", "E_MOTION_RUNTIME", "E_FONT_LOAD", "E_INTERNAL"] as const;
export type RenderCode = (typeof RENDER_ERROR_CODES)[number];

export interface ErrorPayload {
  ok: false;
  code: RenderCode;
  stage: string | null;
  /** Mensagem sem caminho absoluto nem URL — seguro para log de cliente. */
  message: string;
  diagnostics: Array<{ code: string; severity: string; clipId: string | null }>;
}

/** Remove caminhos absolutos (Windows e POSIX) de uma mensagem. */
export function sanitizeMessage(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<arquivo>")
    .replace(/(?<![\w<])\/(?:[^\s"'/]+\/)+[^\s"',)]*/g, "<arquivo>")
    .replace(/https?:\/\/[^\s"']+/g, "<url>");
}

export function toErrorPayload(error: unknown): ErrorPayload {
  const candidate = error as { code?: string; stage?: string; message?: string; diagnostics?: Diagnostic[] };
  const code = RENDER_ERROR_CODES.includes(candidate.code as RenderCode) ? (candidate.code as RenderCode) : "E_INTERNAL";
  return {
    ok: false,
    code,
    stage: typeof candidate.stage === "string" ? candidate.stage : null,
    message: sanitizeMessage(candidate.message ?? String(error)),
    diagnostics: (candidate.diagnostics ?? []).map((item) => ({
      code: item.code,
      severity: item.severity,
      clipId: item.clipId ?? null,
    })),
  };
}
