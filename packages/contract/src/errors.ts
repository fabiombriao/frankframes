// FrankFrames — proprietário. Ver LICENSE na raiz.
import type { Diagnostic } from "./types.ts";

/**
 * Códigos estáveis. Nunca derivados de mensagem: cliente e agente dependem deles.
 * Prefixo `E_` bloqueia o render; `W_` só avisa.
 */
export const CODES = {
  NO_ROOT: "E_NO_ROOT",
  DUPLICATE_ID: "E_DUPLICATE_ID",
  START_INVALID: "E_START_INVALID",
  REF_UNKNOWN: "E_REF_UNKNOWN",
  REF_CYCLE: "E_REF_CYCLE",
  REF_UNRESOLVED: "E_REF_UNRESOLVED",
  DURATION_INVALID: "E_DURATION_INVALID",
  OFFSET_INVALID: "E_OFFSET_INVALID",
  FADE_INVALID: "E_FADE_INVALID",
  DURATION_UNRESOLVED: "E_DURATION_UNRESOLVED",
  FPS_INVALID: "E_FPS_INVALID",
  SIZE_INVALID: "E_SIZE_INVALID",
  ROOT_START_IGNORED: "W_ROOT_START_IGNORED",
  TRACK_INVALID: "W_TRACK_INVALID",
  START_NEGATIVE: "W_START_NEGATIVE",
  RATE_CLAMPED: "W_RATE_CLAMPED",
  VOLUME_CLAMPED: "W_VOLUME_CLAMPED",
} as const;

export type Code = (typeof CODES)[keyof typeof CODES];

export function diag(
  code: string,
  severity: Diagnostic["severity"],
  message: string,
  extra: { hint?: string; clipId?: string } = {},
): Diagnostic {
  const d: Diagnostic = { code, severity, message };
  if (extra.hint) d.hint = extra.hint;
  if (extra.clipId) d.clipId = extra.clipId;
  return d;
}
