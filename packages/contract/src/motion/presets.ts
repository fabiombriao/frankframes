// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Presets de motion (docs/contract.md §7b.4). Nomes e valores próprios; sem tabela herdada. */
import type { MotionKey, MotionKind } from "../types.ts";

export interface ParamSpec {
  key: string;
  kind: "number" | "int";
  min: number;
  max: number;
  default: number;
  /** Texto curto para o hint. */
  doc: string;
}

export interface PresetContext {
  /** Curva já resolvida (texto de `easing`). */
  curve: string;
  params: Record<string, number>;
}

export interface PresetDef {
  name: string;
  kind: MotionKind;
  /** Duração padrão por ciclo, em segundos. */
  dur: number;
  /** Nome da curva padrão. */
  curve: string;
  params: ParamSpec[];
  /** Ciclos que o movimento repete; a duração total é `dur × cycles`. */
  cycles: (params: Record<string, number>) => number;
  /** Chaves por propriedade CSS, com offsets em 0..1 da duração total. */
  build: (ctx: PresetContext) => Array<{ prop: string; keys: MotionKey[] }>;
}

const once = (): number => 1;

const fade = (from: number, to: number) => (ctx: PresetContext) => [
  {
    prop: "opacity",
    keys: [
      { offset: 0, value: from, easing: ctx.curve },
      { offset: 1, value: to, easing: null },
    ],
  },
];

export const PRESETS: readonly PresetDef[] = [
  { name: "surgir", kind: "enter", dur: 0.5, curve: "suave", params: [], cycles: once, build: fade(0, 1) },
  { name: "apagar", kind: "exit", dur: 0.5, curve: "suave", params: [], cycles: once, build: fade(1, 0) },
  {
    name: "pulsar",
    kind: "emphasis",
    dur: 0.6,
    curve: "suave",
    params: [
      { key: "amount", kind: "number", min: 0.5, max: 3, default: 1.08, doc: "escala no pico, em [0.5,3]" },
      { key: "repeat", kind: "int", min: 1, max: 20, default: 1, doc: "ciclos, inteiro em [1,20]" },
    ],
    cycles: (params) => params["repeat"] ?? 1,
    build: (ctx) => {
      const n = ctx.params["repeat"] ?? 1;
      const peak = ctx.params["amount"] ?? 1.08;
      const keys: MotionKey[] = [];
      for (let c = 0; c < n; c++) {
        keys.push({ offset: c / n, value: 1, easing: ctx.curve }, { offset: (c + 0.5) / n, value: peak, easing: ctx.curve });
      }
      keys.push({ offset: 1, value: 1, easing: null });
      return [
        { prop: "--ff-sx", keys },
        { prop: "--ff-sy", keys: keys.map((key) => ({ ...key })) },
      ];
    },
  },
];

export function presetsOf(kind: MotionKind): PresetDef[] {
  return PRESETS.filter((preset) => preset.kind === kind);
}
