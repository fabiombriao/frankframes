// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Quais elementos carregam motion e quem é o clip dono (docs/contract.md §7b.2). */
import type { MotionKind } from "../types.ts";

export interface DomNode {
  nodeName: string;
  /** Conteúdo de um nó `#text`. */
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: DomNode[];
  content?: { childNodes: DomNode[] };
}

export const MOTION_ATTRS: Readonly<Record<MotionKind, string>> = {
  enter: "data-enter",
  exit: "data-exit",
  emphasis: "data-emphasis",
  camera: "data-camera",
  transition: "data-transition",
};

export const MEDIA_TAGS: Readonly<Record<string, true>> = { video: true, audio: true, img: true };

export function nodeAttr(node: DomNode, name: string): string | undefined {
  for (const a of node.attrs ?? []) if (a.name === name) return a.value;
  return undefined;
}

function hasAttr(node: DomNode, name: string): boolean {
  return (node.attrs ?? []).some((a) => a.name === name);
}

/** Elemento temporizado (§4): `data-start`, `data-track`+`data-duration`, ou mídia. */
export function isTimed(node: DomNode): boolean {
  return (
    hasAttr(node, "data-start") ||
    (hasAttr(node, "data-track") && hasAttr(node, "data-duration")) ||
    MEDIA_TAGS[node.nodeName] === true
  );
}

/** Host de sub-composição (§5): `data-composition-src` ou `data-composition-id`. */
export function isHost(node: DomNode): boolean {
  return hasAttr(node, "data-composition-src") || hasAttr(node, "data-composition-id");
}

export function motionAttrsOf(node: DomNode): Partial<Record<MotionKind, string>> {
  const out: Partial<Record<MotionKind, string>> = {};
  for (const [kind, name] of Object.entries(MOTION_ATTRS) as Array<[MotionKind, string]>) {
    const value = nodeAttr(node, name);
    if (value !== undefined) out[kind] = value;
  }
  return out;
}

export function hasMotion(node: DomNode): boolean {
  return Object.keys(motionAttrsOf(node)).length > 0;
}

/** `data-keyframes` presente e não vazio: pode trazer volume ou propriedades visuais (§7b.7). */
export function hasKeyframes(node: DomNode): boolean {
  return (nodeAttr(node, "data-keyframes") ?? "").trim() !== "";
}

/** `data-split` presente (§7b.8): o elemento é alvo mesmo sem `data-enter`, para o erro dele aparecer. */
export function hasSplit(node: DomNode): boolean {
  return nodeAttr(node, "data-split") !== undefined;
}

/**
 * Elementos com motion de um clip, na ordem do documento: o próprio clip e os
 * descendentes. Num host de sub-composição, descendentes temporizados ou hosts são
 * clips do próprio escopo e ficam de fora; num clip comum não há clips dentro
 * (o parser não os atravessa), então tudo é descendente.
 * Conteúdo de `<template>` entra antes dos filhos, como no compilador.
 * O índice nesta lista é o `ordinal` de `MotionSource`.
 */
export function motionElements<T extends DomNode>(clip: T): T[] {
  const out: T[] = [];
  const host = isHost(clip);
  const visit = (node: DomNode, isClip: boolean): void => {
    if (node.nodeName === "#text" || node.nodeName === "#comment") return;
    if (host && !isClip && (isTimed(node) || isHost(node))) return;
    if (hasMotion(node) || hasKeyframes(node) || hasSplit(node)) out.push(node as T);
    for (const child of node.content?.childNodes ?? []) visit(child, false);
    for (const child of node.childNodes ?? []) visit(child, false);
  };
  visit(clip, true);
  return out;
}

/**
 * Descendentes de um clip comum que declaram `data-start` e, por isso, parecem clips mas não são:
 * o parser não desce num clip comum (§7b.2). Quem chama não passa hosts de sub-composição, onde o
 * temporizado interno é clip do escopo. Hosts aninhados entram na lista (o `data-start` deles também
 * é ignorado) mas não são atravessados. O critério é o atributo, não `isTimed`: mídia sem `data-start` não conta.
 */
export function nestedStartElements<T extends DomNode>(clip: T): T[] {
  const out: T[] = [];
  const visit = (node: DomNode): void => {
    if (node.nodeName === "#text" || node.nodeName === "#comment") return;
    if (hasAttr(node, "data-start")) out.push(node as T);
    if (isHost(node)) return;
    for (const child of node.content?.childNodes ?? []) visit(child);
    for (const child of node.childNodes ?? []) visit(child);
  };
  for (const child of clip.content?.childNodes ?? []) visit(child);
  for (const child of clip.childNodes ?? []) visit(child);
  return out;
}
