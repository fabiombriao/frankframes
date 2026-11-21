// FrankFrames — proprietário. Ver LICENSE na raiz.
// Edição de `data-keyframes` do próprio clip (docs/contract.md §9d, "Keyframes"). Puro: texto entra, texto sai.
import { CSS_PROP_OF, loadComposition, sampleTracks } from "@frankframes/contract";
import type { MotionProp, MotionValue, VisualKeyframe } from "@frankframes/contract";
import { applyPatches, EditError, locateClip, topLevelClip } from "./edit.ts";

/** Propriedade editável: as visuais do contrato, `scale` (uniforme) e o volume do áudio. */
export type KeyframeProp = MotionProp | "scale" | "volume";

export type KeyframeRequest =
  | { clipId: string; op: "add"; time: number; prop: KeyframeProp; value?: MotionValue; curve?: string }
  | { clipId: string; op: "move"; time: number; to: number }
  | { clipId: string; op: "remove"; time: number; prop?: KeyframeProp }
  | { clipId: string; op: "edit"; time: number; prop?: KeyframeProp; value?: MotionValue; curve?: string | null };

/** Ponto como o Studio o mostra: `time` local ao clip (segundos), as propriedades e a curva dos trechos que partem dele. */
export interface KeyframePoint {
  time: number;
  curve?: string;
  [prop: string]: MotionValue | undefined;
}

/** Dois tempos a menos disto (segundos) são o mesmo ponto. */
const SAME_TIME = 0.0005;

/** Ordem canônica das chaves do ponto no JSON; as desconhecidas vêm depois, na ordem em que estavam. */
const KEY_ORDER = ["time", "volume", "opacity", "x", "y", "scale", "scaleX", "scaleY", "rotate", "blur", "clip", "zoom", "focusX", "focusY", "curve"];
const VISUAL_KEYS = KEY_ORDER.filter((key) => key !== "time" && key !== "volume" && key !== "curve");
const CAMERA_KEYS = ["zoom", "focusX", "focusY"];
const SCALE_KEYS = ["scale", "scaleX", "scaleY"];

/** Valor neutro de cada propriedade, para o primeiro ponto onde nada anima a propriedade. */
const NEUTRAL: Record<string, MotionValue> = {
  opacity: 1,
  x: 0,
  y: 0,
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  rotate: 0,
  blur: 0,
  clip: "inset(0% 0% 0% 0%)",
  zoom: 1,
  focusX: 0.5,
  focusY: 0.5,
};

type RawPoint = Record<string, unknown>;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function roundTime(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EditError("E_KEYFRAME_OUT_OF_RANGE", `${what} precisa ser um número em segundos`);
  }
  return round3(value);
}

function attributeOf(node: { attrs?: Array<{ name: string; value: string }> }, name: string): string | undefined {
  for (const item of node.attrs ?? []) if (item.name === name) return item.value;
  return undefined;
}

/** Lê o JSON cru em pontos, juntando os que caem no mesmo tempo (o Studio trabalha com um ponto por tempo). */
function readRaw(raw: string | undefined, clipId: string): RawPoint[] {
  if (raw === undefined || raw.trim() === "") return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list) || list.some((item) => typeof item !== "object" || item === null || Array.isArray(item))) {
    throw new EditError("E_ATTRIBUTE_INVALID", `data-keyframes de "${clipId}" não é um array de pontos JSON; corrija no arquivo antes de editar`);
  }
  const points: RawPoint[] = [];
  for (const item of list as RawPoint[]) {
    const time = Number(item["time"]);
    if (!Number.isFinite(time)) {
      throw new EditError("E_ATTRIBUTE_INVALID", `data-keyframes de "${clipId}" tem ponto sem time numérico; corrija no arquivo antes de editar`);
    }
    const same = points.find((point) => Math.abs((point["time"] as number) - time) <= SAME_TIME);
    if (same === undefined) {
      points.push({ ...item, time });
      continue;
    }
    for (const [key, value] of Object.entries(item)) if (key !== "time" && same[key] === undefined) same[key] = value;
  }
  return points;
}

/** JSON canônico: pontos por `time`, chaves em ordem fixa, sem espaços. `null` quando não sobra ponto. */
function write(points: RawPoint[]): string | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => (a["time"] as number) - (b["time"] as number));
  const ordered = sorted.map((point) => {
    const out: RawPoint = {};
    for (const key of KEY_ORDER) if (point[key] !== undefined) out[key] = point[key];
    for (const key of Object.keys(point)) if (!KEY_ORDER.includes(key) && point[key] !== undefined) out[key] = point[key];
    return out;
  });
  return JSON.stringify(ordered);
}

function findAt(points: RawPoint[], time: number): RawPoint | undefined {
  return points.find((point) => Math.abs((point["time"] as number) - time) <= SAME_TIME);
}

function hasVisual(point: RawPoint): boolean {
  return VISUAL_KEYS.some((key) => point[key] !== undefined);
}

function checkProp(prop: unknown): KeyframeProp {
  if (prop === "volume" || (typeof prop === "string" && VISUAL_KEYS.includes(prop))) return prop as KeyframeProp;
  throw new EditError("E_KEYFRAME_PROP", `propriedade de keyframe desconhecida: ${JSON.stringify(prop)}`);
}

function checkValue(value: unknown): MotionValue {
  if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "string") return value;
  throw new EditError("E_ATTRIBUTE_INVALID", '"value" do keyframe precisa ser número ou texto');
}

function checkCurve(curve: unknown): string {
  if (typeof curve === "string") return curve;
  throw new EditError("E_ATTRIBUTE_INVALID", '"curve" do keyframe precisa ser texto (ou null para remover)');
}

/** Valor do volume em `time`: os pontos de volume interpolados linearmente, parados nas pontas; sem pontos, `data-volume`. */
function volumeAt(points: RawPoint[], fallback: number, time: number): number {
  const volumes = points
    .filter((point) => typeof point["volume"] === "number")
    .map((point) => ({ time: point["time"] as number, volume: point["volume"] as number }));
  if (volumes.length === 0) return fallback;
  if (time <= volumes[0]!.time) return volumes[0]!.volume;
  const last = volumes.at(-1)!;
  if (time >= last.time) return last.volume;
  const after = volumes.findIndex((item) => item.time > time);
  const a = volumes[after - 1]!;
  const b = volumes[after]!;
  return a.volume + ((b.volume - a.volume) * (time - a.time)) / (b.time - a.time);
}

/**
 * Edita `data-keyframes` do próprio clip (a escrita é canônica: pontos por tempo, chaves em ordem fixa, JSON sem
 * espaços entre aspas simples; sem pontos, o atributo some). `time` é local ao clip, em segundos, arredondado ao
 * milissegundo; pontos a menos de 0,5 ms valem o mesmo tempo.
 *
 * - `add`: acrescenta a propriedade no ponto daquele tempo (cria o ponto se não houver). Sem `value` usa o valor
 *   que a propriedade tem ali (`sampleTracks` sobre o motion resolvido; volume: a automação ou `data-volume`) ou
 *   o neutro. Propriedade já presente no ponto → `E_KEYFRAME_EXISTS`.
 * - `move`: leva o ponto inteiro para `to`. Tempo ocupado → `E_KEYFRAME_EXISTS`.
 * - `remove`: sem `prop` apaga o ponto; com `prop` apaga a propriedade (o ponto some quando fica vazio).
 * - `edit`: troca `value` (exige `prop`) e/ou `curve` (`null` remove) de um ponto existente.
 *
 * Função pura: o contrato do resultado (faixas dos valores, curva, mola curta, sobreposição com presets) é
 * validado por quem chama.
 */
export function editKeyframes(source: string, request: KeyframeRequest): string {
  const { clipId } = request;
  const composition = loadComposition(source);
  const clip = topLevelClip(composition, clipId, "E_KEYFRAME_PROP", "edite os keyframes no arquivo dela");
  const location = locateClip(source, clipId);
  if (clip.start === undefined || clip.end === undefined) {
    throw new EditError("E_KEYFRAME_OUT_OF_RANGE", `clip "${clipId}" não tem início e fim resolvidos; corrija o contrato antes`);
  }
  const duration = clip.end - clip.start;
  const inClip = (time: number, what: string): number => {
    const rounded = roundTime(time, what);
    if (rounded < 0 || rounded > duration + SAME_TIME) {
      throw new EditError(
        "E_KEYFRAME_OUT_OF_RANGE",
        `${what} ${rounded}s fora do clip "${clipId}" (0s a ${round3(duration)}s)`,
      );
    }
    return rounded;
  };

  const raw = attributeOf(location.node, "data-keyframes");
  const points = readRaw(raw, clipId);
  const time = inClip(request.time, "time");

  switch (request.op) {
    case "add": {
      const prop = checkProp(request.prop);
      if (prop === "volume" && clip.hasAudio !== true) {
        throw new EditError("E_KEYFRAME_PROP", `volume não vale em <${clip.tag}> "${clipId}": só em áudio ou vídeo com áudio`);
      }
      if (CAMERA_KEYS.includes(prop) && clip.tag !== "img" && clip.tag !== "video") {
        throw new EditError("E_KEYFRAME_PROP", `${prop} só vale em <img> e <video>, não em <${clip.tag}>`);
      }
      const point = findAt(points, time);
      const taken = point === undefined ? [] : SCALE_KEYS.includes(prop) ? SCALE_KEYS.filter((key) => point[key] !== undefined) : [prop].filter((key) => point[key] !== undefined);
      if (taken.length > 0) {
        throw new EditError("E_KEYFRAME_EXISTS", `já existe ${taken.join("/")} em ${time}s no clip "${clipId}"; edite o ponto em vez de adicionar`);
      }
      let value: MotionValue;
      if (request.value !== undefined) {
        value = checkValue(request.value);
      } else if (prop === "volume") {
        value = round3(volumeAt(points, clip.volume ?? 1, time));
      } else {
        const own = composition.motion[clipId]?.find((target) => target.ordinal === 0);
        const css = CSS_PROP_OF[(prop === "scale" ? "scaleX" : prop) as MotionProp];
        const sampled = own === undefined ? undefined : sampleTracks(own, time)[css];
        value = sampled === undefined ? NEUTRAL[prop]! : typeof sampled === "number" ? round3(sampled) : sampled;
      }
      const target = point ?? { time };
      target[prop] = value;
      if (request.curve !== undefined) target["curve"] = checkCurve(request.curve);
      if (point === undefined) points.push(target);
      break;
    }
    case "move": {
      const point = findAt(points, time);
      if (point === undefined) throw new EditError("E_KEYFRAME_NOT_FOUND", `não há keyframe em ${time}s no clip "${clipId}"`);
      const to = inClip(request.to, "to");
      const other = findAt(points, to);
      if (other !== undefined && other !== point) {
        throw new EditError("E_KEYFRAME_EXISTS", `já existe keyframe em ${to}s no clip "${clipId}"`);
      }
      point["time"] = to;
      break;
    }
    case "remove": {
      const point = findAt(points, time);
      if (point === undefined) throw new EditError("E_KEYFRAME_NOT_FOUND", `não há keyframe em ${time}s no clip "${clipId}"`);
      if (request.prop === undefined) {
        points.splice(points.indexOf(point), 1);
        break;
      }
      const prop = checkProp(request.prop);
      const gone = SCALE_KEYS.includes(prop) ? SCALE_KEYS : [prop];
      if (!gone.some((key) => point[key] !== undefined)) {
        throw new EditError("E_KEYFRAME_NOT_FOUND", `o keyframe em ${time}s do clip "${clipId}" não tem ${prop}`);
      }
      for (const key of gone) delete point[key];
      // Sem propriedade visual a curva não serve a nada; sem nenhuma propriedade o ponto some.
      if (!hasVisual(point)) delete point["curve"];
      if (point["volume"] === undefined && !hasVisual(point)) points.splice(points.indexOf(point), 1);
      break;
    }
    case "edit": {
      const point = findAt(points, time);
      if (point === undefined) throw new EditError("E_KEYFRAME_NOT_FOUND", `não há keyframe em ${time}s no clip "${clipId}"`);
      if (request.value === undefined && request.curve === undefined) {
        throw new EditError("E_ATTRIBUTE_INVALID", 'edição de keyframe sem "value" nem "curve"');
      }
      if (request.value !== undefined) {
        if (request.prop === undefined) throw new EditError("E_KEYFRAME_PROP", '"value" exige a propriedade ("prop") do keyframe');
        const prop = checkProp(request.prop);
        const value = checkValue(request.value);
        const present = SCALE_KEYS.includes(prop) ? SCALE_KEYS.filter((key) => point[key] !== undefined) : [prop].filter((key) => point[key] !== undefined);
        if (present.length === 0) {
          throw new EditError("E_KEYFRAME_NOT_FOUND", `o keyframe em ${time}s do clip "${clipId}" não tem ${prop}`);
        }
        // `scale` editado num ponto escrito com scaleX/scaleY fica uniforme nos dois eixos.
        for (const key of present) point[key] = value;
      }
      if (request.curve !== undefined) {
        if (request.curve === null) delete point["curve"];
        else point["curve"] = checkCurve(request.curve);
      }
      break;
    }
  }

  const json = write(points);
  if (json === raw) return source;
  return applyPatches(source, [{ clipId, attributes: { "data-keyframes": json }, singleQuoted: ["data-keyframes"] }]);
}

/**
 * Junta os pontos de volume e os visuais (já validados pelo contrato) num ponto por tempo, no formato que o
 * Studio mostra. `scaleX` e `scaleY` iguais viram `scale`.
 */
export function mergeKeyframePoints(volume: Array<{ time: number; volume: number }>, visual: VisualKeyframe[]): KeyframePoint[] {
  const points: KeyframePoint[] = [];
  const at = (time: number): KeyframePoint => {
    const found = points.find((point) => Math.abs(point.time - time) <= SAME_TIME);
    if (found !== undefined) return found;
    const created: KeyframePoint = { time };
    points.push(created);
    return created;
  };
  for (const item of volume) at(item.time)["volume"] = item.volume;
  for (const item of visual) {
    const point = at(item.time);
    const values = { ...item.values };
    if (values.scaleX !== undefined && values.scaleX === values.scaleY) {
      point["scale"] = values.scaleX;
      delete values.scaleX;
      delete values.scaleY;
    }
    for (const [key, value] of Object.entries(values)) point[key] = value;
    if (item.curve !== "linear") point.curve = item.curve;
  }
  return points.sort((a, b) => a.time - b.time);
}
