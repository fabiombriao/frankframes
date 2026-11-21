// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Propriedades CSS do motion e fusão de trechos em trilhas (docs/contract.md §7b.6, §7b.12). */
import type { MotionKey, MotionTrack } from "../types.ts";

/** Propriedades personalizadas que o runtime registra (`inherits:false`). Fonte única: o engine lê esta lista. */
export const MOTION_PROPERTIES: ReadonlyArray<{ name: string; syntax: string; initial: string }> = [
  { name: "--ff-x", syntax: "<length-percentage>", initial: "0px" },
  { name: "--ff-y", syntax: "<length-percentage>", initial: "0px" },
  { name: "--ff-sx", syntax: "<number>", initial: "1" },
  { name: "--ff-sy", syntax: "<number>", initial: "1" },
  { name: "--ff-rot", syntax: "<angle>", initial: "0deg" },
  { name: "--ff-blur", syntax: "<length>", initial: "0px" },
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
};

/** Ligação de cada propriedade possuída às variáveis, na ordem em que entram no `style`. */
const BINDINGS: ReadonlyArray<{ css: string; value: string; uses: string[] }> = [
  { css: "translate", value: "var(--ff-x) var(--ff-y)", uses: ["--ff-x", "--ff-y"] },
  { css: "scale", value: "var(--ff-sx) var(--ff-sy)", uses: ["--ff-sx", "--ff-sy"] },
  { css: "rotate", value: "var(--ff-rot)", uses: ["--ff-rot"] },
  { css: "filter", value: "blur(var(--ff-blur))", uses: ["--ff-blur"] },
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
  const offsetOf = (t: number): number => round6((t - origin) / total);

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
