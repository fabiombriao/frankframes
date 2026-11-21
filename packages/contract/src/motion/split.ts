// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Tipografia cinética (docs/contract.md §7b.8): `data-split` divide o texto de um elemento
 * em unidades (palavra ou letra) e faz `data-enter`/`data-exit`/`data-emphasis` valerem por
 * unidade, com um atraso entre elas. A segmentação é compartilhada: o contrato conta e valida,
 * o producer reescreve o HTML com os mesmos cortes. Puro: sem DOM próprio nem I/O.
 */
import type { MotionSplit } from "../types.ts";
import { CODES } from "../errors.ts";
import { parseMotionValue, parseNumber, parseSeconds } from "./grammar.ts";
import { hasKeyframes, hasMotion, hasSplit, isHost, isTimed, motionAttrsOf, nodeAttr } from "./targets.ts";
import type { DomNode } from "./targets.ts";

export type SplitMode = "word" | "letter";
export type SplitOrder = "forward" | "reverse" | "center";

export const SPLIT_MODES: readonly SplitMode[] = ["word", "letter"];
export const SPLIT_ORDERS: readonly SplitOrder[] = ["forward", "reverse", "center"];
/** Segundos entre unidades quando `stagger=` não é dado. */
export const DEFAULT_STAGGER: Readonly<Record<SplitMode, number>> = { word: 0.06, letter: 0.03 };
/** Teto de `stagger`: acima disso o autor quase certamente errou a unidade. */
export const MAX_STAGGER = 10;

export interface TextPiece {
  text: string;
  /** `true` quando o pedaço é uma unidade animada; `false` é texto solto (espaço), preservado. */
  unit: boolean;
  /** Só no modo letter: índice da palavra (sequência sem espaço) a que a unidade pertence. */
  word?: number;
}

// Locale fixo "und": o resultado não depende do idioma da máquina. A versão do ICU do Node ainda
// pode mudar os cortes entre versões do Node; contrato e producer rodam no mesmo processo.
let wordSegmenter: Intl.Segmenter | undefined;
let graphemeSegmenter: Intl.Segmenter | undefined;
const words = (): Intl.Segmenter => (wordSegmenter ??= new Intl.Segmenter("und", { granularity: "word" }));
const graphemes = (): Intl.Segmenter => (graphemeSegmenter ??= new Intl.Segmenter("und", { granularity: "grapheme" }));

const BLANK = /^\s+$/u;

/** Junta pedaços soltos vizinhos: o texto solto é sempre um bloco só entre duas unidades. */
function pushLoose(out: TextPiece[], text: string): void {
  const last = out[out.length - 1];
  if (last !== undefined && !last.unit) last.text += text;
  else out.push({ text, unit: false });
}

/**
 * Divide `text` em unidades e texto solto. A soma dos `text` devolve a entrada exata.
 *
 * - `word`: cada segmento de palavra é uma unidade; espaço em branco fica solto; pontuação colada
 *   (sem espaço) gruda na unidade anterior, ou na seguinte se não houver anterior (`“Sim”`, `¿Qué?`).
 *   Pontuação ou emoji isolado entre espaços vira unidade própria, para animar com o resto.
 * - `letter`: um grafema por unidade (acento decomposto, emoji com modificador ou ZWJ contam como um);
 *   espaço em branco fica solto.
 */
export function splitText(text: string, mode: SplitMode): TextPiece[] {
  const out: TextPiece[] = [];
  if (mode === "letter") {
    let word = -1;
    let inWord = false;
    for (const { segment } of graphemes().segment(text)) {
      if (BLANK.test(segment)) {
        pushLoose(out, segment);
        inWord = false;
        continue;
      }
      if (!inWord) word++;
      inWord = true;
      out.push({ text: segment, unit: true, word });
    }
    return out;
  }

  let pending = ""; // pontuação inicial esperando a próxima palavra
  let glued: TextPiece | undefined; // unidade que ainda aceita pontuação colada
  const flushPending = (): void => {
    if (pending !== "") out.push({ text: pending, unit: true });
    pending = "";
  };
  for (const { segment, isWordLike } of words().segment(text)) {
    if (BLANK.test(segment)) {
      flushPending();
      glued = undefined;
      pushLoose(out, segment);
    } else if (isWordLike) {
      const piece: TextPiece = { text: pending + segment, unit: true };
      pending = "";
      out.push(piece);
      glued = piece;
    } else if (glued !== undefined) {
      glued.text += segment;
    } else {
      pending += segment;
    }
  }
  flushPending();
  return out;
}

/** Posto de cada unidade para o atraso: `forward` i, `reverse` n−1−i, `center` ⌊|i−(n−1)/2|⌋. */
export function unitRanks(count: number, order: SplitOrder): { ranks: number[]; max: number } {
  const ranks: number[] = [];
  for (let i = 0; i < count; i++) {
    if (order === "forward") ranks.push(i);
    else if (order === "reverse") ranks.push(count - 1 - i);
    else ranks.push(Math.floor(Math.abs(i - (count - 1) / 2)));
  }
  return { ranks, max: ranks.reduce((a, b) => Math.max(a, b), 0) };
}

// Elementos cujo texto não é texto de tela.
const NON_TEXT = new Set(["script", "style", "textarea", "title", "svg", "math", "noscript"]);

export interface SplitScan {
  /** Nós de texto alvo, em ordem de documento. */
  texts: DomNode[];
  /** Elementos com `data-unit`, em ordem de documento. */
  explicit: DomNode[];
  /** Descendentes com atributo de motion, `data-split` ou `data-keyframes`: não cabem dentro de um split. */
  inner: DomNode[];
  /** Elementos `data-unit` dentro de outro `data-unit`. */
  nested: DomNode[];
}

/**
 * Varre o escopo de `root` (o elemento com `data-split`): conteúdo de `<template>` e filhos, na ordem do
 * compilador. Clips temporizados e hosts dentro dele são de outro escopo e ficam de fora.
 */
export function scanSplit(root: DomNode): SplitScan {
  const scan: SplitScan = { texts: [], explicit: [], inner: [], nested: [] };
  const visit = (node: DomNode, inUnit: boolean): void => {
    for (const child of [...(node.content?.childNodes ?? []), ...(node.childNodes ?? [])]) {
      if (child.nodeName === "#comment") continue;
      if (child.nodeName === "#text") {
        scan.texts.push(child);
        continue;
      }
      if (isTimed(child) || isHost(child) || NON_TEXT.has(child.nodeName)) continue;
      const isUnit = nodeAttr(child, "data-unit") !== undefined;
      if (isUnit) {
        scan.explicit.push(child);
        if (inUnit) scan.nested.push(child);
      }
      if (hasMotion(child) || hasKeyframes(child) || hasSplit(child)) scan.inner.push(child);
      visit(child, inUnit || isUnit);
    }
  };
  visit(root, false);
  return scan;
}

/** Elementos `data-unit` que não estão dentro de nenhum `data-split` (esquecimento do autor). */
export function orphanUnits(clip: DomNode, host: boolean): DomNode[] {
  const orphans: DomNode[] = [];
  const visit = (node: DomNode, isClip: boolean, inSplit: boolean): void => {
    if (node.nodeName === "#text" || node.nodeName === "#comment") return;
    if (host && !isClip && (isTimed(node) || isHost(node))) return;
    const split = hasSplit(node);
    if (!isClip && nodeAttr(node, "data-unit") !== undefined && !inSplit && !split) orphans.push(node);
    for (const child of node.content?.childNodes ?? []) visit(child, false, inSplit || split);
    for (const child of node.childNodes ?? []) visit(child, false, inSplit || split);
  };
  visit(clip, true, false);
  return orphans;
}

export interface SplitProblem {
  code: string;
  message: string;
  hint: string;
}

export type SplitResult = { ok: true; split: MotionSplit } | { ok: false; problems: SplitProblem[] };

const SYNTAX_HINT = 'use data-split="word" ou data-split="letter", com stagger=<segundos> e order=forward|reverse|center se quiser';

/**
 * Valida `data-split` de `element` e conta as unidades (§7b.8). `where` identifica o elemento nas
 * mensagens. Devolve todos os problemas de uma vez; sem problemas, o `MotionSplit` pronto.
 */
export function buildSplit(element: DomNode, raw: string, where: string): SplitResult {
  const problems: SplitProblem[] = [];
  const parsed = parseMotionValue(raw);
  if (!parsed.ok) {
    return { ok: false, problems: [{ code: CODES.MOTION_SYNTAX, message: `data-split inválido em ${where}: ${parsed.message}`, hint: SYNTAX_HINT }] };
  }
  const mode = SPLIT_MODES.find((m) => m === parsed.preset);
  if (mode === undefined) {
    return {
      ok: false,
      problems: [{ code: CODES.MOTION_SYNTAX, message: `data-split de ${where}: modo desconhecido ${JSON.stringify(parsed.preset)}`, hint: SYNTAX_HINT }],
    };
  }

  let stagger = DEFAULT_STAGGER[mode];
  let order: SplitOrder = "forward";
  const bad = (message: string, hint: string): void => {
    problems.push({ code: CODES.MOTION_PARAM, message: `data-split de ${where}: ${message}`, hint });
  };
  for (const [key, text] of Object.entries(parsed.params)) {
    if (key === "stagger") {
      const seconds = parseSeconds(text);
      if (seconds === null || seconds > MAX_STAGGER) bad(`stagger inválido: ${JSON.stringify(text)}`, `stagger é segundos de 0 a ${MAX_STAGGER}, por exemplo stagger=0.08`);
      else stagger = seconds;
    } else if (key === "order") {
      const found = SPLIT_ORDERS.find((o) => o === text);
      if (found === undefined) bad(`order inválido: ${JSON.stringify(text)}`, `order: ${SPLIT_ORDERS.join(", ")}`);
      else order = found;
    } else {
      bad(`parâmetro desconhecido: ${key}`, "data-split aceita: stagger, order");
    }
  }

  const attrs = motionAttrsOf(element);
  if (attrs.enter === undefined && attrs.exit === undefined && attrs.emphasis === undefined) {
    problems.push({
      code: CODES.MOTION_TARGET,
      message: `data-split sem movimento em ${where}`,
      hint: "data-split precisa de data-enter, data-exit ou data-emphasis",
    });
  }

  const scan = scanSplit(element);
  for (const inner of scan.inner) {
    problems.push({
      code: CODES.MOTION_TARGET,
      message: `<${inner.nodeName}> dentro de data-split em ${where} tem atributo de motion`,
      hint: "o movimento vale por unidade no elemento com data-split; tire data-enter, data-exit, data-emphasis, data-split e data-keyframes do descendente",
    });
  }
  for (const nested of scan.nested) {
    problems.push({
      code: CODES.MOTION_TARGET,
      message: `data-unit dentro de outro data-unit em ${where} (<${nested.nodeName}>)`,
      hint: "marque só o elemento de fora com data-unit",
    });
  }

  const explicit = scan.explicit.length > 0;
  const units: MotionSplit["units"] = [];
  if (explicit) {
    for (const unit of scan.explicit) {
      const entry: MotionSplit["units"][number] = {};
      const value = (nodeAttr(unit, "data-unit") ?? "").trim();
      if (value !== "") {
        const seconds = parseNumber(value);
        if (seconds === null) bad(`data-unit inválido: ${JSON.stringify(value)}`, "data-unit é o início da entrada em segundos locais ao clip (0.4), ou vazio para seguir o stagger");
        else entry.anchor = seconds;
      }
      const style = nodeAttr(unit, "style");
      if (style !== undefined) entry.style = style;
      units.push(entry);
    }
  } else {
    for (const node of scan.texts) {
      for (const piece of splitText(node.value ?? "", mode)) if (piece.unit) units.push({});
    }
  }
  if (units.length === 0 && problems.length === 0) {
    problems.push({
      code: CODES.MOTION_TARGET,
      message: `data-split sem texto em ${where}`,
      hint: "data-split sem texto: ponha texto no elemento ou marque as unidades com data-unit",
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, split: { mode, stagger, order, explicit, units } };
}
