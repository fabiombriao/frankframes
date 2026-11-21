// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Curvas de easing do motion (docs/contract.md §7b.11). Puro: sem DOM nem I/O. */

export type Bezier = [number, number, number, number];

/** Curvas do CSS, com os pontos canônicos (para avaliação). */
const CSS_CURVES: Record<string, Bezier | null> = {
  linear: null,
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

/** Curvas próprias, em português. */
const OWN_CURVES: Record<string, Bezier> = {
  suave: [0.34, 0.1, 0.18, 1],
  freio: [0.18, 0.72, 0.28, 1],
  arranque: [0.56, 0, 0.84, 0.42],
  vaivem: [0.58, 0.04, 0.3, 0.97],
};

export const CURVE_NAMES = [...Object.keys(CSS_CURVES), ...Object.keys(OWN_CURVES)];

export interface ParsedCurve {
  /** Texto pronto para `easing` do WAAPI. */
  css: string;
  /** `null` = linear. */
  points: Bezier | null;
}

const NUM = "-?\\d+(?:\\.\\d+)?";
const BEZIER = new RegExp(`^cubic-bezier\\((${NUM}),(${NUM}),(${NUM}),(${NUM})\\)$`);

const fmt = (n: number): string => String(Number(n.toFixed(6)));

/**
 * Nome ou `cubic-bezier(a,b,c,d)` sem espaços. `undefined` quando não é curva
 * conhecida; `invalid` separa "não parece curva" de "parece, mas está fora da faixa".
 */
export function parseCurve(text: string): ParsedCurve | undefined {
  return resolveCurve(text).curve;
}

export function resolveCurve(text: string): { curve?: ParsedCurve; reason?: string } {
  if (Object.hasOwn(CSS_CURVES, text)) return { curve: { css: text, points: CSS_CURVES[text] ?? null } };
  if (Object.hasOwn(OWN_CURVES, text)) {
    const points = OWN_CURVES[text]!;
    return { curve: { css: bezierCss(points), points } };
  }
  const match = BEZIER.exec(text);
  if (!match) return { reason: "não é um nome conhecido nem cubic-bezier(x1,y1,x2,y2) sem espaços" };
  const points = match.slice(1, 5).map(Number) as Bezier;
  const [x1, y1, x2, y2] = points;
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return { reason: "x1 e x2 precisam estar em [0,1]" };
  if (y1 < -5 || y1 > 5 || y2 < -5 || y2 > 5) return { reason: "y1 e y2 precisam estar em [-5,5]" };
  return { curve: { css: bezierCss(points), points } };
}

function bezierCss(points: Bezier): string {
  return `cubic-bezier(${points.map(fmt).join(", ")})`;
}

/**
 * Valor da curva em `x` ∈ [0,1], por bissecção de 40 passos sobre o parâmetro da
 * bezier. Sem aleatoriedade e sem tolerância dependente de máquina.
 */
export function evaluateCurve(curve: string, x: number): number {
  const parsed = resolveCurve(curve.replace(/\s+/g, "")).curve;
  if (!parsed) throw new Error(`curva desconhecida: ${curve}`);
  if (parsed.points === null) return x;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = parsed.points;
  const at = (a: number, b: number, t: number): number => 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (at(x1, x2, mid) < x) low = mid;
    else high = mid;
  }
  return at(y1, y2, (low + high) / 2);
}
