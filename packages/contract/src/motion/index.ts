// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Contrato de motion (docs/contract.md §7b): valida os atributos `data-enter`,
 * `data-exit`, `data-emphasis`, `data-camera` e `data-transition` e os traduz em
 * trilhas por propriedade CSS, com tempo local ao clip dono. Puro: sem DOM nem I/O.
 */
import type { Diagnostic, DurationResolution, MotionKind, MotionSource, MotionTarget, MotionTrack, MotionValue, ResolvedClip } from "../types.ts";
import { CODES, diag } from "../errors.ts";
import { emitEasing, resolveCurve, springSettleSeconds } from "./curves.ts";
import { parseAnchor, parseMotionValue, parseNumber, parseSeconds } from "./grammar.ts";
import type { Anchor } from "./grammar.ts";
import { DIRECTIONS, parseDistance, presetsOf } from "./presets.ts";
import type { Direction, ParamSpec, PresetDef } from "./presets.ts";
import { keyframeSegments, mergeSegments, ownedProperties } from "./tracks.ts";
import type { Segment } from "./tracks.ts";
import { unitRanks } from "./split.ts";

export { CURVE_NAMES, emitEasing, evaluateCurve, parseCurve, resolveCurve, springSettleSeconds } from "./curves.ts";
export type { Bezier, ParsedCurve, Spring } from "./curves.ts";
export { MAX_KEYFRAMES, parseKeyframes } from "./keyframes.ts";
export type { KeyframeContext, ParsedKeyframes } from "./keyframes.ts";
export { parseAnchor, parseMotionValue } from "./grammar.ts";
export type { Anchor, ParsedValue } from "./grammar.ts";
export { DIRECTIONS, PRESETS, listPresets, parseDistance, presetsOf } from "./presets.ts";
export type { Direction, ParamSpec, PresetContext, PresetDef } from "./presets.ts";
export { CSS_PROP_OF, MOTION_PROPERTIES, OWNED_BY_PROP, bindingsFor, keyframeSegments, mergeSegments, ownedProperties } from "./tracks.ts";
export type { MergeResult, Segment, SpringFailure } from "./tracks.ts";
export { MOTION_ATTRS, hasKeyframes, hasMotion, hasSplit, isHost, isTimed, motionAttrsOf, motionElements } from "./targets.ts";
export type { DomNode } from "./targets.ts";
export { DEFAULT_STAGGER, MAX_STAGGER, SPLIT_MODES, SPLIT_ORDERS, buildSplit, orphanUnits, scanSplit, splitText, unitRanks } from "./split.ts";
export type { SplitMode, SplitOrder, SplitProblem, SplitResult, SplitScan, TextPiece } from "./split.ts";

const KINDS: readonly MotionKind[] = ["enter", "exit", "emphasis", "camera", "transition"];
const ATTR_OF: Record<MotionKind, string> = {
  enter: "data-enter",
  exit: "data-exit",
  emphasis: "data-emphasis",
  camera: "data-camera",
  transition: "data-transition",
};
const EPS = 1e-9;
const round6 = (n: number): number => Number(n.toFixed(6));

const COMMON_PARAMS = ["dur", "at", "curve"];

interface Planned {
  kind: MotionKind;
  preset: PresetDef;
  /** Segundos locais ao clip: `[start, start + duration]`. */
  start: number;
  duration: number;
  segments: Array<{ prop: string; keys: Segment["keys"] }>;
  /** Com `data-split`: deslocamento de cada unidade em relação a `start` (§7b.8). */
  shifts?: number[];
}

/** Propriedades de CSS declaradas no `style` inline, em minúsculas. */
function inlineProperties(style: string | undefined): Set<string> {
  const names = new Set<string>();
  for (const declaration of (style ?? "").split(";")) {
    const at = declaration.indexOf(":");
    if (at > 0) names.add(declaration.slice(0, at).trim().toLowerCase());
  }
  return names;
}

function describeRange(spec: ParamSpec): string {
  return `${spec.key}: ${spec.doc}`;
}

/**
 * Resolve o motion de todos os elementos. `clips` é a lista de topo já resolvida;
 * `duration` diz se a composição tem duração (sem ela, o que depende da duração do
 * clip espera, porque `E_DURATION_UNRESOLVED` já bloqueia o render).
 */
export function resolveMotion(
  sources: MotionSource[],
  clips: ResolvedClip[],
  duration: DurationResolution,
  diagnostics: Diagnostic[],
): Record<string, MotionTarget[]> {
  const byId = new Map<string, ResolvedClip>();
  const index = (list: ResolvedClip[]): void => {
    for (const clip of list) {
      byId.set(clip.id, clip);
      index(clip.children);
    }
  };
  index(clips);

  const result: Record<string, MotionTarget[]> = {};

  for (const source of sources) {
    const clip = byId.get(source.clipId);
    if (!clip) continue; // clip descartado por erro de parsing: o erro dele já foi emitido
    const error = (code: string, message: string, hint: string): void => {
      diagnostics.push(diag(code, "error", message, { clipId: source.clipId, hint }));
    };
    const where = `"${source.clipId}" (${source.tag}${source.own ? "" : ", descendente"})`;
    const D = clip.start !== undefined && clip.end !== undefined ? clip.end - clip.start : undefined;

    // Alvos inválidos (§7b.2) deixam o elemento inteiro de fora.
    let invalid = false;
    const refuse = (message: string, hint: string): void => {
      invalid = true;
      error(CODES.MOTION_TARGET, message, hint);
    };
    if (source.tag === "audio") refuse(`motion em <audio> em ${where}`, "áudio não tem imagem; use data-fade-in/data-fade-out");
    if (source.tag === "video") refuse(`motion em <video> em ${where} ainda não é suportado`, "anime um wrapper do vídeo, ou use <img>");
    if (source.attrs.camera !== undefined && source.tag !== "img") {
      refuse(`data-camera só vale em <img>: ${where}`, "mova data-camera para o <img> do clip");
    }
    if (source.attrs.transition !== undefined && !source.own) {
      refuse(`data-transition em descendente em ${where}`, "data-transition vale só no clip que entra: mova para o clip");
    }
    const split = source.split;
    if (split !== undefined && (source.attrs.camera !== undefined || source.attrs.transition !== undefined)) {
      refuse(`data-split não combina com data-camera nem data-transition em ${where}`, "tire data-split, ou mova data-camera/data-transition para outro elemento");
    }
    if (invalid) continue;

    // Tempo por unidade (§7b.8): cada preset de enter/exit/emphasis ganha um deslocamento por unidade.
    const spread = split !== undefined ? unitRanks(split.units.length, split.order) : undefined;
    const shiftsFor = (kind: MotionKind): ((start: number) => number[]) | undefined => {
      if (split === undefined || spread === undefined) return undefined;
      if (kind === "enter") {
        return (start) =>
          spread.ranks.map((rank, i) => {
            const anchor = split.units[i]!.anchor;
            return round6(anchor !== undefined ? anchor - start : rank * split.stagger);
          });
      }
      if (kind === "exit") return () => spread.ranks.map((rank) => round6(-(spread.max - rank) * split.stagger));
      if (kind === "emphasis") return () => spread.ranks.map((rank) => round6(rank * split.stagger));
      return undefined;
    };

    const planned: Planned[] = [];
    let blocked = false;
    for (const kind of KINDS) {
      const raw = source.attrs[kind];
      if (raw === undefined) continue;
      const attrName = ATTR_OF[kind];
      const available = presetsOf(kind);
      const parsed = parseMotionValue(raw);
      if (!parsed.ok) {
        blocked = true;
        error(
          CODES.MOTION_SYNTAX,
          `${attrName} inválido em ${where}: ${parsed.message}`,
          `use ${attrName}="${available[0]?.name ?? "preset"} dur=0.6 at=0.2" (preset e depois chave=valor separados por espaço)`,
        );
        continue;
      }
      const preset = available.find((p) => p.name === parsed.preset);
      if (!preset) {
        blocked = true;
        error(
          CODES.MOTION_PRESET_UNKNOWN,
          `preset desconhecido em ${attrName} de ${where}: ${JSON.stringify(parsed.preset)}`,
          available.length > 0
            ? `presets de ${attrName}: ${available.map((p) => p.name).join(", ")}`
            : `${attrName} ainda não tem presets; remova o atributo`,
        );
        continue;
      }

      const unitShifts = shiftsFor(kind);
      const plan = planPreset({ kind, preset, params: parsed.params, attrName, where, D, planned, duration, error, ...(unitShifts ? { unitShifts } : {}) });
      if (plan === "failed") {
        blocked = true;
        continue;
      }
      if (plan !== "waiting") planned.push(plan);
    }

    // Keyframes visuais (§7b.7): um trecho por propriedade, entram na mesma fusão dos presets.
    const keyframes = keyframeSegments(source.keyframes ?? []);
    for (const failure of keyframes.failures) {
      blocked = true;
      error(
        CODES.CURVE_INVALID,
        `mola não assenta no trecho de ${failure.prop} que começa em ${round6(failure.time)} s em ${where} (dura ${failure.duration} s)`,
        `mola precisa de dur ≥ ${failure.minimum} s; afaste os pontos ou use outra curva`,
      );
    }
    if (D !== undefined) {
      for (const point of source.keyframes ?? []) {
        if (point.time > D + EPS) {
          diagnostics.push(
            diag(CODES.KEYFRAME_OUT_OF_RANGE, "warning", `ponto de data-keyframes em ${round6(point.time)} s passa do fim do clip em ${where}`, {
              clipId: source.clipId,
              hint: `o ponto em t=${round6(point.time)} s nunca aparece: o clip termina em ${round6(D)} s`,
            }),
          );
        }
      }
    }
    if (blocked) continue;

    // Trechos por propriedade -> uma trilha por propriedade CSS. Sem split, presets e keyframes
    // vão juntos para o elemento; com split, os presets valem por unidade e só os keyframes ficam no elemento.
    const addSegments = (into: Map<string, Segment[]>, unit: number | undefined): void => {
      for (const item of planned) {
        const shift = unit === undefined ? 0 : (item.shifts?.[unit] ?? 0);
        for (const part of item.segments) {
          const list = into.get(part.prop) ?? [];
          list.push({ start: round6(item.start + shift), duration: item.duration, keys: part.keys });
          into.set(part.prop, list);
        }
      }
    };
    const addKeyframes = (into: Map<string, Segment[]>): void => {
      for (const { prop, segment } of keyframes.segments) {
        const list = into.get(prop) ?? [];
        list.push(segment);
        into.set(prop, list);
      }
    };
    // `unit` (base 1) só aparece nas mensagens do modo split; os saltos saem uma vez, da primeira unidade.
    const buildTracks = (segmentsByProp: Map<string, Segment[]>, unit: number | undefined): MotionTrack[] => {
      const label = unit === undefined ? "" : `, unidade ${unit} de ${split!.units.length}`;
      const out: MotionTrack[] = [];
      for (const [prop, segments] of segmentsByProp) {
        const merged = mergeSegments(prop, segments);
        if (!merged.ok) {
          blocked = true;
          error(
            CODES.MOTION_OVERLAP,
            `dois movimentos de ${prop} se sobrepõem em ${where}${label}`,
            `o segundo começa em ${merged.overlap[1]} s, antes do primeiro terminar; ajuste at, dur${unit === undefined ? "" : " ou stagger"} (encostar nas pontas é permitido)`,
          );
          continue;
        }
        if (unit === undefined || unit === 1) {
          for (const at of merged.jumps) {
            diagnostics.push(
              diag(CODES.MOTION_JUMP, "warning", `${prop} salta em ${at} s em ${where}: o próximo movimento começa num valor diferente do parado`, {
                clipId: source.clipId,
                hint: "faça o movimento seguinte começar no valor em que o anterior terminou",
              }),
            );
          }
        }
        out.push(merged.track);
      }
      return out;
    };

    const elementSegments = new Map<string, Segment[]>();
    if (split === undefined) addSegments(elementSegments, undefined);
    addKeyframes(elementSegments);
    const tracks = buildTracks(elementSegments, undefined);
    let unitTracks: MotionTrack[][] | undefined;
    if (split !== undefined && !blocked) {
      unitTracks = [];
      for (let i = 0; i < split.units.length && !blocked; i++) {
        const into = new Map<string, Segment[]>();
        addSegments(into, i);
        unitTracks.push(buildTracks(into, i + 1));
      }
    }
    if (blocked) continue;

    // Posse (§7b.6): `opacity` inline é estática e a animação a sobrepõe; o resto não.
    const checkOwnership = (style: string | undefined, props: string[], whereText: string): void => {
      const declared = inlineProperties(style);
      for (const owned of ownedProperties(props)) {
        if (owned !== "opacity" && declared.has(owned)) {
          error(
            CODES.MOTION_CONFLICT,
            `${owned} é controlado pelo motion em ${whereText}, mas também está no style inline`,
            `remova ${owned} do style; para posição ou rotação fixas use transform, que compõe depois do motion`,
          );
          blocked = true;
        }
      }
    };
    checkOwnership(source.style, tracks.map((t) => t.prop), where);
    if (split?.explicit && unitTracks !== undefined) {
      for (const [i, unitTrack] of unitTracks.entries()) {
        checkOwnership(split.units[i]!.style, unitTrack.map((t) => t.prop), `${where}, unidade ${i + 1} (data-unit)`);
      }
    }
    if (blocked || (tracks.length === 0 && (unitTracks === undefined || unitTracks.every((t) => t.length === 0)))) continue;

    const target: MotionTarget = { ordinal: source.ordinal, tag: source.tag, tracks };
    if (split !== undefined && unitTracks !== undefined) {
      target.units = unitTracks;
      target.split = { mode: split.mode, explicit: split.explicit };
    }
    (result[source.clipId] ??= []).push(target);
  }
  return result;
}

interface PlanInput {
  kind: MotionKind;
  preset: PresetDef;
  params: Record<string, string>;
  attrName: string;
  where: string;
  D: number | undefined;
  planned: Planned[];
  duration: DurationResolution;
  error: (code: string, message: string, hint: string) => void;
  /** Com `data-split`: deslocamento de cada unidade dado o início do preset (§7b.8). */
  unitShifts?: (start: number) => number[];
}

/** Valida parâmetros e calcula o intervalo e as chaves de um atributo. */
function planPreset(input: PlanInput): Planned | "failed" | "waiting" {
  const { kind, preset, params, attrName, where, D, error } = input;
  const accepted = [...COMMON_PARAMS, ...preset.params.map((p) => p.key)];

  for (const key of Object.keys(params)) {
    if (!accepted.includes(key)) {
      error(CODES.MOTION_PARAM, `parâmetro desconhecido em ${attrName} de ${where}: ${key}`, `${preset.name} aceita: ${accepted.join(", ")}`);
      return "failed";
    }
  }

  let ok = true;
  const paramError = (message: string, hint: string): void => {
    ok = false;
    error(CODES.MOTION_PARAM, `${attrName} de ${where}: ${message}`, hint);
  };

  let dur = preset.dur;
  if (params["dur"] !== undefined) {
    const seconds = parseSeconds(params["dur"]);
    if (seconds === null || seconds <= 0) paramError(`dur inválido: ${JSON.stringify(params["dur"])}`, "dur é segundos > 0, por exemplo dur=0.6");
    else dur = seconds;
  }

  const values: Record<string, number> = {};
  const distances: Record<string, MotionValue> = {};
  const dirs: Record<string, Direction> = {};
  for (const spec of preset.params) {
    const text = params[spec.key];
    if (spec.kind === "distance") {
      distances[spec.key] = spec.default;
      if (text === undefined) continue;
      const parsedDistance = parseDistance(text);
      if (parsedDistance === null) paramError(`${spec.key} inválido: ${JSON.stringify(text)}`, describeRange(spec));
      else distances[spec.key] = parsedDistance;
    } else if (spec.kind === "dir") {
      dirs[spec.key] = spec.default;
      if (text === undefined) continue;
      const found = DIRECTIONS.find((d) => d === text);
      if (found === undefined) paramError(`${spec.key} inválido: ${JSON.stringify(text)}`, describeRange(spec));
      else dirs[spec.key] = found;
    } else {
      values[spec.key] = spec.default;
      if (text === undefined) continue;
      const n = spec.kind === "int" ? (/^\d+$/.test(text) ? Number(text) : null) : parseNumber(text);
      if (n === null || n < spec.min || n > spec.max) paramError(`${spec.key} inválido: ${JSON.stringify(text)}`, describeRange(spec));
      else values[spec.key] = n;
    }
  }

  let anchor: Anchor | null = null;
  if (params["at"] !== undefined) {
    anchor = parseAnchor(params["at"]);
    if (anchor === null) {
      paramError(`at inválido: ${JSON.stringify(params["at"])}`, "at: segundos (0.5), -n só em data-enter, p% (50%), end ou end-n");
    } else if (anchor.kind === "seconds" && anchor.value < 0 && kind !== "enter") {
      paramError(`at negativo só vale em data-enter: ${params["at"]}`, "use at positivo, p%, end ou end-n");
      anchor = null;
    }
  }

  const curveName = params["curve"] ?? preset.curve;
  const resolved = resolveCurve(curveName);
  if (!resolved.curve) {
    ok = false;
    error(
      CODES.CURVE_INVALID,
      `curva inválida em ${attrName} de ${where}: ${JSON.stringify(curveName)} (${resolved.reason})`,
      "use cubic-bezier(0.3,0,0.2,1) ou um nome: linear, ease, suave, freio, arranque, vaivem, mola, mola-firme",
    );
  }
  if (!ok || !resolved.curve) return "failed";

  // Âncora -> instante local. `end` e `p%` precisam de D.
  const total = dur * preset.cycles(values);
  const defaultEnd = kind === "exit";
  const needsD = anchor === null ? defaultEnd : anchor.kind !== "seconds";
  let at: number;
  if (needsD) {
    if (D === undefined) {
      if (input.duration.kind === "unresolved") return "waiting";
      error(CODES.MOTION_OUT_OF_RANGE, `${attrName} de ${where} depende da duração do clip, que não está definida`, "defina data-duration no clip");
      return "failed";
    }
    if (anchor === null) at = D;
    else if (anchor.kind === "percent") at = (anchor.value / 100) * D;
    else if (anchor.kind === "end") at = D - anchor.before;
    else at = anchor.value;
  } else if (anchor !== null && anchor.kind === "seconds") {
    at = anchor.value;
  } else {
    // Ênfase sem `at` começa onde a entrada do mesmo alvo termina.
    // Com `data-split`, "onde a entrada termina" é onde termina a última unidade.
    const entering = kind === "emphasis" ? input.planned.find((p) => p.kind === "enter") : undefined;
    const lastShift = entering?.shifts !== undefined ? Math.max(...entering.shifts) : 0;
    at = entering ? entering.start + entering.duration + lastShift : 0;
  }

  const start = kind === "exit" ? at - total : at;
  const end = start + total;
  const shifts = input.unitShifts?.(start);
  if (D !== undefined) {
    const lowest = kind === "enter" ? -Infinity : 0;
    for (const [i, shift] of (shifts ?? [0]).entries()) {
      const first = start + shift;
      const last = end + shift;
      if (last > D + EPS || first < lowest - EPS) {
        const unit = shifts === undefined ? "" : `, unidade ${i + 1} de ${shifts.length}`;
        const adjust = shifts === undefined ? "" : ", stagger";
        error(
          CODES.MOTION_OUT_OF_RANGE,
          `${attrName} de ${where}${unit} ocupa [${round6(first)}, ${round6(last)}] s e o clip tem ${round6(D)} s`,
          kind === "enter"
            ? `o movimento precisa terminar em ${round6(D)} s ou antes; reduza dur${adjust} ou antecipe at`
            : `o movimento precisa caber em [0, ${round6(D)}] s; reduza dur${adjust} ou ajuste at`,
        );
        return "failed";
      }
    }
  }

  // `curve=` do autor vale para todos os trechos; sem ele, presets de curva mista pedem a padrão de cada nome.
  const authored = params["curve"] !== undefined ? resolved.curve.css : undefined;
  const curveFor = (name: string): string => {
    if (authored !== undefined) return authored;
    const other = resolveCurve(name);
    if (!other.curve) throw new Error(`preset ${preset.name}: curva padrão interna inválida: ${name}`);
    return other.curve.css;
  };
  let segments = preset.build({ curve: resolved.curve.css, curveFor, params: values, distances, dirs });
  const spring = resolved.curve;
  if (spring.spring !== undefined) {
    // A mola só vira easing sabendo a duração de cada trecho: do offset da chave ao da próxima.
    let minimum = 0;
    let shortest = Infinity;
    segments = segments.map((part) => ({
      prop: part.prop,
      keys: part.keys.map((key, index) => {
        const next = part.keys[index + 1];
        if (key.easing !== spring.css || next === undefined) return key;
        const seconds = (next.offset - key.offset) * total;
        const easing = emitEasing(spring, seconds);
        if (easing === null) {
          minimum = springSettleSeconds(spring.spring!);
          shortest = Math.min(shortest, seconds);
          return key;
        }
        return { ...key, easing };
      }),
    }));
    if (minimum > 0) {
      error(
        CODES.CURVE_INVALID,
        `mola não assenta em ${attrName} de ${where}: o trecho mais curto dura ${round6(shortest)} s`,
        `mola precisa de dur ≥ ${minimum} s por trecho; aumente dur ou use outra curva`,
      );
      return "failed";
    }
  }
  const plan: Planned = { kind, preset, start: round6(start), duration: round6(total), segments };
  if (shifts !== undefined) plan.shifts = shifts;
  return plan;
}
