// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Gramática do valor de `data-enter`/`data-exit`/... (docs/contract.md §7b.4). */

export type ParsedValue =
  | { ok: true; preset: string; params: Record<string, string> }
  | { ok: false; message: string };

const PRESET = /^[a-z][a-z0-9-]*$/;
const KEY = /^[a-z]+$/;

/** `preset chave=valor ...`. Espaços nas pontas são ignorados; chave repetida é erro. */
export function parseMotionValue(raw: string): ParsedValue {
  const tokens = raw.trim().split(/\s+/).filter((token) => token !== "");
  if (tokens.length === 0) return { ok: false, message: "valor vazio" };
  const preset = tokens[0]!;
  if (!PRESET.test(preset)) return { ok: false, message: `preset inválido: ${JSON.stringify(preset)}` };

  const params: Record<string, string> = {};
  for (const token of tokens.slice(1)) {
    const at = token.indexOf("=");
    if (at < 0) return { ok: false, message: `parâmetro sem "=": ${JSON.stringify(token)}` };
    const key = token.slice(0, at);
    const value = token.slice(at + 1);
    if (!KEY.test(key)) return { ok: false, message: `nome de parâmetro inválido: ${JSON.stringify(key)}` };
    if (value === "" || value.includes("=")) return { ok: false, message: `valor inválido em ${key}: ${JSON.stringify(value)}` };
    if (Object.hasOwn(params, key)) return { ok: false, message: `parâmetro repetido: ${key}` };
    params[key] = value;
  }
  return { ok: true, preset, params };
}

const SECONDS = "\\d+(?:\\.\\d+)?";

export type Anchor =
  | { kind: "seconds"; value: number }
  | { kind: "percent"; value: number }
  | { kind: "end"; before: number };

/** `n`, `-n`, `p%`, `end`, `end-n`. `null` quando não é âncora. */
export function parseAnchor(text: string): Anchor | null {
  if (text === "end") return { kind: "end", before: 0 };
  let m = new RegExp(`^end-(${SECONDS})$`).exec(text);
  if (m) return { kind: "end", before: Number(m[1]) };
  m = new RegExp(`^(${SECONDS})%$`).exec(text);
  if (m) return { kind: "percent", value: Number(m[1]) };
  m = new RegExp(`^(-?${SECONDS})$`).exec(text);
  if (m) return { kind: "seconds", value: Number(m[1]) };
  return null;
}

/** Segundos positivos (`dur`). */
export function parseSeconds(text: string): number | null {
  return new RegExp(`^${SECONDS}$`).test(text) ? Number(text) : null;
}

/** Número decimal com sinal opcional. */
export function parseNumber(text: string): number | null {
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
}
