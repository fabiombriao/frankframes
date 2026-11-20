// FrankFrames — proprietário. Ver LICENSE na raiz.
import type { TimeExpr } from "./types.ts";

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const IDENT = /^[A-Za-z0-9_.:-]+$/;
const REFERENCE = /^([A-Za-z0-9_.:-]+)\s*([+-])\s*(\d+(?:\.\d+)?)$/;

/**
 * Gramática de `data-start`:
 *   1. vazio/ausente  -> absoluto em `defaultSeconds`
 *   2. número         -> absoluto
 *   3. identificador  -> referência ao FIM do clip referenciado
 *   4. id + n / id - n -> FIM do clip referenciado, deslocado
 * Qualquer outra forma é `null` (erro de contrato, não fallback silencioso).
 */
export function parseTimeExpr(raw: string | undefined, defaultSeconds = 0): TimeExpr | null {
  const value = (raw ?? "").trim();
  if (value === "") return { kind: "absolute", value: defaultSeconds };

  if (NUMBER.test(value)) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return { kind: "absolute", value: n };
  }

  const ref = REFERENCE.exec(value);
  if (ref) {
    const magnitude = Number(ref[3]);
    return { kind: "reference", refId: ref[1]!, offset: ref[2] === "+" ? magnitude : -magnitude };
  }

  if (IDENT.test(value)) return { kind: "reference", refId: value, offset: 0 };

  return null;
}

/** `data-fps`: "30", "60", "30000/1001". Decimal ambíguo (29.97) é recusado. */
export function parseFps(raw: string | undefined, fallback: { num: number; den: number }): { num: number; den: number } | null {
  const value = (raw ?? "").trim();
  if (value === "") return fallback;

  const rational = /^(\d+)\/(\d+)$/.exec(value);
  if (rational) {
    const num = Number(rational[1]);
    const den = Number(rational[2]);
    if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) return null;
    return { num, den };
  }

  if (/^\d+$/.test(value)) {
    const num = Number(value);
    if (num <= 0 || num > 240) return null;
    return { num, den: 1 };
  }

  return null;
}
