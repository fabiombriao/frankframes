// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Presets de motion (docs/motion.md, docs/contract.md §7b.4). Nomes e valores próprios; sem tabela herdada. */
import type { MotionKey, MotionKind, MotionValue } from "../types.ts";

interface ParamBase {
  key: string;
  /** Texto curto para o hint. */
  doc: string;
}

/** Número (`amount`) ou inteiro (`repeat`), com faixa fechada. */
export interface NumberParam extends ParamBase {
  kind: "number" | "int";
  min: number;
  max: number;
  default: number;
}

/** Distância: `<num>[px|%]`; sem unidade vale px. |n| ≤ 2000 px ou ≤ 200 %. O padrão é em px. */
export interface DistanceParam extends ParamBase {
  kind: "distance";
  default: number;
}

/** Direção: `left|right|up|down`. */
export interface DirParam extends ParamBase {
  kind: "dir";
  default: Direction;
}

export type ParamSpec = NumberParam | DistanceParam | DirParam;

export type Direction = "left" | "right" | "up" | "down";
export const DIRECTIONS: readonly Direction[] = ["left", "right", "up", "down"];

export const MAX_DISTANCE_PX = 2000;
export const MAX_DISTANCE_PERCENT = 200;

/** Lê `32`, `32px` ou `-10%`: px vira número, % fica texto. `null` se inválido ou fora da faixa. */
export function parseDistance(text: string): MotionValue | null {
  const match = /^(-?\d+(?:\.\d+)?)(px|%)?$/.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  if (match[2] === "%") return Math.abs(n) <= MAX_DISTANCE_PERCENT ? `${n}%` : null;
  return Math.abs(n) <= MAX_DISTANCE_PX ? n : null;
}

/** Inverte o sinal de uma distância já validada. */
function negate(value: MotionValue): MotionValue {
  if (typeof value === "number") return value === 0 ? 0 : -value;
  return value.startsWith("-") ? value.slice(1) : `-${value}`;
}

export interface PresetContext {
  /** Curva efetiva do preset (texto de `easing`): a do autor, ou a padrão do preset. */
  curve: string;
  /** Curva padrão de outro nome para presets de curva mista; com `curve=` do autor, vale a dele. */
  curveFor: (name: string) => string;
  /** Parâmetros numéricos (`amount`, `repeat`), já validados. */
  params: Record<string, number>;
  /** Distâncias (`distance`) já validadas. */
  distances: Record<string, MotionValue>;
  /** Direções (`dir`) já validadas. */
  dirs: Record<string, Direction>;
}

export interface PresetDef {
  name: string;
  /** Rótulo em português com acento, para UI. */
  label: string;
  kind: MotionKind;
  /** Duração padrão por ciclo, em segundos. Com `fillsClip`, é só a referência de UI e miniaturas. */
  dur: number;
  /** Câmera: sem `dur=`, o movimento ocupa do `at` até o fim do clip (a duração vem do clip, não do preset). */
  fillsClip?: boolean;
  /** Nome da curva padrão. */
  curve: string;
  params: ParamSpec[];
  /** Ciclos que o movimento repete; a duração total é `dur × cycles`. */
  cycles: (params: Record<string, number>) => number;
  /** Chaves por propriedade CSS, com offsets em 0..1 da duração total. */
  build: (ctx: PresetContext) => Array<{ prop: string; keys: MotionKey[] }>;
}

const once = (): number => 1;
const repeats = (params: Record<string, number>): number => params["repeat"] ?? 1;

type Pick = MotionValue | ((ctx: PresetContext) => MotionValue);
const pick = (value: Pick, ctx: PresetContext): MotionValue => (typeof value === "function" ? value(ctx) : value);

/** Valor de uma distância, com sinal. */
const distance = (key: string, sign: 1 | -1) => (ctx: PresetContext): MotionValue => {
  const value = ctx.distances[key] ?? 0;
  return sign === 1 ? value : negate(value);
};
const amount = (ctx: PresetContext): number => ctx.params["amount"] ?? 0;
const negAmount = (ctx: PresetContext): number => -amount(ctx);

/** Uma propriedade que vai de `from` a `to` em linha reta no tempo; `curve` troca a curva padrão por outro nome. */
interface Move {
  prop: string;
  from: Pick;
  to: Pick;
  curve?: string;
}

/** Entrada, saída e deslocamentos simples: uma rampa por propriedade, de 0 a 1. */
const ramp = (...moves: Move[]) => (ctx: PresetContext) =>
  moves.map((move) => ({
    prop: move.prop,
    keys: [
      { offset: 0, value: pick(move.from, ctx), easing: move.curve === undefined ? ctx.curve : ctx.curveFor(move.curve) },
      { offset: 1, value: pick(move.to, ctx), easing: null },
    ],
  }));

const fade = (from: number, to: number): Move => ({ prop: "opacity", from, to });
const scale = (from: Pick, to: Pick, curve?: string): Move[] => [
  { prop: "--ff-sx", from, to, ...(curve ? { curve } : {}) },
  { prop: "--ff-sy", from, to, ...(curve ? { curve } : {}) },
];

/** Recorte inicial (entrada) ou final (saída) de cada direção: o lado nomeado é o que fica fechado. */
const CLIP_OF: Readonly<Record<Direction, string>> = {
  right: "inset(0% 100% 0% 0%)",
  left: "inset(0% 0% 0% 100%)",
  up: "inset(100% 0% 0% 0%)",
  down: "inset(0% 0% 100% 0%)",
};
const OPEN = "inset(0% 0% 0% 0%)";

/** Ciclos de uma ênfase: cada ciclo é uma lista de (fração do ciclo, valor); o último ponto fecha no neutro. */
function cycled(ctx: PresetContext, points: Array<[number, MotionValue, string?]>, neutral: MotionValue): MotionKey[] {
  const n = ctx.params["repeat"] ?? 1;
  const keys: MotionKey[] = [];
  for (let c = 0; c < n; c++) {
    for (const [fraction, value, curve] of points) {
      keys.push({ offset: (c + fraction) / n, value, easing: curve === undefined ? ctx.curve : ctx.curveFor(curve) });
    }
  }
  keys.push({ offset: 1, value: neutral, easing: null });
  return keys;
}

const distanceParam = (px: number): ParamSpec => ({ key: "distance", kind: "distance", default: px, doc: "distância, número com px ou % (sem unidade é px); no máximo 2000px ou 200%" });
const dirParam = (initial: Direction): ParamSpec => ({ key: "dir", kind: "dir", default: initial, doc: "left, right, up ou down" });
const amountParam = (min: number, max: number, initial: number, unit: string): ParamSpec => ({
  key: "amount",
  kind: "number",
  min,
  max,
  default: initial,
  doc: `${unit}, em [${min},${max}]`,
});
const repeatParam: ParamSpec = { key: "repeat", kind: "int", min: 1, max: 20, default: 1, doc: "ciclos, inteiro em [1,20]" };

/** Parâmetros de foco da câmera: fração da imagem, 0 = borda esquerda/topo, 1 = direita/base. */
const focusParam = (key: "fx" | "fy", doc: string): ParamSpec => ({ key, kind: "number", min: 0, max: 1, default: 0.5, doc: `${doc}, em [0,1]` });
const FOCUS_X = focusParam("fx", "foco horizontal (0 = borda esquerda, 1 = direita)");
const FOCUS_Y = focusParam("fy", "foco vertical (0 = topo, 1 = base)");
const ZOOM_MAX = 4;

/** Trilha constante da câmera: duas chaves iguais, para a trilha existir mesmo sem movimento. */
const hold = (prop: string, value: number, easing: string): { prop: string; keys: MotionKey[] } => ({
  prop,
  keys: [
    { offset: 0, value, easing },
    { offset: 1, value, easing: null },
  ],
});
/** Foco parado só vira trilha quando difere do registrado (0.5): assim `aproximar` não disputa o foco com `data-keyframes`. */
const holdFocus = (ctx: PresetContext, key: "fx" | "fy", prop: string): Array<{ prop: string; keys: MotionKey[] }> => {
  const value = ctx.params[key] ?? 0.5;
  return value === 0.5 ? [] : [hold(prop, value, ctx.curve)];
};
const ramps = (prop: string, from: number, to: number, ctx: PresetContext): { prop: string; keys: MotionKey[] } => ({
  prop,
  keys: [
    { offset: 0, value: from, easing: ctx.curve },
    { offset: 1, value: to, easing: null },
  ],
});

const SCALE = "escala";
const DEGREES = "graus";
const PIXELS = "px";

export const PRESETS: readonly PresetDef[] = [
  // ---- entrada ----
  { name: "surgir", label: "Surgir", kind: "enter", dur: 0.5, curve: "suave", params: [], cycles: once, build: ramp(fade(0, 1)) },
  {
    name: "subir", label: "Subir", kind: "enter", dur: 0.6, curve: "freio", params: [distanceParam(32)], cycles: once,
    build: ramp(fade(0, 1), { prop: "--ff-y", from: distance("distance", 1), to: 0 }),
  },
  {
    name: "descer", label: "Descer", kind: "enter", dur: 0.6, curve: "freio", params: [distanceParam(32)], cycles: once,
    build: ramp(fade(0, 1), { prop: "--ff-y", from: distance("distance", -1), to: 0 }),
  },
  {
    name: "chegar-esquerda", label: "Chegar da esquerda", kind: "enter", dur: 0.6, curve: "freio", params: [distanceParam(48)], cycles: once,
    build: ramp(fade(0, 1), { prop: "--ff-x", from: distance("distance", -1), to: 0 }),
  },
  {
    name: "chegar-direita", label: "Chegar da direita", kind: "enter", dur: 0.6, curve: "freio", params: [distanceParam(48)], cycles: once,
    build: ramp(fade(0, 1), { prop: "--ff-x", from: distance("distance", 1), to: 0 }),
  },
  {
    name: "crescer", label: "Crescer", kind: "enter", dur: 0.5, curve: "freio", params: [amountParam(0.05, 5, 0.8, SCALE)], cycles: once,
    build: ramp(fade(0, 1), ...scale(amount, 1)),
  },
  {
    name: "assentar", label: "Assentar", kind: "enter", dur: 0.6, curve: "suave", params: [amountParam(0.05, 5, 1.12, SCALE)], cycles: once,
    build: ramp(fade(0, 1), ...scale(amount, 1)),
  },
  {
    name: "focar", label: "Focar", kind: "enter", dur: 0.7, curve: "suave", params: [amountParam(0, 100, 12, PIXELS)], cycles: once,
    build: ramp(fade(0, 1), { prop: "--ff-blur", from: amount, to: 0 }),
  },
  {
    name: "girar", label: "Girar", kind: "enter", dur: 0.6, curve: "freio", params: [amountParam(0, 180, 12, DEGREES)], cycles: once,
    build: ramp(fade(0, 1), { prop: "--ff-rot", from: negAmount, to: 0 }, ...scale(0.9, 1)),
  },
  {
    name: "abrir", label: "Abrir", kind: "enter", dur: 0.7, curve: "vaivem", params: [dirParam("right")], cycles: once,
    build: ramp({ prop: "clip-path", from: (ctx) => CLIP_OF[ctx.dirs["dir"] ?? "right"], to: OPEN }),
  },
  {
    name: "erguer", label: "Erguer", kind: "enter", dur: 0.8, curve: "suave", params: [], cycles: once,
    build: ramp(fade(0, 1), { prop: "--ff-y", from: 24, to: 0 }, ...scale(0.96, 1), { prop: "--ff-blur", from: 6, to: 0 }),
  },
  {
    // Opacidade com `suave` e escala com a mola; `curve=` do autor vale para os dois.
    name: "saltar", label: "Saltar", kind: "enter", dur: 0.7, curve: "mola", params: [amountParam(0.05, 5, 0.6, SCALE)], cycles: once,
    build: ramp({ prop: "opacity", from: 0, to: 1, curve: "suave" }, ...scale(amount, 1)),
  },

  // ---- saída ----
  { name: "apagar", label: "Apagar", kind: "exit", dur: 0.5, curve: "suave", params: [], cycles: once, build: ramp(fade(1, 0)) },
  {
    name: "partir-cima", label: "Partir para cima", kind: "exit", dur: 0.5, curve: "arranque", params: [distanceParam(32)], cycles: once,
    build: ramp(fade(1, 0), { prop: "--ff-y", from: 0, to: distance("distance", -1) }),
  },
  {
    name: "partir-baixo", label: "Partir para baixo", kind: "exit", dur: 0.5, curve: "arranque", params: [distanceParam(32)], cycles: once,
    build: ramp(fade(1, 0), { prop: "--ff-y", from: 0, to: distance("distance", 1) }),
  },
  {
    name: "partir-esquerda", label: "Partir para a esquerda", kind: "exit", dur: 0.5, curve: "arranque", params: [distanceParam(48)], cycles: once,
    build: ramp(fade(1, 0), { prop: "--ff-x", from: 0, to: distance("distance", -1) }),
  },
  {
    name: "partir-direita", label: "Partir para a direita", kind: "exit", dur: 0.5, curve: "arranque", params: [distanceParam(48)], cycles: once,
    build: ramp(fade(1, 0), { prop: "--ff-x", from: 0, to: distance("distance", 1) }),
  },
  {
    name: "recuar", label: "Recuar", kind: "exit", dur: 0.5, curve: "arranque", params: [amountParam(0.05, 5, 0.85, SCALE)], cycles: once,
    build: ramp(fade(1, 0), ...scale(1, amount)),
  },
  {
    name: "desfocar", label: "Desfocar", kind: "exit", dur: 0.6, curve: "suave", params: [amountParam(0, 100, 12, PIXELS)], cycles: once,
    build: ramp(fade(1, 0), { prop: "--ff-blur", from: 0, to: amount }),
  },
  {
    name: "fechar", label: "Fechar", kind: "exit", dur: 0.6, curve: "vaivem", params: [dirParam("left")], cycles: once,
    build: ramp({ prop: "clip-path", from: OPEN, to: (ctx) => CLIP_OF[ctx.dirs["dir"] ?? "left"] }),
  },

  // ---- ênfase ----
  {
    name: "pulsar", label: "Pulsar", kind: "emphasis", dur: 0.6, curve: "suave",
    params: [{ key: "amount", kind: "number", min: 0.5, max: 3, default: 1.08, doc: "escala no pico, em [0.5,3]" }, repeatParam],
    cycles: repeats,
    build: (ctx) => {
      const keys = cycled(ctx, [[0, 1], [0.5, amount(ctx)]], 1);
      return [
        { prop: "--ff-sx", keys },
        { prop: "--ff-sy", keys: keys.map((key) => ({ ...key })) },
      ];
    },
  },
  {
    name: "balancar", label: "Balançar", kind: "emphasis", dur: 0.8, curve: "vaivem", params: [amountParam(0, 180, 4, DEGREES), repeatParam], cycles: repeats,
    build: (ctx) => [{ prop: "--ff-rot", keys: cycled(ctx, [[0, 0], [0.25, amount(ctx)], [0.75, negAmount(ctx)]], 0) }],
  },
  {
    name: "tremer", label: "Tremer", kind: "emphasis", dur: 0.4, curve: "linear", params: [amountParam(0, 200, 6, PIXELS), repeatParam], cycles: repeats,
    build: (ctx) => {
      const a = amount(ctx);
      return [{ prop: "--ff-x", keys: cycled(ctx, [[0, 0], [0.2, a], [0.4, -a], [0.6, a / 2], [0.8, -a / 2]], 0) }];
    },
  },
  {
    name: "respirar", label: "Respirar", kind: "emphasis", dur: 2, curve: "vaivem", params: [amountParam(0.05, 5, 1.03, SCALE), repeatParam], cycles: repeats,
    build: (ctx) => {
      const keys = cycled(ctx, [[0, 1], [0.5, amount(ctx)]], 1);
      return [
        { prop: "--ff-sx", keys },
        { prop: "--ff-sy", keys: keys.map((key) => ({ ...key })) },
      ];
    },
  },
  {
    name: "piscar", label: "Piscar", kind: "emphasis", dur: 0.4, curve: "vaivem", params: [amountParam(0, 1, 0.2, "opacidade"), repeatParam], cycles: repeats,
    build: (ctx) => [{ prop: "opacity", keys: cycled(ctx, [[0, 1], [0.5, amount(ctx)]], 1) }],
  },
  {
    // Sobe com `freio` e volta com `arranque`; `curve=` do autor vale para os dois trechos.
    name: "quicar", label: "Quicar", kind: "emphasis", dur: 0.5, curve: "freio", params: [distanceParam(16), repeatParam], cycles: repeats,
    build: (ctx) => [{ prop: "--ff-y", keys: cycled(ctx, [[0, 0], [0.5, distance("distance", -1)(ctx), "arranque"]], 0) }],
  },

  // ---- câmera (§7b.9): só em <img> e <video>; ocupam o clip inteiro por padrão ----
  {
    name: "aproximar", label: "Aproximar", kind: "camera", dur: 4, fillsClip: true, curve: "suave",
    params: [amountParam(1, ZOOM_MAX, 1.15, "zoom final"), FOCUS_X, FOCUS_Y], cycles: once,
    build: (ctx) => [ramps("--ff-zoom", 1, amount(ctx), ctx), ...holdFocus(ctx, "fx", "--ff-fx"), ...holdFocus(ctx, "fy", "--ff-fy")],
  },
  {
    name: "afastar", label: "Afastar", kind: "camera", dur: 4, fillsClip: true, curve: "suave",
    params: [amountParam(1, ZOOM_MAX, 1.15, "zoom inicial"), FOCUS_X, FOCUS_Y], cycles: once,
    build: (ctx) => [ramps("--ff-zoom", amount(ctx), 1, ctx), ...holdFocus(ctx, "fx", "--ff-fx"), ...holdFocus(ctx, "fy", "--ff-fy")],
  },
  {
    name: "panoramica-esquerda", label: "Panorâmica à esquerda", kind: "camera", dur: 4, fillsClip: true, curve: "linear",
    params: [amountParam(1, ZOOM_MAX, 1.12, "zoom fixo (a sobra da imagem é o que a câmera percorre)"), FOCUS_Y], cycles: once,
    build: (ctx) => [hold("--ff-zoom", amount(ctx), ctx.curve), ramps("--ff-fx", 0.75, 0.25, ctx), ...holdFocus(ctx, "fy", "--ff-fy")],
  },
  {
    name: "panoramica-direita", label: "Panorâmica à direita", kind: "camera", dur: 4, fillsClip: true, curve: "linear",
    params: [amountParam(1, ZOOM_MAX, 1.12, "zoom fixo (a sobra da imagem é o que a câmera percorre)"), FOCUS_Y], cycles: once,
    build: (ctx) => [hold("--ff-zoom", amount(ctx), ctx.curve), ramps("--ff-fx", 0.25, 0.75, ctx), ...holdFocus(ctx, "fy", "--ff-fy")],
  },
  {
    // Deriva lenta, quase imperceptível: tira a imagem parada sem chamar atenção.
    name: "deriva", label: "Deriva", kind: "camera", dur: 6, fillsClip: true, curve: "linear", params: [], cycles: once,
    build: (ctx) => [ramps("--ff-zoom", 1.06, 1.1, ctx), ramps("--ff-fx", 0.45, 0.55, ctx), ramps("--ff-fy", 0.48, 0.52, ctx)],
  },
];

export function presetsOf(kind: MotionKind): PresetDef[] {
  return PRESETS.filter((preset) => preset.kind === kind);
}

/** Todos os presets, ou só os de um tipo. */
export function listPresets(kind?: MotionKind): PresetDef[] {
  return kind === undefined ? [...PRESETS] : presetsOf(kind);
}
