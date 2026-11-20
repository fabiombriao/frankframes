// FrankFrames — proprietário. Ver LICENSE na raiz.
import { parse } from "parse5";
import type { Diagnostic, RawClip, RawComposition } from "./types.ts";
import { CODES, diag } from "./errors.ts";
import { parseFps, parseTimeExpr } from "./timing.ts";

interface P5Node {
  nodeName: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: P5Node[];
  content?: { childNodes: P5Node[] };
}

const MEDIA: Record<string, true> = { video: true, audio: true, img: true };
const MAX_DEPTH = 20;

export const ATTRS = {
  id: "data-composition-id",
  root: "data-root",
  start: "data-start",
  duration: "data-duration",
  offset: "data-offset",
  rate: "data-playback-rate",
  volume: "data-volume",
  track: "data-track",
  clipId: "data-clip-id",
  src: "data-composition-src",
  width: "data-width",
  height: "data-height",
  fps: "data-fps",
} as const;

function attr(node: P5Node, name: string): string | undefined {
  for (const a of node.attrs ?? []) if (a.name === name) return a.value;
  return undefined;
}

function has(node: P5Node, name: string): boolean {
  return (node.attrs ?? []).some((a) => a.name === name);
}

function num(raw: string | undefined): number | undefined {
  const v = (raw ?? "").trim();
  if (v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function* elements(nodes: P5Node[] | undefined): Generator<P5Node> {
  for (const n of nodes ?? []) {
    yield n;
    yield* elements(n.childNodes);
  }
}

function* includingTemplates(nodes: P5Node[] | undefined): Generator<P5Node> {
  for (const n of nodes ?? []) {
    yield n;
    yield* includingTemplates(n.content?.childNodes);
    yield* includingTemplates(n.childNodes);
  }
}

/** Raiz: `[data-composition-id][data-root="true"]`, senão o primeiro em ordem de documento. */
export function findRoot(doc: P5Node): P5Node | undefined {
  let first: P5Node | undefined;
  for (const node of elements(doc.childNodes)) {
    if (!has(node, ATTRS.id)) continue;
    if (attr(node, ATTRS.root) === "true") return node;
    first ??= node;
  }
  return first;
}

function templateRoot(template: P5Node): P5Node {
  for (const node of includingTemplates(template.content?.childNodes)) {
    if (node.nodeName !== "#text" && has(node, ATTRS.id)) return node;
  }
  return { nodeName: "#fragment", childNodes: template.content?.childNodes ?? [] };
}

function buildClip(node: P5Node, depth: number, ordinal: number, diagnostics: Diagnostic[]): RawClip | undefined {
  const tag = node.nodeName;
  const rawId = attr(node, ATTRS.clipId) ?? attr(node, ATTRS.id);
  const id = rawId && rawId.trim() !== "" ? rawId.trim() : `${tag}#${ordinal}`;

  const startExpr = parseTimeExpr(attr(node, ATTRS.start), 0);
  if (!startExpr) {
    diagnostics.push(
      diag(CODES.START_INVALID, "error", `data-start inválido em "${id}": ${JSON.stringify(attr(node, ATTRS.start))}`, {
        clipId: id,
        hint: 'use um número de segundos, um id de clip, ou "id + 1" / "id - 0.5"',
      }),
    );
    return undefined;
  }

  const duration = num(attr(node, ATTRS.duration));
  if (duration !== undefined && duration < 0) {
    diagnostics.push(
      diag(CODES.DURATION_INVALID, "error", `data-duration negativo em "${id}"`, {
        clipId: id,
        hint: "duração é segundos >= 0; remova o atributo para derivar do conteúdo",
      }),
    );
    return undefined;
  }

  const offset = num(attr(node, ATTRS.offset)) ?? 0;
  if (offset < 0) {
    diagnostics.push(
      diag(CODES.OFFSET_INVALID, "error", `data-offset negativo em "${id}"`, {
        clipId: id,
        hint: "data-offset é o instante dentro da fonte; não pode ser negativo",
      }),
    );
  }

  let rate = num(attr(node, ATTRS.rate)) ?? 1;
  if (rate < 0.1 || rate > 10) {
    diagnostics.push(
      diag(CODES.RATE_CLAMPED, "warning", `data-playback-rate ${rate} fora de [0.1, 10] em "${id}"; ajustado`, {
        clipId: id,
      }),
    );
    rate = Math.min(10, Math.max(0.1, rate));
  }

  const volume = num(attr(node, ATTRS.volume));
  if (volume !== undefined && volume < 0) {
    diagnostics.push(
      diag(CODES.VOLUME_INVALID, "error", `data-volume negativo em "${id}"`, { clipId: id, hint: "ganho linear: 0 = silêncio, 1 = 0 dB" }),
    );
  } else if (volume !== undefined && volume > 4) {
    diagnostics.push(
      diag(CODES.VOLUME_HIGH, "warning", `data-volume ${volume} em "${id}" amplifica +12 dB ou mais`, { clipId: id }),
    );
  }

  const fadeIn = num(attr(node, "data-fade-in"));
  const fadeOut = num(attr(node, "data-fade-out"));
  for (const [name, value] of [["data-fade-in", fadeIn], ["data-fade-out", fadeOut]] as const) {
    if (value !== undefined && value < 0) {
      diagnostics.push(
        diag(CODES.FADE_INVALID, "error", `${name} negativo em "${id}"`, {
          clipId: id,
          hint: "fade é segundos >= 0",
        }),
      );
    }
  }

  const rawTrack = attr(node, ATTRS.track);
  let track = 0;
  if (rawTrack !== undefined) {
    const parsed = Number(rawTrack.trim());
    if (Number.isInteger(parsed)) track = parsed;
    else diagnostics.push(diag(CODES.TRACK_INVALID, "warning", `data-track não inteiro em "${id}"; assumido 0`, { clipId: id }));
  }

  const isSubComposition = has(node, ATTRS.src) || has(node, ATTRS.id);

  // Host de sub-composição é uma fronteira de escopo: o conteúdo dele (dentro de
  // `<template>` ou como filhos diretos) é outra composição, com tempo local.
  const children: RawClip[] = [];
  let nestedDuration: number | undefined;
  if (isSubComposition) {
    const template = [...elements(node.childNodes)].find((n) => n.nodeName === "template");
    if (template) {
      const root = templateRoot(template);
      if (root !== node) {
        nestedDuration = num(attr(root, ATTRS.duration));
        children.push(...collectClips(root, root, depth + 1, diagnostics));
      }
    } else {
      children.push(...collectClips(node, node, depth + 1, diagnostics));
    }
  }

  const clip: RawClip = {
    id,
    tag,
    startExpr,
    offset,
    playbackRate: rate,
    track,
    isMedia: MEDIA[tag] === true,
    isSubComposition,
    depth,
    children,
  };
  const authored = duration ?? nestedDuration;
  if (authored !== undefined) clip.authoredDuration = authored;
  if (volume !== undefined) clip.volume = volume;
  if (fadeIn !== undefined && fadeIn > 0) clip.fadeIn = fadeIn;
  if (fadeOut !== undefined && fadeOut > 0) clip.fadeOut = fadeOut;
  const src = attr(node, ATTRS.src);
  if (src) clip.src = src;
  const mediaSrc = attr(node, "src");
  if (mediaSrc) clip.mediaSrc = mediaSrc;
  if (MEDIA[tag] === true) clip.hasAudio = tag === "audio" || attr(node, "data-has-audio") !== "false";
  return clip;
}

/** Uma linha de timeline por clip; hosts e clips temporizados não são atravessados. */
export function collectClips(parent: P5Node, root: P5Node, depth: number, diagnostics: Diagnostic[]): RawClip[] {
  const clips: RawClip[] = [];
  let ordinal = 0;

  const visit = (node: P5Node): void => {
    if (depth > MAX_DEPTH) {
      diagnostics.push(
        diag(CODES.REF_CYCLE, "error", `aninhamento acima de ${MAX_DEPTH} níveis`, {
          hint: "una sub-composições por arquivo em vez de aninhar em profundidade",
        }),
      );
      return;
    }
    const timed = has(node, ATTRS.start) || (has(node, ATTRS.track) && has(node, ATTRS.duration)) || MEDIA[node.nodeName] === true;
    const host = node !== root && (has(node, ATTRS.src) || has(node, ATTRS.id));
    if (!timed && node !== root && !host) {
      for (const child of node.childNodes ?? []) visit(child);
      return;
    }
    if (node === root) {
      for (const child of node.childNodes ?? []) visit(child);
      return;
    }
    const clip = buildClip(node, depth, ordinal++, diagnostics);
    if (clip) clips.push(clip);
  };

  for (const child of parent.childNodes ?? []) visit(child);
  return clips;
}

export function parseComposition(html: string): RawComposition {
  const doc = parse(html) as unknown as P5Node;
  const diagnostics: Diagnostic[] = [];
  const root = findRoot(doc);
  if (!root) {
    diagnostics.push(
      diag(CODES.NO_ROOT, "error", "nenhum elemento com data-composition-id", {
        hint: "envolva a composição em um elemento com data-composition-id",
      }),
    );
    return { id: "", fps: { num: 30, den: 1 }, clips: [], diagnostics };
  }

  const id = (attr(root, ATTRS.id) ?? "").trim();
  if (id === "") diagnostics.push(diag(CODES.NO_ROOT, "error", "data-composition-id vazio", { hint: "use um identificador estável" }));

  let fps = parseFps(attr(root, ATTRS.fps), { num: 30, den: 1 });
  if (!fps) {
    diagnostics.push(
      diag(CODES.FPS_INVALID, "error", `data-fps inválido: ${JSON.stringify(attr(root, ATTRS.fps))}`, {
        hint: 'use inteiro ("30") ou racional exato ("30000/1001")',
      }),
    );
    fps = { num: 30, den: 1 };
  }

  let width = num(attr(root, ATTRS.width));
  let height = num(attr(root, ATTRS.height));
  for (const [name, value] of [["width", width], ["height", height]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      diagnostics.push(diag(CODES.SIZE_INVALID, "error", `data-${name} inválido`, { hint: "pixels inteiros > 0" }));
      if (name === "width") width = undefined;
      else height = undefined;
    }
  }

  const authoredDuration = num(attr(root, ATTRS.duration));
  if (authoredDuration !== undefined && authoredDuration <= 0) {
    diagnostics.push(
      diag(CODES.DURATION_INVALID, "error", "data-duration da raiz deve ser > 0", { hint: "remova para derivar dos clips" }),
    );
  }

  if (has(root, ATTRS.start) && (parseTimeExpr(attr(root, ATTRS.start), 0)?.kind !== "absolute" || num(attr(root, ATTRS.start)) !== 0)) {
    diagnostics.push(
      diag(CODES.ROOT_START_IGNORED, "warning", "data-start na raiz é ignorado; a raiz sempre começa em 0", { hint: "remova o atributo da raiz" }),
    );
  }

  const clips = collectClips(root, root, 1, diagnostics);

  const seen = new Set<string>();
  const checkDuplicates = (list: RawClip[]): void => {
    for (const clip of list) {
      if (seen.has(clip.id)) {
        diagnostics.push(
          diag(CODES.DUPLICATE_ID, "error", `id de clip duplicado: "${clip.id}"`, {
            clipId: clip.id,
            hint: "ids são o alvo de data-start; precisam ser únicos",
          }),
        );
      }
      seen.add(clip.id);
      checkDuplicates(clip.children);
    }
  };
  checkDuplicates(clips);

  const composition: RawComposition = { id, fps, clips, diagnostics };
  if (width !== undefined) composition.width = width;
  if (height !== undefined) composition.height = height;
  if (authoredDuration !== undefined && authoredDuration > 0) composition.authoredDuration = authoredDuration;
  return composition;
}
