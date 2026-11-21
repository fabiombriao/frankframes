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

/** Molas nomeadas: ζ (amortecimento) e ω (rad/s). */
const SPRING_CURVES: Record<string, [number, number]> = {
  mola: [0.45, 18],
  "mola-firme": [0.7, 14],
};

export const CURVE_NAMES = [...Object.keys(CSS_CURVES), ...Object.keys(OWN_CURVES), ...Object.keys(SPRING_CURVES)];

export interface Spring {
  /** Razão de amortecimento, em [0.05,1]. */
  zeta: number;
  /** Frequência natural, rad/s, em [1,100]. */
  omega: number;
}

export interface ParsedCurve {
  /** Texto canônico da curva; para bezier é o `easing` do WAAPI. Para mola é `spring(ζ, ω)`. */
  css: string;
  /** `null` = linear (ou mola, que não tem bezier). */
  points: Bezier | null;
  /** Presente quando a curva é uma mola: o easing só existe depois de conhecer a duração do trecho. */
  spring?: Spring;
}

const NUM = "-?\\d+(?:\\.\\d+)?";
const BEZIER = new RegExp(`^cubic-bezier\\((${NUM}),(${NUM}),(${NUM}),(${NUM})\\)$`);
const SPRING = new RegExp(`^spring\\((${NUM}),(${NUM})\\)$`);

const fmt = (n: number): string => String(Number(n.toFixed(6)));

/** Amostras do `linear()` emitido para a mola e precisão de cada uma. */
const SPRING_SAMPLES = 64;
const SPRING_DECIMALS = 4;
/** Resíduo máximo do envelope da mola ao fim do trecho (1%). */
const SETTLE_TOLERANCE = 0.01;

/**
 * Nome, `cubic-bezier(a,b,c,d)` ou `spring(ζ,ω)` sem espaços. `undefined` quando não é
 * curva conhecida; `resolveCurve` separa "não parece curva" de "parece, mas está fora da faixa".
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
  if (Object.hasOwn(SPRING_CURVES, text)) {
    const [zeta, omega] = SPRING_CURVES[text]!;
    return { curve: springCurve(zeta, omega) };
  }
  const spring = SPRING.exec(text);
  if (spring) {
    const zeta = Number(spring[1]);
    const omega = Number(spring[2]);
    if (zeta < 0.05 || zeta > 1) return { reason: "ζ (amortecimento) precisa estar em [0.05,1]" };
    if (omega < 1 || omega > 100) return { reason: "ω (frequência, rad/s) precisa estar em [1,100]" };
    return { curve: springCurve(zeta, omega) };
  }
  const match = BEZIER.exec(text);
  if (!match) return { reason: "não é um nome conhecido, cubic-bezier(x1,y1,x2,y2) nem spring(ζ,ω), sem espaços" };
  const points = match.slice(1, 5).map(Number) as Bezier;
  const [x1, y1, x2, y2] = points;
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return { reason: "x1 e x2 precisam estar em [0,1]" };
  if (y1 < -5 || y1 > 5 || y2 < -5 || y2 > 5) return { reason: "y1 e y2 precisam estar em [-5,5]" };
  return { curve: { css: bezierCss(points), points } };
}

function bezierCss(points: Bezier): string {
  return `cubic-bezier(${points.map(fmt).join(", ")})`;
}

function springCurve(zeta: number, omega: number): ParsedCurve {
  return { css: `spring(${fmt(zeta)}, ${fmt(omega)})`, points: null, spring: { zeta, omega } };
}

/** Resposta ao degrau da mola em τ segundos (função fechada, sem simulação). */
function springAt({ zeta, omega }: Spring, tau: number): number {
  if (zeta >= 1) return 1 - Math.exp(-omega * tau) * (1 + omega * tau);
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * tau) * (Math.cos(damped * tau) + ((zeta * omega) / damped) * Math.sin(damped * tau));
}

/**
 * Menor duração, em segundos, em que a mola assenta (envelope ≤ 1%), arredondada para
 * cima em 0.01. Com ζ < 1 o envelope é `e^(−ζωτ)/√(1−ζ²)`; com ζ = 1, `e^(−ωτ)(1+ωτ)`.
 */
export function springSettleSeconds(spring: Spring): number {
  const { zeta, omega } = spring;
  let seconds: number;
  if (zeta < 1) {
    seconds = -Math.log(SETTLE_TOLERANCE * Math.sqrt(1 - zeta * zeta)) / (zeta * omega);
  } else {
    // (1+u)e^(−u) decresce em u: bissecção determinística sobre u = ω·τ.
    let low = 0;
    let high = 50;
    for (let i = 0; i < 60; i++) {
      const mid = (low + high) / 2;
      if ((1 + mid) * Math.exp(-mid) > SETTLE_TOLERANCE) low = mid;
      else high = mid;
    }
    seconds = high / omega;
  }
  return Math.ceil(Number((seconds * 100).toFixed(9))) / 100;
}

/**
 * Easing do WAAPI para um trecho de `dur` segundos. Bezier e nomes CSS saem como texto; a mola
 * vira `linear(v0, ..., v63)` porque o formato depende da duração. `null` se a mola não assenta
 * em `dur`: quem chama emite `E_CURVE_INVALID` com `springSettleSeconds`.
 */
export function emitEasing(curve: ParsedCurve, dur: number): string | null {
  if (curve.spring === undefined) return curve.css;
  if (dur + 1e-9 < springSettleSeconds(curve.spring)) return null;
  const values: number[] = [];
  for (let i = 0; i < SPRING_SAMPLES; i++) {
    const p = i / (SPRING_SAMPLES - 1);
    const v = i === 0 ? 0 : i === SPRING_SAMPLES - 1 ? 1 : springAt(curve.spring, p * dur);
    values.push(Number(v.toFixed(SPRING_DECIMALS)));
  }
  return `linear(${values.join(", ")})`;
}

/**
 * Valor da curva em `x` ∈ [0,1], por bissecção de 40 passos sobre o parâmetro da
 * bezier. Sem aleatoriedade e sem tolerância dependente de máquina. A mola depende da
 * duração do trecho (`dur`, segundos; padrão 1): τ = x·dur.
 */
export function evaluateCurve(curve: string, x: number, dur = 1): number {
  const parsed = resolveCurve(curve.replace(/\s+/g, "")).curve;
  if (!parsed) throw new Error(`curva desconhecida: ${curve}`);
  if (parsed.spring !== undefined) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return springAt(parsed.spring, x * dur);
  }
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
