// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Propriedades CSS do motion e fusão de trechos em trilhas (docs/contract.md §7b.6, §7b.12). */
import type { MotionKey, MotionProp, MotionTarget, MotionTrack, MotionValue, VisualKeyframe } from "../types.ts";
import { emitEasing, evaluateCurve, resolveCurve, springSettleSeconds } from "./curves.ts";

/** Propriedades personalizadas que o runtime registra (`inherits:false`). Fonte única: o engine lê esta lista. */
export const MOTION_PROPERTIES: ReadonlyArray<{ name: string; syntax: string; initial: string }> = [
  { name: "--ff-x", syntax: "<length-percentage>", initial: "0px" },
  { name: "--ff-y", syntax: "<length-percentage>", initial: "0px" },
  { name: "--ff-sx", syntax: "<number>", initial: "1" },
  { name: "--ff-sy", syntax: "<number>", initial: "1" },
  { name: "--ff-rot", syntax: "<angle>", initial: "0deg" },
  { name: "--ff-blur", syntax: "<length>", initial: "0px" },
  // Câmera (§7b.9): zoom ≥ 1 e foco em [0,1] dentro da imagem.
  { name: "--ff-zoom", syntax: "<number>", initial: "1" },
  { name: "--ff-fx", syntax: "<number>", initial: "0.5" },
  { name: "--ff-fy", syntax: "<number>", initial: "0.5" },
];

/** Propriedade CSS que o motion passa a possuir, por propriedade animada. */
export const OWNED_BY_PROP: Readonly<Record<string, string>> = {
  opacity: "opacity",
  "--ff-x": "translate",
  "--ff-y": "translate",
  "--ff-sx": "scale",
  "--ff-sy": "scale",
  "--ff-rot": "rotate",
  "--ff-blur": "filter",
  "clip-path": "clip-path",
  "--ff-zoom": "object-view-box",
  "--ff-fx": "object-view-box",
  "--ff-fy": "object-view-box",
};

/**
 * Recorte da câmera: `m` = 100% − 100%/zoom é a parte da imagem que fica de fora; o foco reparte
 * `m` entre os lados (fx = 0 mostra a borda esquerda, fx = 1 a direita). Escrito sem variável
 * intermediária: o Chrome reavalia `calc()` com `var()` registrada a cada frame.
 */
const CAMERA_M = "(100% - 100% / var(--ff-zoom))";
const CAMERA_VIEW_BOX =
  `inset(calc(var(--ff-fy) * ${CAMERA_M}) calc((1 - var(--ff-fx)) * ${CAMERA_M}) ` +
  `calc((1 - var(--ff-fy)) * ${CAMERA_M}) calc(var(--ff-fx) * ${CAMERA_M}))`;

/** Ligação de cada propriedade possuída às variáveis, na ordem em que entram no `style`. */
const BINDINGS: ReadonlyArray<{ css: string; value: string; uses: string[] }> = [
  { css: "translate", value: "var(--ff-x) var(--ff-y)", uses: ["--ff-x", "--ff-y"] },
  { css: "scale", value: "var(--ff-sx) var(--ff-sy)", uses: ["--ff-sx", "--ff-sy"] },
  { css: "rotate", value: "var(--ff-rot)", uses: ["--ff-rot"] },
  { css: "filter", value: "blur(var(--ff-blur))", uses: ["--ff-blur"] },
  { css: "object-view-box", value: CAMERA_VIEW_BOX, uses: ["--ff-zoom", "--ff-fx", "--ff-fy"] },
];

/** Declarações de ligação que o alvo precisa, dadas as propriedades animadas. */
export function bindingsFor(props: Iterable<string>): Array<[string, string]> {
  const used = new Set(props);
  return BINDINGS.filter((b) => b.uses.some((u) => used.has(u))).map((b) => [b.css, b.value]);
}

/** Propriedades CSS possuídas pelo alvo, sem repetição, na ordem de aparição. */
export function ownedProperties(props: Iterable<string>): string[] {
  const out: string[] = [];
  for (const prop of props) {
    const owned = OWNED_BY_PROP[prop];
    if (owned !== undefined && !out.includes(owned)) out.push(owned);
  }
  return out;
}

export interface Segment {
  /** Segundos locais ao clip dono. */
  start: number;
  duration: number;
  keys: MotionKey[];
}

/** Propriedade CSS animada por cada propriedade de `data-keyframes` (§7b.6). */
export const CSS_PROP_OF: Readonly<Record<MotionProp, string>> = {
  opacity: "opacity",
  x: "--ff-x",
  y: "--ff-y",
  scaleX: "--ff-sx",
  scaleY: "--ff-sy",
  rotate: "--ff-rot",
  blur: "--ff-blur",
  clip: "clip-path",
  zoom: "--ff-zoom",
  focusX: "--ff-fx",
  focusY: "--ff-fy",
};

/** Ordem canônica das trilhas de keyframes. */
const KEYFRAME_PROPS = Object.keys(CSS_PROP_OF) as MotionProp[];

/** Trecho de mola que não assenta: quem chama emite `E_CURVE_INVALID` com o mínimo. */
export interface SpringFailure {
  prop: MotionProp;
  /** Início do trecho (segundos locais ao clip) e duração dele. */
  time: number;
  duration: number;
  /** Menor duração em que a mola assenta, em segundos. */
  minimum: number;
}

/**
 * Um trecho por propriedade a partir dos pontos de `data-keyframes` (§7b.7). O trecho vai do
 * primeiro ao último ponto que tem a propriedade; cada chave leva o easing da curva do ponto de
 * partida, emitido para a duração do trecho entre ela e a próxima chave daquela propriedade.
 * Ponto único vira trilha constante: duração 0 e uma só chave.
 */
export function keyframeSegments(keyframes: VisualKeyframe[]): {
  segments: Array<{ prop: string; segment: Segment }>;
  failures: SpringFailure[];
} {
  const segments: Array<{ prop: string; segment: Segment }> = [];
  const failures: SpringFailure[] = [];
  for (const prop of KEYFRAME_PROPS) {
    const points = keyframes.filter((k) => k.values[prop] !== undefined).sort((a, b) => a.time - b.time);
    if (points.length === 0) continue;
    const first = points[0]!;
    const last = points.at(-1)!;
    const total = last.time - first.time;
    const keys: MotionKey[] = [];
    for (const [index, point] of points.entries()) {
      const value = point.values[prop]!;
      const next = points[index + 1];
      let easing: string | null = null;
      if (next !== undefined) {
        const curve = resolveCurve(point.curve).curve!; // validada em parseKeyframes
        const duration = next.time - point.time;
        easing = emitEasing(curve, duration);
        if (easing === null) {
          failures.push({ prop, time: point.time, duration: round6(duration), minimum: springSettleSeconds(curve.spring!) });
        }
      }
      keys.push({ offset: total <= 0 ? 0 : round6((point.time - first.time) / total), value, easing });
    }
    segments.push({ prop: CSS_PROP_OF[prop], segment: { start: first.time, duration: total, keys } });
  }
  return { segments, failures };
}

const LINEAR_LIST = /^linear\((.*)\)$/;
const NUMBER_PART = /^-?\d+(?:\.\d+)?$/;
const UNIT_VALUE = /^(-?\d+(?:\.\d+)?)%$/;

/** Progresso eased de `p` ∈ [0,1]: `linear(v0, ..., vN)` por partes (a mola emitida), bezier e nomes por `evaluateCurve`. */
function easeProgress(easing: string | null, p: number): number {
  if (easing === null) return p;
  const list = LINEAR_LIST.exec(easing);
  if (list === null) return evaluateCurve(easing, p);
  const values = list[1]!.split(",").map((part) => part.trim());
  if (values.length < 2 || !values.every((part) => NUMBER_PART.test(part))) {
    throw new Error(`easing não amostrável: ${easing}`);
  }
  const numbers = values.map(Number);
  const at = p * (numbers.length - 1);
  const index = Math.min(Math.floor(at), numbers.length - 2);
  return numbers[index]! + (numbers[index + 1]! - numbers[index]!) * (at - index);
}

const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;
const clean = (n: number): number => Number(n.toFixed(6));

/** Texto `"10%"` ou `inset(...)`/`circle(...)` em lista de números, para interpolar; `null` se não casa. */
function percentParts(text: string): { shape: string; numbers: number[] } | null {
  const percent = UNIT_VALUE.exec(text);
  if (percent !== null) return { shape: "%", numbers: [Number(percent[1])] };
  const inset = /^inset\((-?\d+(?:\.\d+)?)% (-?\d+(?:\.\d+)?)% (-?\d+(?:\.\d+)?)% (-?\d+(?:\.\d+)?)%\)$/.exec(text);
  if (inset !== null) return { shape: "inset", numbers: inset.slice(1, 5).map(Number) };
  const circle = /^circle\((-?\d+(?:\.\d+)?)% at (-?\d+(?:\.\d+)?)% (-?\d+(?:\.\d+)?)%\)$/.exec(text);
  if (circle !== null) return { shape: "circle", numbers: circle.slice(1, 4).map(Number) };
  return null;
}

function formatParts(shape: string, numbers: number[]): string {
  const n = numbers.map(clean);
  if (shape === "%") return `${n[0]}%`;
  if (shape === "inset") return `inset(${n[0]}% ${n[1]}% ${n[2]}% ${n[3]}%)`;
  return `circle(${n[0]}% at ${n[1]}% ${n[2]}%)`;
}

/**
 * Valor entre duas chaves. Números e porcentagens (`"10%"`, `inset(...)`, `circle(...)`) interpolam; unidades
 * misturadas (número em px contra `"%"`) o navegador resolve por `calc()`, que aqui não existe: o valor de
 * partida vale até o fim do trecho e o de chegada depois (o ponto exato do degrau só importa ao conferir a
 * mistura; quem escreve `data-keyframes` pelo Studio usa a mesma unidade nos dois lados).
 */
function mix(a: MotionValue, b: MotionValue, p: number): MotionValue {
  if (typeof a === "number" && typeof b === "number") return clean(lerp(a, b, p));
  if (typeof a === "string" && typeof b === "string") {
    const left = percentParts(a);
    const right = percentParts(b);
    if (left !== null && right !== null && left.shape === right.shape) {
      return formatParts(left.shape, left.numbers.map((n, i) => lerp(n, right.numbers[i]!, p)));
    }
  }
  return p < 1 ? a : b;
}

/**
 * Valor de cada propriedade CSS do alvo em `time` (segundos locais ao clip dono), como o navegador o
 * resolveria no seek: antes do começo da trilha vale a primeira chave, depois do fim a última (`fill: both`).
 * Chaves no mesmo instante formam um degrau: no instante exato vale a última. Só trilhas do próprio elemento
 * (`target.tracks`); trilhas por unidade (`data-split`) não entram. Puro; a mesma entrada dá o mesmo resultado.
 */
export function sampleTracks(target: Pick<MotionTarget, "tracks">, time: number): Record<string, MotionValue> {
  const out: Record<string, MotionValue> = {};
  for (const track of target.tracks) {
    const keys = track.keys;
    if (keys.length === 0) continue;
    const x = track.duration <= 0 ? 0 : Math.min(1, Math.max(0, (time - track.start) / track.duration));
    let index = 0;
    for (const [i, key] of keys.entries()) if (key.offset <= x + 1e-12) index = i;
    const from = keys[index]!;
    const to = keys[index + 1];
    if (to === undefined || to.offset <= from.offset) {
      out[track.prop] = from.value;
      continue;
    }
    const p = (x - from.offset) / (to.offset - from.offset);
    out[track.prop] = mix(from.value, to.value, easeProgress(from.easing, p));
  }
  return out;
}

export type MergeResult = { ok: true; track: MotionTrack; jumps: number[] } | { ok: false; overlap: [number, number] };

const EPS = 1e-9;
const round6 = (n: number): number => Number(n.toFixed(6));

/**
 * Junta os trechos de uma propriedade numa trilha só. Entre trechos o valor fica
 * parado; trecho que começa em valor diferente do parado vira salto (duas chaves no
 * mesmo instante) e é listado em `jumps`. Trechos que se sobrepõem não se fundem.
 */
export function mergeSegments(prop: string, segments: Segment[]): MergeResult {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const before = sorted[i - 1]!;
    if (sorted[i]!.start < before.start + before.duration - EPS) {
      return { ok: false, overlap: [before.start, sorted[i]!.start] };
    }
  }

  const first = sorted[0]!;
  const last = sorted.at(-1)!;
  const origin = first.start;
  const total = last.start + last.duration - origin;
  // Trilha constante (um ponto de keyframe, duração 0): todas as chaves ficam em offset 0.
  const offsetOf = (t: number): number => (total <= 0 ? 0 : round6((t - origin) / total));

  const keys: MotionKey[] = [];
  const jumps: number[] = [];
  let previousEnd = origin;
  for (const [index, segment] of sorted.entries()) {
    const segmentKeys = segment.keys.map((key) => ({ ...key, offset: offsetOf(segment.start + key.offset * segment.duration) }));
    if (index > 0) {
      const held = keys.at(-1)!;
      const incoming = segmentKeys[0]!;
      const gap = segment.start - previousEnd;
      const same = String(held.value) === String(incoming.value);
      if (!same) {
        jumps.push(round6(segment.start));
        // Fecha o valor parado no instante do salto, senão ele rampa pela folga.
        if (gap > EPS) keys.push({ offset: incoming.offset, value: held.value, easing: null });
      } else if (gap <= EPS) {
        keys.pop();
      }
    }
    keys.push(...segmentKeys);
    previousEnd = segment.start + segment.duration;
  }

  return { ok: true, track: { prop, start: round6(origin), duration: round6(total), keys }, jumps };
}
