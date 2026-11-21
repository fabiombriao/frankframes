// FrankFrames — proprietário. Ver LICENSE na raiz.
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse, serialize } from "parse5";
import { loadComposition } from "@frankframes/contract";
import type { Composition, ResolvedClip } from "@frankframes/contract";
import { annotateMotion } from "./motion.ts";

interface P5Node {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: P5Node[];
  content?: { childNodes: P5Node[] };
  value?: string;
}

export const MAX_DEPTH = 20;
const MEDIA: Record<string, true> = { video: true, audio: true, img: true };

function attr(node: P5Node, name: string): string | undefined {
  for (const a of node.attrs ?? []) if (a.name === name) return a.value;
  return undefined;
}

function setAttr(node: P5Node, name: string, value: string): void {
  node.attrs ??= [];
  const existing = node.attrs.find((a) => a.name === name);
  if (existing) existing.value = value;
  else node.attrs.push({ name, value });
}

function removeAttr(node: P5Node, name: string): void {
  if (!node.attrs) return;
  node.attrs = node.attrs.filter((a) => a.name !== name);
}

function* walk(nodes: P5Node[] | undefined): Generator<P5Node> {
  for (const node of nodes ?? []) {
    yield node;
    yield* walk(node.content?.childNodes);
    yield* walk(node.childNodes);
  }
}

function cloneNode(node: P5Node): P5Node {
  const copy: P5Node = { nodeName: node.nodeName };
  if (node.tagName !== undefined) copy.tagName = node.tagName;
  if (node.value !== undefined) copy.value = node.value;
  if (node.attrs) copy.attrs = node.attrs.map((a) => ({ ...a }));
  if (node.childNodes) copy.childNodes = node.childNodes.map(cloneNode);
  if (node.content) copy.content = { childNodes: node.content.childNodes.map(cloneNode) };
  return copy;
}

/** Prefixa URLs relativas com o diretório do arquivo que foi inlinado. */
function rewriteUrls(nodes: P5Node[] | undefined, prefix: string): void {
  if (prefix === "") return;
  const isExternal = (value: string): boolean => /^(?:[a-z]+:|\/|#|data:)/i.test(value);

  for (const node of walk(nodes)) {
    if (node.nodeName === "#text") continue;
    for (const name of ["src", "href", "poster", "data-src"]) {
      const value = attr(node, name);
      if (value !== undefined && !isExternal(value)) setAttr(node, name, prefix + value);
    }
    const style = attr(node, "style");
    if (style?.includes("url(")) {
      setAttr(node, "style", style.replace(/url\((['"]?)(?!data:|https?:|\/)([^'")]+)\1\)/g, `url($1${prefix}$2$1)`));
    }
  }
}

interface MergeContext {
  entryDir: string;
  depth: number;
  ancestors: string[];
  warnings: string[];
}

/** `<style>`, `<script>` e `<link>` do `<head>` do arquivo inlinado. */
function headAssets(document: P5Node): P5Node[] {
  const head = [...walk(document.childNodes)].find((node) => node.nodeName === "head");
  return (head?.childNodes ?? [])
    .filter((node) => ["style", "script", "link"].includes(node.nodeName))
    .map(cloneNode);
}

async function inlineNode(node: P5Node, ctx: MergeContext): Promise<void> {
  const source = attr(node, "data-composition-src");
  if (source === undefined) {
    await inlineAll(node.childNodes, ctx);
    return;
  }

  const absolute = resolve(ctx.entryDir, source);
  const relativePath = relative(ctx.entryDir, absolute);
  if (isAbsolute(source) || relativePath.startsWith("..")) {
    ctx.warnings.push(`data-composition-src fora do diretório da entrada ignorado: ${source}`);
    removeAttr(node, "data-composition-src");
    return;
  }
  if (ctx.ancestors.includes(absolute)) {
    ctx.warnings.push(`referência circular ignorada: ${source}`);
    removeAttr(node, "data-composition-src");
    return;
  }
  if (ctx.depth >= MAX_DEPTH) {
    ctx.warnings.push(`aninhamento acima de ${MAX_DEPTH} níveis ignorado em ${source}`);
    removeAttr(node, "data-composition-src");
    return;
  }

  const html = await readFile(absolute, "utf8");
  const document = parse(html) as unknown as P5Node;
  const root = [...walk(document.childNodes)].find((candidate) => candidate.nodeName !== "#text" && attr(candidate, "data-composition-id") !== undefined);
  const inlined = [...headAssets(document), ...(root?.childNodes ?? []).map(cloneNode)];

  const prefix = relative(ctx.entryDir, dirname(absolute)).split(sep).join("/");
  rewriteUrls(inlined, prefix === "" ? "" : `${prefix}/`);

  await inlineAll(inlined, { ...ctx, depth: ctx.depth + 1, ancestors: [...ctx.ancestors, absolute] });

  node.childNodes = [...(node.childNodes ?? []).filter((child) => child.nodeName !== "template"), ...inlined];
  removeAttr(node, "data-composition-src");

  const innerDuration = root ? attr(root, "data-duration") : undefined;
  if (innerDuration !== undefined && attr(node, "data-duration") === undefined) setAttr(node, "data-duration", innerDuration);
  const innerStyle = root ? attr(root, "style") : undefined;
  if (innerStyle !== undefined && attr(node, "style") === undefined) setAttr(node, "style", innerStyle);
}

async function inlineAll(nodes: P5Node[] | undefined, ctx: MergeContext): Promise<void> {
  if (!nodes) return;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    // `<template>` é inerte: o conteúdo vira nós reais do documento.
    if (node.nodeName === "template" && node.content) {
      const children = [...node.content.childNodes];
      await inlineAll(children, ctx);
      nodes.splice(i, 1, ...children);
      i += children.length - 1;
      continue;
    }
    await inlineNode(node, ctx);
  }
}

export interface MergeResult {
  html: string;
  warnings: string[];
}

/**
 * Junta sub-composições de arquivo (`data-composition-src`) e `<template>`
 * inline numa única página, reescrevendo caminhos relativos. Não resolve tempo:
 * isso é o passo de anotação, que precisa do contrato já resolvido.
 */
export async function mergeSubCompositions(entryHtml: string, entryDir: string, entryPath?: string): Promise<MergeResult> {
  const document = parse(entryHtml) as unknown as P5Node;
  const entry = resolve(entryPath ?? resolve(entryDir, "index.html"));
  const ctx: MergeContext = { entryDir: resolve(entryDir), depth: 0, ancestors: [entry], warnings: [] };
  await inlineAll(document.childNodes, ctx);
  return { html: serialize(document as never), warnings: ctx.warnings };
}

/**
 * Escreve `data-clip-id` nos elementos que o contrato identifica por id gerado
 * (`<tag>#<n>`). Sem isso, o tempo anotado não teria a quem se ligar no DOM.
 */
export function materializeClipIds(html: string): string {
  const document = parse(html) as unknown as P5Node;
  const counter = { next: 0 };

  const visit = (node: P5Node): void => {
    if (node.nodeName === "#text") return;
    const isCompositionRoot = node.nodeName !== "#document" && attr(node, "data-composition-id") !== undefined;
    const host = isCompositionRoot || attr(node, "data-composition-src") !== undefined;
    const timed =
      attr(node, "data-start") !== undefined ||
      (attr(node, "data-track") !== undefined && attr(node, "data-duration") !== undefined) ||
      MEDIA[node.nodeName] === true;

    if ((host || timed) && attr(node, "data-clip-id") === undefined && !isCompositionRoot) {
      setAttr(node, "data-clip-id", `${node.nodeName}#${counter.next++}`);
    }
    if (host || !timed) for (const child of node.childNodes ?? []) visit(child);
  };

  for (const child of document.childNodes ?? []) visit(child);
  return serialize(document as never);
}

interface Timing {
  start: number;
  end?: number;
  compStart: number;
}

function collectTiming(clips: ResolvedClip[], compStart: number, into: Map<string, Timing>): void {
  for (const clip of clips) {
    const absoluteStart = compStart + (clip.start ?? 0);
    into.set(clip.id, {
      start: absoluteStart,
      end: clip.end === undefined ? undefined : compStart + clip.end,
      compStart,
    });
    collectTiming(clip.children, absoluteStart, into);
  }
}

export interface AnnotateResult {
  html: string;
  annotations: number;
}

function annotateDocument(document: P5Node, composition: Composition): number {
  const timings = new Map<string, Timing>();
  collectTiming(composition.clips, 0, timings);

  let annotations = 0;
  for (const node of walk(document.childNodes)) {
    if (node.nodeName === "#text") continue;
    const id = attr(node, "data-clip-id") ?? attr(node, "data-composition-id");
    if (id === undefined) continue;
    const timing = timings.get(id);
    if (!timing) continue;
    setAttr(node, "data-ff-start", String(Math.floor(timing.start * 1000)));
    if (timing.end !== undefined) setAttr(node, "data-ff-end", String(Math.ceil(timing.end * 1000)));
    setAttr(node, "data-ff-comp-start", String(Math.floor(timing.compStart * 1000)));
    annotations++;
  }
  return annotations;
}

/**
 * Escreve o tempo resolvido no DOM: `data-ff-start`/`data-ff-end` em ms e
 * `data-ff-comp-start` no host da sub-composição. O runtime só lê esses valores;
 * toda a decisão de tempo fica no compilador.
 *
 * Início arredonda para baixo e fim para cima: o clip nunca perde o primeiro ou
 * o último frame por causa do truncamento de milissegundo.
 */
export function annotateTiming(html: string, composition: Composition): AnnotateResult {
  const document = parse(html) as unknown as P5Node;
  const annotations = annotateDocument(document, composition);
  return { html: serialize(document as never), annotations };
}

export interface CompiledAnnotation extends AnnotateResult {
  /** Alvos que receberam `data-ff-motion`. */
  motion: number;
}

/** Tempo resolvido + motion, num parse só: o motion lê o `data-ff-comp-start` recém-escrito. */
export function annotateCompiled(html: string, composition: Composition): CompiledAnnotation {
  const document = parse(html) as unknown as P5Node;
  const annotations = annotateDocument(document, composition);
  const motion = annotateMotion(document, composition);
  return { html: serialize(document as never), annotations, motion };
}

/** Conveniência do producer: merge + ids + contrato + anotação numa chamada. */
export async function compileComposition(options: {
  entryHtml: string;
  entryDir: string;
  entryPath?: string;
  mediaDurations?: Record<string, number>;
}): Promise<{ html: string; composition: Composition; warnings: string[]; annotations: number }> {
  const merged = await mergeSubCompositions(options.entryHtml, options.entryDir, options.entryPath);
  const materialized = materializeClipIds(merged.html);
  const composition = loadComposition(materialized, { mediaDurations: options.mediaDurations ?? {} });
  if (!composition.ok) {
    return { html: materialized, composition, warnings: merged.warnings, annotations: 0 };
  }
  const annotated = annotateCompiled(materialized, composition);
  return { html: annotated.html, composition, warnings: merged.warnings, annotations: annotated.annotations };
}
