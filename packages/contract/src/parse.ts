// FrankFrames — proprietário. Ver LICENSE na raiz.
import { parse } from "parse5";
import type { Diagnostic, MotionSource, MotionSplit, RawClip, RawComposition } from "./types.ts";
import { CODES, diag } from "./errors.ts";
import { parseFps, parseTimeExpr } from "./timing.ts";
import { MEDIA_TAGS, hasMotion, hasSplit, isHost, isTimed, motionAttrsOf, motionElements, nestedStartElements } from "./motion/targets.ts";
import type { DomNode } from "./motion/targets.ts";
import { parseKeyframes } from "./motion/keyframes.ts";
import { buildSplit, orphanUnits } from "./motion/split.ts";

type P5Node = DomNode;

const MEDIA = MEDIA_TAGS;
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

/** Estado compartilhado da varredura: contador de ids gerados e elementos com motion. */
export interface ParseState {
  next: number;
  motion: MotionSource[];
}

function buildClip(
  node: P5Node,
  depth: number,
  ordinal: number,
  diagnostics: Diagnostic[],
  counter: ParseState,
): RawClip | undefined {
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

  for (const [name, raw] of [
    [ATTRS.offset, attr(node, ATTRS.offset)],
    [ATTRS.rate, attr(node, ATTRS.rate)],
    [ATTRS.volume, attr(node, ATTRS.volume)],
    ["data-fade-in", attr(node, "data-fade-in")],
    ["data-fade-out", attr(node, "data-fade-out")],
  ] as const) {
    if (raw !== undefined && raw.trim() !== "" && !Number.isFinite(Number(raw.trim()))) {
      diagnostics.push(
        diag(CODES.NUMBER_INVALID, "error", `${name} não numérico em "${id}": ${JSON.stringify(raw)}`, {
          clipId: id,
          hint: "use segundos decimais (1.5) — vírgula e sufixo como \"x\" não são aceitos",
        }),
      );
    }
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

  // `data-keyframes` do próprio clip: volume (áudio) e propriedades visuais (§7b.7).
  const rawKeyframes = attr(node, "data-keyframes");
  const ownKeyframes =
    rawKeyframes !== undefined && rawKeyframes.trim() !== ""
      ? parseKeyframes(rawKeyframes, { clipId: id, own: true, tag, diagnostics })
      : undefined;
  const keyframes = ownKeyframes !== undefined && ownKeyframes.volume.length > 0 ? ownKeyframes.volume : undefined;

  const role = attr(node, "data-audio-role");
  if (role !== undefined && !["voice", "music", "sfx"].includes(role)) {
    diagnostics.push(
      diag(CODES.NUMBER_INVALID, "error", `data-audio-role inválido em "${id}": ${JSON.stringify(role)}`, {
        clipId: id,
        hint: "use voice, music ou sfx",
      }),
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
        children.push(...collectClips(root, root, depth + 1, diagnostics, counter));
      }
    } else {
      children.push(...collectClips(node, node, depth + 1, diagnostics, counter));
    }
  }

  // Num clip comum o parser não desce: `data-start` num descendente não vira clip e o motion dele
  // conta a partir do clip dono (§7b.2). Avisar em vez de ignorar em silêncio.
  if (!isSubComposition) {
    for (const nested of nestedStartElements(node)) {
      const value = attr(nested, ATTRS.start) ?? "";
      const nestedId = attr(nested, ATTRS.clipId);
      const label = nestedId ? `<${nested.nodeName} data-clip-id="${nestedId}">` : `<${nested.nodeName}>`;
      diagnostics.push(
        diag(
          CODES.NESTED_START_IGNORED,
          "warning",
          `data-start="${value}" em ${label} dentro do clip "${id}" é ignorado: ele não vira clip e o motion dele usa o início do clip dono`,
          {
            clipId: id,
            hint: "tire o data-start e use at= (ou o time de data-keyframes) relativo ao clip, ou mova o elemento para o topo da composição ou para um host de sub-composição",
          },
        ),
      );
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
  if (keyframes !== undefined) clip.keyframes = keyframes;
  if (role === "voice" || role === "music" || role === "sfx") clip.audioRole = role;
  if (fadeIn !== undefined && fadeIn > 0) clip.fadeIn = fadeIn;
  if (fadeOut !== undefined && fadeOut > 0) clip.fadeOut = fadeOut;
  const src = attr(node, ATTRS.src);
  if (src) clip.src = src;
  const mediaSrc = attr(node, "src");
  if (mediaSrc) clip.mediaSrc = mediaSrc;
  const ownStyle = attr(node, "style");
  if (ownStyle !== undefined && !motionElements(node).includes(node)) {
    // Sem motion próprio, mas pode virar parceiro A de uma transição (§7b.10): o `style` serve à checagem de posse.
    counter.motion.push({ clipId: id, ordinal: 0, tag, own: true, attrs: {}, style: ownStyle });
  }
  for (const [position, element] of motionElements(node).entries()) {
    const own = element === node;
    const rawElementKeyframes = own ? undefined : attr(element, "data-keyframes");
    const parsedKeyframes = own
      ? ownKeyframes
      : rawElementKeyframes !== undefined && rawElementKeyframes.trim() !== ""
        ? parseKeyframes(rawElementKeyframes, { clipId: id, own: false, tag: element.nodeName, diagnostics })
        : undefined;
    const attrs = motionAttrsOf(element);
    const visual = parsedKeyframes?.visual ?? [];
    // `data-split` (§7b.8): validado aqui, onde há DOM para contar as unidades.
    const rawSplit = attr(element, "data-split");
    let split: MotionSplit | undefined;
    if (rawSplit !== undefined) {
      const built = buildSplit(element, rawSplit, `"${id}" (${element.nodeName}${own ? "" : ", descendente"})`);
      if (!built.ok) {
        for (const problem of built.problems) {
          diagnostics.push(diag(problem.code, "error", problem.message, { clipId: id, hint: problem.hint }));
        }
        continue;
      }
      split = built.split;
    }
    // Elemento só com volume (ou com keyframes inválidos) não é alvo de motion; o ordinal já foi contado.
    if (Object.keys(attrs).length === 0 && visual.length === 0) continue;
    const source: MotionSource = { clipId: id, ordinal: position, tag: element.nodeName, own, attrs };
    const style = attr(element, "style");
    if (style !== undefined) source.style = style;
    if (visual.length > 0) source.keyframes = visual;
    if (split !== undefined) source.split = split;
    counter.motion.push(source);
  }
  for (const orphan of orphanUnits(node, isSubComposition)) {
    diagnostics.push(
      diag(CODES.MOTION_TARGET, "error", `data-unit em <${orphan.nodeName}> fora de data-split em "${id}"`, {
        clipId: id,
        hint: 'data-unit só vale dentro de um elemento com data-split (por exemplo data-split="word")',
      }),
    );
  }
  if (MEDIA[tag] === true) clip.hasAudio = tag === "audio" || (tag === "video" && attr(node, "data-has-audio") !== "false");
  return clip;
}

/** Uma linha de timeline por clip; hosts e clips temporizados não são atravessados. */
export function collectClips(
  parent: P5Node,
  root: P5Node,
  depth: number,
  diagnostics: Diagnostic[],
  counter: ParseState = { next: 0, motion: [] },
): RawClip[] {
  const clips: RawClip[] = [];

  const visit = (node: P5Node): void => {
    if (depth > MAX_DEPTH) {
      diagnostics.push(
        diag(CODES.REF_CYCLE, "error", `aninhamento acima de ${MAX_DEPTH} níveis`, {
          hint: "una sub-composições por arquivo em vez de aninhar em profundidade",
        }),
      );
      return;
    }
    const timed = isTimed(node);
    const host = node !== root && isHost(node);
    if (!timed && node !== root && !host) {
      for (const child of node.childNodes ?? []) visit(child);
      return;
    }
    if (node === root) {
      for (const child of node.childNodes ?? []) visit(child);
      return;
    }
    const clip = buildClip(node, depth, counter.next++, diagnostics, counter);
    if (clip) clips.push(clip);
  };

  for (const child of parent.childNodes ?? []) visit(child);
  return clips;
}

/**
 * Motion na raiz ou fora de qualquer clip não tem a quem se ligar (§7b.2). Não desce
 * em clips nem hosts: o que há dentro deles pertence ao clip dono.
 */
function checkMotionOutsideClips(root: P5Node, diagnostics: Diagnostic[]): void {
  const visit = (node: P5Node, isRoot: boolean): void => {
    if (node.nodeName === "#text" || node.nodeName === "#comment") return;
    if (!isRoot && (isTimed(node) || isHost(node))) return;
    if (hasMotion(node) || hasSplit(node)) {
      const names = [...Object.keys(motionAttrsOf(node)).map((kind) => `data-${kind}`), ...(hasSplit(node) ? ["data-split"] : [])].join(", ");
      diagnostics.push(
        diag(CODES.MOTION_TARGET, "error", `${names} em <${node.nodeName}> fora de qualquer clip${isRoot ? " (é a raiz)" : ""}`, {
          hint: "coloque o atributo num elemento temporizado (data-start) ou dentro dele",
        }),
      );
    }
    for (const child of node.childNodes ?? []) visit(child, false);
  };
  visit(root, true);
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
    return { id: "", fps: { num: 30, den: 1 }, clips: [], motion: [], diagnostics };
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

  const state: ParseState = { next: 0, motion: [] };
  const clips = collectClips(root, root, 1, diagnostics, state);
  checkMotionOutsideClips(root, diagnostics);

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

  const composition: RawComposition = { id, fps, clips, motion: state.motion, diagnostics };
  if (width !== undefined) composition.width = width;
  if (height !== undefined) composition.height = height;
  if (authoredDuration !== undefined && authoredDuration > 0) composition.authoredDuration = authoredDuration;
  return composition;
}
