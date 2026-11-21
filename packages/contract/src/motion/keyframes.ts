// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * `data-keyframes` (docs/contract.md §7b.7): pontos de volume (EDT-40) e de propriedades
 * visuais no mesmo array JSON. Puro: sem DOM nem I/O.
 */
import type { Diagnostic, MotionProp, MotionValue, VisualKeyframe } from "../types.ts";
import { CODES, diag } from "../errors.ts";
import { resolveCurve } from "./curves.ts";

/** Máximo de pontos por atributo. */
export const MAX_KEYFRAMES = 256;

const VISUAL_KEYS = ["opacity", "x", "y", "scale", "scaleX", "scaleY", "rotate", "blur", "clip"] as const;
/** Reservadas à câmera (§7b.6): recusadas até ela existir, para nunca virarem movimento invisível. */
const CAMERA_KEYS = ["zoom", "focusX", "focusY"] as const;
const OTHER_KEYS = ["time", "volume", "curve"] as const;

export interface KeyframeContext {
  /** Clip dono, para `clipId` e mensagens. */
  clipId: string;
  /** `true` no próprio clip (aceita `volume`); `false` em descendente. */
  own: boolean;
  diagnostics: Diagnostic[];
}

export interface ParsedKeyframes {
  /** Pontos de volume, na ordem do JSON. Vazio quando nenhum ponto tem `volume`. */
  volume: Array<{ time: number; volume: number }>;
  /** Pontos visuais por ordem de `time`. */
  visual: VisualKeyframe[];
}

const NUMBER_HINT = 'use [{"time":0,"volume":1},{"time":2,"volume":0.2}]';
const LENGTH = /^(-?\d+(?:\.\d+)?)(px|%)$/;
const PERCENT = /^(\d+(?:\.\d+)?)%$/;
const CLEAN = (n: number): string => String(Number(n.toFixed(6)));

/** `valor` já validado ou o motivo de recusa (para o hint). */
type Checked = { ok: true; value: MotionValue } | { ok: false; reason: string };

function range(value: unknown, min: number, max: number, unit: string): Checked {
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: `precisa ser um número (${unit}) em [${min},${max}]` };
  if (value < min || value > max) return { ok: false, reason: `${value} fora de [${min},${max}] (${unit})` };
  return { ok: true, value };
}

function distance(value: unknown): Checked {
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: "precisa ser um número finito" };
  }
  if (typeof value === "string") {
    const match = LENGTH.exec(value.trim());
    if (match) {
      const n = Number(match[1]);
      // px vira número (a unidade padrão); % continua texto.
      return { ok: true, value: match[2] === "px" ? n : `${CLEAN(n)}%` };
    }
  }
  return { ok: false, reason: 'use um número (px) ou texto como "10px" ou "10%"' };
}

/** Lista de % do `inset(...)` em ordem t r b l, ou o motivo. */
function insetOf(body: string): Checked {
  const parts = body.trim().split(/\s+/).filter((p) => p !== "");
  if (parts.length < 1 || parts.length > 4) return { ok: false, reason: "inset aceita de 1 a 4 valores em %" };
  const numbers: number[] = [];
  for (const part of parts) {
    const match = part === "0" ? ["", "0"] : PERCENT.exec(part);
    if (!match) return { ok: false, reason: `"${part}" não é um valor em % (use inset(0% 10% 0% 0%))` };
    const n = Number(match[1]);
    if (n < 0 || n > 100) return { ok: false, reason: `${part} fora de [0%,100%]` };
    numbers.push(n);
  }
  // Atalho do CSS: 1 valor = todos; 2 = vertical/horizontal; 3 = topo, laterais, base.
  const [a, b, c, d] = numbers as [number, number?, number?, number?];
  const [t, r, bottom, l] =
    numbers.length === 1 ? [a, a, a, a] : numbers.length === 2 ? [a, b!, a, b!] : numbers.length === 3 ? [a, b!, c!, b!] : [a, b!, c!, d!];
  return { ok: true, value: `inset(${CLEAN(t)}% ${CLEAN(r)}% ${CLEAN(bottom)}% ${CLEAN(l)}%)` };
}

const CIRCLE = /^circle\(\s*(\d+(?:\.\d+)?)%\s+at\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*\)$/;

function clipOf(value: unknown): Checked {
  if (typeof value !== "string") return { ok: false, reason: "use texto: inset(t% r% b% l%) ou circle(r% at x% y%)" };
  const text = value.trim();
  const inset = /^inset\((.*)\)$/.exec(text);
  if (inset) return insetOf(inset[1]!);
  const circle = CIRCLE.exec(text);
  if (circle) {
    const [r, x, y] = [Number(circle[1]), Number(circle[2]), Number(circle[3])];
    if (r > 150) return { ok: false, reason: `raio ${r}% fora de [0%,150%]` };
    if (x > 100 || y > 100) return { ok: false, reason: "centro fora de [0%,100%]" };
    return { ok: true, value: `circle(${CLEAN(r)}% at ${CLEAN(x)}% ${CLEAN(y)}%)` };
  }
  return { ok: false, reason: "use inset(t% r% b% l%) ou circle(r% at x% y%), sempre em %" };
}

function checkValue(key: (typeof VISUAL_KEYS)[number], value: unknown): Checked {
  switch (key) {
    case "opacity":
      return range(value, 0, 1, "fração");
    case "x":
    case "y":
      return distance(value);
    case "scale":
    case "scaleX":
    case "scaleY":
      return range(value, 0, 20, "fator");
    case "rotate":
      return range(value, -3600, 3600, "graus");
    case "blur":
      return range(value, 0, 200, "px");
    case "clip":
      return clipOf(value);
  }
}

/** `inset` ou `circle` de um valor de clip já normalizado. */
const clipShape = (value: MotionValue): "inset" | "circle" => (String(value).startsWith("inset") ? "inset" : "circle");

/**
 * Lê o atributo `data-keyframes`. JSON malformado, não-array e `time`/`volume` não finito ou
 * negativo continuam `E_NUMBER_INVALID` (o atributo inteiro é descartado). Os demais erros
 * (`E_KEYFRAME_INVALID`) descartam só o ponto com problema, porque o render já fica bloqueado.
 */
export function parseKeyframes(raw: string, ctx: KeyframeContext): ParsedKeyframes {
  const { clipId, own, diagnostics } = ctx;
  const empty: ParsedKeyframes = { volume: [], visual: [] };
  const invalid = (message: string, hint: string): void => {
    diagnostics.push(diag(CODES.KEYFRAME_INVALID, "error", `data-keyframes em "${clipId}": ${message}`, { clipId, hint }));
  };

  let list: unknown[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("não é array");
    list = parsed;
  } catch {
    diagnostics.push(diag(CODES.NUMBER_INVALID, "error", `data-keyframes inválido em "${clipId}"`, { clipId, hint: NUMBER_HINT }));
    return empty;
  }
  if (list.length > MAX_KEYFRAMES) {
    diagnostics.push(
      diag(CODES.KEYFRAME_LIMIT, "error", `data-keyframes em "${clipId}" tem ${list.length} pontos; o máximo é ${MAX_KEYFRAMES}`, {
        clipId,
        hint: `reduza para ${MAX_KEYFRAMES} pontos ou menos, ou divida o movimento em mais de um elemento`,
      }),
    );
    return empty;
  }

  // 1ª passada: tempo e volume (E_NUMBER_INVALID, como antes) para o atributo todo.
  const points: Array<Record<string, unknown>> = [];
  const times: number[] = [];
  const volumes: Array<number | undefined> = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      diagnostics.push(diag(CODES.NUMBER_INVALID, "error", `data-keyframes inválido em "${clipId}"`, { clipId, hint: NUMBER_HINT }));
      return empty;
    }
    const point = item as Record<string, unknown>;
    const time = Number(point["time"]);
    const volume = "volume" in point ? Number(point["volume"]) : undefined;
    if (!Number.isFinite(time) || time < 0 || (volume !== undefined && (!Number.isFinite(volume) || volume < 0))) {
      diagnostics.push(diag(CODES.NUMBER_INVALID, "error", `data-keyframes inválido em "${clipId}"`, { clipId, hint: NUMBER_HINT }));
      return empty;
    }
    points.push(point);
    times.push(time);
    volumes.push(volume);
  }

  const result: ParsedKeyframes = { volume: [], visual: [] };
  const seen = new Set<number>();
  const shapes = new Map<string, "inset" | "circle">();
  for (const [index, point] of points.entries()) {
    const at = `ponto ${index} (time ${times[index]})`;
    const known = new Set<string>([...VISUAL_KEYS, ...CAMERA_KEYS, ...OTHER_KEYS]);
    let ok = true;
    for (const key of Object.keys(point)) {
      if (!known.has(key)) {
        invalid(`${at} tem a chave desconhecida "${key}"`, `chaves aceitas: ${[...OTHER_KEYS, ...VISUAL_KEYS].join(", ")}`);
        ok = false;
      }
    }
    const camera = CAMERA_KEYS.filter((key) => key in point);
    if (camera.length > 0) {
      invalid(`${at} usa ${camera.join(", ")}, reservado à câmera`, "zoom e foco ainda não têm movimento: remova a chave");
      ok = false;
    }

    const volume = volumes[index];
    if (volume !== undefined) {
      if (!own) {
        invalid(`${at} tem volume num descendente`, "volume só vale no clip (o elemento temporizado): mova o ponto para o clip");
        ok = false;
      } else {
        result.volume.push({ time: times[index]!, volume });
      }
    }

    const values: Partial<Record<MotionProp, MotionValue>> = {};
    const visualKeys = VISUAL_KEYS.filter((key) => key in point);
    if (visualKeys.includes("scale") && (visualKeys.includes("scaleX") || visualKeys.includes("scaleY"))) {
      invalid(`${at} mistura scale com scaleX/scaleY`, "use scale (uniforme) ou scaleX e scaleY, não os dois");
      ok = false;
    }
    for (const key of visualKeys) {
      const checked = checkValue(key, point[key]);
      if (!checked.ok) {
        invalid(`${at}: ${key} ${checked.reason}`, `${key}: ${checked.reason}`);
        ok = false;
        continue;
      }
      if (key === "scale") {
        values.scaleX = checked.value;
        values.scaleY = checked.value;
      } else {
        values[key] = checked.value;
      }
    }

    if (visualKeys.length === 0 && volume === undefined && !camera.length) {
      invalid(`${at} não tem nenhuma propriedade`, "acrescente volume ou uma propriedade visual (opacity, x, y, scale, rotate, blur, clip)");
      ok = false;
    }

    let curve = "linear";
    if ("curve" in point) {
      const text = typeof point["curve"] === "string" ? point["curve"] : "";
      const resolved = resolveCurve(text);
      if (!resolved.curve) {
        diagnostics.push(
          diag(CODES.CURVE_INVALID, "error", `curva inválida em data-keyframes de "${clipId}", ${at}: ${JSON.stringify(point["curve"])} (${resolved.reason ?? "precisa ser texto"})`, {
            clipId,
            hint: "use cubic-bezier(0.3,0,0.2,1) ou um nome: linear, ease, suave, freio, arranque, vaivem, mola, mola-firme",
          }),
        );
        ok = false;
      } else {
        curve = text;
      }
      if (visualKeys.length === 0 && volume !== undefined) {
        diagnostics.push(
          diag(CODES.KEYFRAME_CURVE_IGNORED, "warning", `${at} de "${clipId}" tem curve, mas só volume: o volume é sempre linear`, {
            clipId,
            hint: "remova curve ou acrescente uma propriedade visual ao ponto",
          }),
        );
      }
    }

    if (visualKeys.length === 0) continue;
    if (seen.has(times[index]!)) {
      invalid(`${at} repete um time já usado`, "cada time pode aparecer uma vez entre os pontos visuais; junte as propriedades num ponto só");
      continue;
    }
    seen.add(times[index]!);

    if (values.clip !== undefined) {
      const shape = clipShape(values.clip);
      const before = shapes.get("clip");
      if (before !== undefined && before !== shape) {
        invalid(`${at} mistura ${shape} com ${before} na trilha clip`, "use só inset ou só circle em todos os pontos de clip");
        ok = false;
      }
      shapes.set("clip", before ?? shape);
    }
    if (ok) result.visual.push({ time: times[index]!, values, curve });
  }

  result.visual.sort((a, b) => a.time - b.time);
  return result;
}
