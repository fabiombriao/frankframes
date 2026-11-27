// FrankFrames — proprietário. Ver LICENSE na raiz.
import { parse } from "parse5";
import { ATTRS, findRoot, listPresets, loadComposition, MIN_DURATION_SECONDS, parseMotionValue } from "@frankframes/contract";
import type { Composition, ResolvedClip } from "@frankframes/contract";

interface P5Location {
  startOffset: number;
  endOffset: number;
  startTag?: { startOffset: number; endOffset: number };
  endTag?: { startOffset: number; endOffset: number };
  attrs?: Record<string, { startOffset: number; endOffset: number }>;
}

interface P5Node {
  nodeName: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: P5Node[];
  content?: { childNodes: P5Node[] };
  sourceCodeLocation?: P5Location | null;
}

export interface ClipTextPart {
  index: number;
  tag: string;
  text: string;
}

export interface ClipPatch {
  clipId: string;
  /** `null` remove o atributo. */
  attributes?: Record<string, string | null>;
  /** Substitui o texto do elemento — só quando ele tem um único nó de texto. */
  text?: string;
  /** Edita nós de texto sem substituir os elementos que os contêm. */
  textParts?: Array<{ index: number; original: string; text: string }>;
  /**
   * Atributos escritos entre aspas simples (JSON legível: `data-keyframes='[{"time":1}]'`). O valor
   * guarda `"` sem escape; só `&` e `'` viram entidade.
   */
  singleQuoted?: string[];
}

/** Códigos das edições do Studio (`applyEdits`, split, trim, copy, keyframes, legendas): entram no `docs/reference/diagnostics.md`. */
export const EDIT_ERROR_CODES = [
  "E_CLIP_NOT_FOUND",
  "E_AMBIGUOUS_CLIP",
  "E_TEXT_NOT_EDITABLE",
  "E_ATTRIBUTE_INVALID",
  "E_SPLIT_UNSUPPORTED",
  "E_SPLIT_OUT_OF_RANGE",
  "E_DELETE_UNSUPPORTED",
  "E_TRIM_OUT_OF_RANGE",
  "E_TRIM_UNSUPPORTED",
  "E_COPY_UNSUPPORTED",
  "E_COPY_OUT_OF_RANGE",
  "E_TRANSITION_GAP",
  "E_KEYFRAME_NOT_FOUND",
  "E_KEYFRAME_EXISTS",
  "E_KEYFRAME_PROP",
  "E_KEYFRAME_OUT_OF_RANGE",
  "E_CAPTIONS_LEGACY",
  "E_CAPTIONS_CUE_NOT_FOUND",
] as const;
export type EditCode = (typeof EDIT_ERROR_CODES)[number];

export class EditError extends Error {
  readonly code: EditCode;
  readonly hint?: string;

  constructor(code: EditError["code"], message: string, hint?: string) {
    super(message);
    this.name = "EditError";
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

function attr(node: P5Node, name: string): string | undefined {
  for (const item of node.attrs ?? []) if (item.name === name) return item.value;
  return undefined;
}

function* walk(nodes: P5Node[] | undefined): Generator<P5Node> {
  for (const node of nodes ?? []) {
    yield node;
    yield* walk(node.content?.childNodes);
    yield* walk(node.childNodes);
  }
}

function findClips(document: P5Node, clipId: string): P5Node[] {
  const found: P5Node[] = [];
  for (const node of walk(document.childNodes)) {
    if (node.nodeName === "#text") continue;
    if (attr(node, "data-clip-id") === clipId || attr(node, "data-composition-id") === clipId) found.push(node);
  }
  return found;
}

const ATTRIBUTE_NAME = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;

interface Replacement {
  start: number;
  end: number;
  text: string;
}

/** Aplica trocas de trás para frente para não deslocar as posições seguintes. */
function applyReplacements(source: string, replacements: Replacement[]): string {
  const ordered = [...replacements].sort((a, b) => b.start - a.start);
  let result = source;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const replacement of ordered) {
    if (replacement.end > lastStart) throw new EditError("E_AMBIGUOUS_CLIP", "duas edições sobrepostas no mesmo elemento");
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
    lastStart = replacement.start;
  }
  return result;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const NON_VISUAL_TEXT = new Set([
  "script", "style", "template", "noscript", "title", "textarea",
  "iframe", "xmp", "noembed", "noframes", "plaintext", "audio", "video", "canvas",
]);
type TextRange = Omit<ClipTextPart, "index"> & Pick<Replacement, "start" | "end">;

function* clipTextRanges(node: P5Node): Generator<TextRange> {
  if (NON_VISUAL_TEXT.has(node.nodeName)) return;
  const children = node.childNodes ?? [];
  const location = node.sourceCodeLocation;
  if (children.length === 0 && location?.startTag && location.endTag) {
    yield { tag: node.nodeName, text: "", start: location.startTag.endOffset, end: location.endTag.startOffset };
    return;
  }
  for (const child of children) {
    if (child.nodeName === "#text") {
      const range = child.sourceCodeLocation;
      const value = child.value ?? "";
      if (range && (value.trim() !== "" || children.length === 1)) {
        yield { tag: node.nodeName, text: value, start: range.startOffset, end: range.endOffset };
      }
    } else if (attr(child, "data-composition-id") === undefined &&
      attr(child, "data-composition-src") === undefined) {
      yield* clipTextRanges(child);
    }
  }
}

/** Texto autoral dos clips no próprio arquivo, indexado uma vez para o inspetor. */
export function authoredClipText(source: string): Map<string, { text: string | null; parts: ClipTextPart[] }> {
  const result = new Map<string, { text: string | null; parts: ClipTextPart[] }>();
  for (const node of walk(parseSource(source).childNodes)) {
    const id = attr(node, "data-clip-id");
    if (id === undefined || result.has(id)) continue;
    if (attr(node, "data-composition-src") !== undefined) continue;
    const parts = Array.from(clipTextRanges(node), ({ tag, text }, index) => ({ index, tag, text }));
    const plain = (node.childNodes ?? []).every((child) => child.nodeName === "#text");
    result.set(id, { text: plain ? parts[0]?.text.trim() ?? null : null, parts });
  }
  return result;
}

/** `nome="valor"`, ou `nome='valor'` quando o patch pede aspas simples para esse atributo. */
function attributeText(patch: ClipPatch, name: string, value: string): string {
  if (patch.singleQuoted?.includes(name) !== true) return `${name}="${escapeAttribute(value)}"`;
  return `${name}='${value.replace(/&/g, "&amp;").replace(/'/g, "&#39;")}'`;
}

/** Trocas que levam os atributos de `patch.attributes` para a tag de abertura (`null` remove, ausente acrescenta). */
function attributeReplacements(
  source: string,
  startTag: { startOffset: number; endOffset: number },
  attrs: P5Location["attrs"],
  patch: ClipPatch,
): Replacement[] {
  const out: Replacement[] = [];
  for (const [name, value] of Object.entries(patch.attributes ?? {})) {
    if (!ATTRIBUTE_NAME.test(name)) throw new EditError("E_ATTRIBUTE_INVALID", `atributo inválido: ${name}`);
    const range = attrs?.[name];
    if (value === null) {
      if (!range) continue;
      // Remove o espaço anterior junto com "nome=valor".
      const start = source[range.startOffset - 1] === " " ? range.startOffset - 1 : range.startOffset;
      out.push({ start, end: range.endOffset, text: "" });
    } else if (range) {
      out.push({ start: range.startOffset, end: range.endOffset, text: attributeText(patch, name, value) });
    } else {
      // Elemento vazio `<img ... />`: o atributo entra antes do espaço e da barra, não depois dela.
      let at = startTag.endOffset - 1;
      if (source[at - 1] === "/") at = source[at - 2] === " " ? at - 2 : at - 1;
      out.push({ start: at, end: at, text: ` ${attributeText(patch, name, value)}` });
    }
  }
  return out;
}

/**
 * Edita atributos e texto mantendo o arquivo original intacto fora dos trechos
 * alterados — usa a localização do parse5 em vez de re-serializar o documento.
 */
export function applyPatches(source: string, patches: ClipPatch[]): string {
  const document = parseSource(source);
  const replacements: Replacement[] = [];

  for (const patch of patches) {
    const matches = findClips(document, patch.clipId);
    if (matches.length === 0) throw new EditError("E_CLIP_NOT_FOUND", `clip "${patch.clipId}" não existe`);
    if (matches.length > 1) throw new EditError("E_AMBIGUOUS_CLIP", `clip "${patch.clipId}" aparece ${matches.length} vezes`);
    const node = matches[0]!;
    const location = node.sourceCodeLocation;
    if (!location?.startTag) throw new EditError("E_CLIP_NOT_FOUND", `clip "${patch.clipId}" sem localização no arquivo`);

    replacements.push(...attributeReplacements(source, location.startTag, location.attrs, patch));

    if (patch.textParts !== undefined) {
      if (patch.text !== undefined) {
        throw new EditError("E_TEXT_NOT_EDITABLE", 'envie "text" ou "textParts"');
      }
      const parts = Array.from(clipTextRanges(node));
      const seen = new Set<number>();
      for (const { index, original, text } of patch.textParts) {
        const part = parts[index];
        if (!part || part.text !== original || seen.has(index)) {
          throw new EditError("E_TEXT_NOT_EDITABLE", `trecho inválido ou alterado no clip "${patch.clipId}"; recarregue o inspetor`);
        }
        seen.add(index);
        if (text !== original) replacements.push({ start: part.start, end: part.end, text: escapeText(text) });
      }
    }

    if (patch.text !== undefined) {
      const children = node.childNodes ?? [];
      const texts = children.filter((child) => child.nodeName === "#text");
      if (texts.length !== 1 || children.length !== 1) {
        throw new EditError("E_TEXT_NOT_EDITABLE", `clip "${patch.clipId}" tem marcação interna; edite o texto no arquivo`);
      }
      const textNode = texts[0]!;
      const range = textNode.sourceCodeLocation;
      if (!range) throw new EditError("E_TEXT_NOT_EDITABLE", `clip "${patch.clipId}" sem localização de texto`);
      replacements.push({
        start: range.startOffset,
        end: range.endOffset,
        text: escapeText(patch.text),
      });
    }
  }

  return applyReplacements(source, replacements);
}

/** Menor pedaço que um split pode deixar de cada lado, em segundos. */
const MIN_SPLIT_PIECE = 0.001;

function seconds(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

function flatten(clips: ResolvedClip[], into: ResolvedClip[] = []): ResolvedClip[] {
  for (const clip of clips) {
    into.push(clip);
    flatten(clip.children, into);
  }
  return into;
}

function parseSource(source: string): P5Node {
  return parse(source, { sourceCodeLocationInfo: true }) as unknown as P5Node;
}

/** Campos da raiz editáveis pelo inspetor de Composição (§9d). Campo ausente não é tocado. */
export interface CompositionPatch {
  /** Segundos. `null` remove `data-duration`: a duração passa a ser derivada dos clips (§7). */
  duration?: number | null;
  width?: number;
  height?: number;
  /** `"30"` ou racional exato `"30000/1001"`; o contrato valida. */
  fps?: string;
}

/**
 * Grava `data-duration`, `data-width`, `data-height` e `data-fps` na raiz, no mesmo ponto do arquivo e sem
 * reformatar o resto. Aqui só o tipo do valor é conferido; faixa e formato (inteiro > 0, fps racional,
 * duração > 0) são do contrato, que o chamador roda sobre o resultado antes de gravar.
 */
export function editComposition(source: string, patch: CompositionPatch): string {
  const attributes: Record<string, string | null> = {};
  if (patch.duration !== undefined) {
    if (patch.duration !== null && !Number.isFinite(patch.duration)) {
      throw new EditError("E_ATTRIBUTE_INVALID", '"duration" precisa ser número em segundos ou null (derivada)');
    }
    attributes[ATTRS.duration] = patch.duration === null ? null : seconds(patch.duration);
  }
  for (const [key, name] of [["width", ATTRS.width], ["height", ATTRS.height]] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value)) throw new EditError("E_ATTRIBUTE_INVALID", `"${key}" precisa ser número`);
    attributes[name] = String(value);
  }
  if (patch.fps !== undefined) {
    if (typeof patch.fps !== "string" || patch.fps.trim() === "") {
      throw new EditError("E_ATTRIBUTE_INVALID", '"fps" precisa ser texto como "30" ou "30000/1001"');
    }
    attributes[ATTRS.fps] = patch.fps.trim();
  }
  if (Object.keys(attributes).length === 0) {
    throw new EditError("E_ATTRIBUTE_INVALID", "nenhum campo da composição para editar (duration, width, height, fps)");
  }

  const root = findRoot(parseSource(source) as unknown as Parameters<typeof findRoot>[0]) as unknown as P5Node | undefined;
  const location = root?.sourceCodeLocation;
  if (root === undefined || !location?.startTag) {
    throw new EditError("E_CLIP_NOT_FOUND", "raiz da composição (data-composition-id) não encontrada no arquivo");
  }
  return applyReplacements(source, attributeReplacements(source, location.startTag, location.attrs, { clipId: "", attributes }));
}

export interface ClipLocation {
  node: P5Node;
  /** Offsets do elemento inteiro (abertura até fechamento) no arquivo. */
  start: number;
  end: number;
}

/** Ids com `data-clip-id` explícito, uma única vez, no arquivo. Só esses clips são editáveis. */
export function explicitClipIds(source: string): Set<string> {
  const seen = new Map<string, number>();
  for (const node of walk(parseSource(source).childNodes)) {
    if (node.nodeName === "#text") continue;
    const id = attr(node, "data-clip-id");
    if (id !== undefined) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, count]) => count === 1).map(([id]) => id));
}

/** Localiza o elemento com `data-clip-id` explícito; exatamente um, senão `E_CLIP_NOT_FOUND`. */
export function locateClip(source: string, clipId: string): ClipLocation {
  const nodes = [...walk(parseSource(source).childNodes)].filter(
    (node) => node.nodeName !== "#text" && attr(node, "data-clip-id") === clipId,
  );
  if (nodes.length !== 1) {
    throw new EditError("E_CLIP_NOT_FOUND", `clip "${clipId}" precisa de data-clip-id explícito no arquivo para ser editado`);
  }
  const node = nodes[0]!;
  const location = node.sourceCodeLocation;
  if (!location) throw new EditError("E_CLIP_NOT_FOUND", `clip "${clipId}" sem localização no arquivo`);
  return { node, start: location.startOffset, end: location.endOffset };
}

/** Clip da raiz (não aninhado em sub-composição). `code` é o erro da operação; `hint` completa a frase. */
export function topLevelClip(
  composition: Composition,
  clipId: string,
  code: EditError["code"],
  hint = "edite no arquivo dela",
): ResolvedClip {
  const clip = flatten(composition.clips).find((item) => item.id === clipId);
  if (clip === undefined) throw new EditError("E_CLIP_NOT_FOUND", `clip "${clipId}" não existe`);
  if (!composition.clips.includes(clip)) {
    throw new EditError(code, `clip "${clipId}" está dentro de uma sub-composição; ${hint}`);
  }
  return clip;
}

/**
 * Clips fora de `ids` cujo `data-start` referencia o fim de algum clip de `ids`.
 * Quem for reescrito precisa ter `data-clip-id` no arquivo; senão lança `code`.
 */
export function referrersOf(all: ResolvedClip[], ids: Set<string>, source: string, code: EditError["code"]): ResolvedClip[] {
  const referrers = all.filter(
    (item) => !ids.has(item.id) && item.startExpr.kind === "reference" && ids.has(item.startExpr.refId),
  );
  const known = referrers.length > 0 ? explicitClipIds(source) : new Set<string>();
  for (const referrer of referrers) {
    if (!known.has(referrer.id)) {
      const target = referrer.startExpr.kind === "reference" ? referrer.startExpr.refId : "";
      throw new EditError(code, `clip "${referrer.id}" referencia "${target}" mas não tem data-clip-id no arquivo`);
    }
  }
  return referrers;
}

/** Remove o trecho; se a linha ficar só com espaço, remove a linha inteira. */
export function removeRange(source: string, start: number, end: number): string {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const newline = source.indexOf("\n", end);
  const lineEnd = newline === -1 ? source.length : newline;
  const alone = /^[ \t]*$/.test(source.slice(lineStart, start)) && /^[ \t\r]*$/.test(source.slice(end, lineEnd));
  if (alone) {
    const after = newline === -1 ? source.length : newline + 1;
    return source.slice(0, lineStart) + source.slice(after);
  }
  return source.slice(0, start) + source.slice(end);
}

/** Sufixo de `data-start` por referência: `" + 1.5"`, `" - 0.2"` ou vazio. */
export function refSuffix(offset: number): string {
  return offset > 0 ? ` + ${seconds(offset)}` : offset < 0 ? ` - ${seconds(-offset)}` : "";
}

export interface SplitRequest {
  clipId: string;
  /** Instante do corte, em segundos desde o início da composição. */
  at: number;
  /** Id da segunda metade; precisa ser livre. */
  newId: string;
}

/**
 * Divide um clip da raiz em dois no instante `at`. A primeira metade fica com o
 * id original e perde o fade de saída; a segunda é uma cópia do elemento que
 * começa no fim da primeira (`data-start="<id>"`), perde o fade de entrada e,
 * se for mídia, avança `data-offset` pelo trecho já tocado. Quem referenciava o
 * fim do clip original passa a referenciar o fim da segunda metade, então nada
 * mais na timeline se move.
 */
export function splitClip(source: string, request: SplitRequest): string {
  const { clipId, at, newId } = request;
  if (!Number.isFinite(at)) throw new EditError("E_SPLIT_OUT_OF_RANGE", "instante do corte precisa ser número");
  if (!/^[A-Za-z0-9_.:-]+$/.test(newId)) throw new EditError("E_ATTRIBUTE_INVALID", `id inválido: ${newId}`);

  const composition = loadComposition(source);
  const all = flatten(composition.clips);
  if (all.some((clip) => clip.id === newId)) throw new EditError("E_AMBIGUOUS_CLIP", `id "${newId}" já existe`);
  const clip = topLevelClip(composition, clipId, "E_SPLIT_UNSUPPORTED", "divida no arquivo dela");
  if (clip.isSubComposition || clip.children.length > 0) {
    throw new EditError("E_SPLIT_UNSUPPORTED", `clip "${clipId}" contém outros clips; dividir copiaria a sub-timeline inteira`);
  }
  if (clip.keyframes !== undefined) {
    throw new EditError("E_SPLIT_UNSUPPORTED", `clip "${clipId}" tem data-keyframes; remova a automação antes de dividir`);
  }
  // Cada metade herdaria o motion inteiro: a entrada repetiria no corte e a saída nunca chegaria.
  if (composition.motion[clip.id] !== undefined) {
    throw new EditError(
      "E_SPLIT_UNSUPPORTED",
      `clip "${clipId}" tem atributos de motion (data-enter/exit/emphasis); remova-os antes de dividir`,
    );
  }
  if (clip.start === undefined || clip.end === undefined) {
    throw new EditError("E_SPLIT_UNSUPPORTED", `clip "${clipId}" não tem início e fim resolvidos`);
  }
  if (at <= clip.start + MIN_SPLIT_PIECE || at >= clip.end - MIN_SPLIT_PIECE) {
    throw new EditError(
      "E_SPLIT_OUT_OF_RANGE",
      `corte em ${seconds(at)}s fora do clip "${clipId}" (${seconds(clip.start)}s a ${seconds(clip.end)}s)`,
    );
  }

  const location = locateClip(source, clipId);
  // Quem referencia o clip precisa ter id no arquivo para ser reescrito.
  const referrers = referrersOf(all, new Set([clipId]), source, "E_SPLIT_UNSUPPORTED");

  const first = at - clip.start;
  const copyAttributes: Record<string, string | null> = {
    "data-clip-id": newId,
    "data-start": clipId,
    "data-duration": seconds(clip.end - at),
    "data-fade-in": null,
  };
  if (clip.tag === "video" || clip.tag === "audio") copyAttributes["data-offset"] = seconds(clip.offset + first * clip.playbackRate);
  const copy = applyPatches(source.slice(location.start, location.end), [{ clipId, attributes: copyAttributes }]);

  const lineStart = source.lastIndexOf("\n", location.start - 1) + 1;
  const lead = source.slice(lineStart, location.start);
  const separator = /^[ \t]*$/.test(lead) ? `\n${lead}` : "";
  const inserted = source.slice(0, location.end) + separator + copy + source.slice(location.end);

  const patches: ClipPatch[] = [{ clipId, attributes: { "data-duration": seconds(first), "data-fade-out": null } }];
  for (const referrer of referrers) {
    const offset = referrer.startExpr.kind === "reference" ? referrer.startExpr.offset : 0;
    patches.push({ clipId: referrer.id, attributes: { "data-start": `${newId}${refSuffix(offset)}` } });
  }
  return applyPatches(inserted, patches);
}

export interface DuplicateRequest {
  clipId: string;
  /** Início da cópia, em segundos desde o começo da composição (≥ 0). */
  at: number;
  /** Id da cópia; precisa ser livre. */
  newId: string;
}

export interface DuplicateResult {
  source: string;
  /** Coisas que a cópia não carrega ou que o autor deve olhar. */
  warnings: string[];
}

/**
 * Copia um clip da raiz, com tudo o que há dentro dele, para logo depois do original (mesmo pai, mesma
 * indentação). A cópia começa em `at` (`data-start` absoluto) e ganha `data-clip-id=newId`; todo
 * descendente com id passa a `<newId>-<id>` e os `data-start` internos que apontavam para eles seguem
 * a renomeação (referência para fora da cópia fica como está). Nenhum outro clip é tocado.
 * `data-transition` da raiz não é copiado (a cópia deixa de encostar no parceiro): vira aviso.
 */
export function duplicateClip(source: string, request: DuplicateRequest): DuplicateResult {
  const { clipId, at, newId } = request;
  if (!Number.isFinite(at) || at < 0) throw new EditError("E_COPY_OUT_OF_RANGE", "início da cópia precisa ser um número ≥ 0");
  if (!/^[A-Za-z0-9_.:-]+$/.test(newId)) throw new EditError("E_ATTRIBUTE_INVALID", `id inválido: ${newId}`);

  const composition = loadComposition(source);
  const all = flatten(composition.clips);
  const clip = topLevelClip(composition, clipId, "E_COPY_UNSUPPORTED", "copie o clip no arquivo da sub-composição");
  const location = locateClip(source, clipId);

  const byId = new Map(all.map((item) => [item.id, item]));
  const inside = flatten([clip]);
  // Ids que a cópia cria: o da raiz vira `newId`; os dos descendentes, `<newId>-<id>`.
  const renamed = new Map<string, string>(inside.map((item) => [item.id, item.id === clipId ? newId : `${newId}-${item.id}`]));
  for (const created of renamed.values()) {
    if (all.some((item) => item.id === created) || explicitClipIds(source).has(created)) {
      throw new EditError("E_AMBIGUOUS_CLIP", `id "${created}" já existe`);
    }
  }

  const warnings: string[] = [];
  const text = source.slice(location.start, location.end);
  const snippet = parseSource(text);
  const replacements: Replacement[] = [];
  const replaceAttribute = (node: P5Node, name: string, value: string | null): void => {
    const range = node.sourceCodeLocation?.attrs?.[name];
    // Todo clip tem `data-clip-id` e `data-start` (é o que o faz clip): nada a inserir, só trocar.
    if (!range) return;
    if (value === null) {
      const start = text[range.startOffset - 1] === " " ? range.startOffset - 1 : range.startOffset;
      replacements.push({ start, end: range.endOffset, text: "" });
    } else {
      replacements.push({ start: range.startOffset, end: range.endOffset, text: `${name}="${escapeAttribute(value)}"` });
    }
  };

  const seenHtmlIds = new Set<string>();
  for (const node of walk(snippet.childNodes)) {
    if (node.nodeName === "#text") continue;
    const htmlId = attr(node, "id");
    if (htmlId !== undefined && !seenHtmlIds.has(htmlId)) {
      seenHtmlIds.add(htmlId);
      warnings.push(`id HTML duplicado: ${htmlId}`);
    }
    // O id do clip vem de `data-clip-id`, ou de `data-composition-id` quando não há o primeiro.
    const idAttribute = attr(node, "data-clip-id") !== undefined ? "data-clip-id" : attr(node, "data-composition-id") !== undefined ? "data-composition-id" : undefined;
    if (idAttribute === undefined) continue;
    const oldId = attr(node, idAttribute)!;
    const created = renamed.get(oldId);
    if (created === undefined) continue;
    replaceAttribute(node, idAttribute, created);

    if (oldId === clipId) {
      replaceAttribute(node, "data-start", seconds(at));
      if (attr(node, "data-transition") !== undefined) {
        replaceAttribute(node, "data-transition", null);
        warnings.push("transição não copiada");
      }
      continue;
    }
    const expr = byId.get(oldId)?.startExpr;
    if (expr?.kind === "reference" && renamed.has(expr.refId)) {
      replaceAttribute(node, "data-start", `${renamed.get(expr.refId)}${refSuffix(expr.offset)}`);
    }
  }
  const copy = applyReplacements(text, replacements);

  const lineStart = source.lastIndexOf("\n", location.start - 1) + 1;
  const lead = source.slice(lineStart, location.start);
  const separator = /^[ \t]*$/.test(lead) ? `\n${lead}` : "";
  return { source: source.slice(0, location.end) + separator + copy + source.slice(location.end), warnings };
}

export interface DeleteRequest {
  clipId: string;
}

/**
 * Exclui um clip da raiz e tudo o que está dentro dele sem mover mais nada. Quem começava no fim
 * dele (`data-start="<id>"` ou `"<id> + x"`) ganha `data-start` absoluto igual ao início que já
 * tinha; se esse clip era a segunda ponta de uma transição com o excluído, `data-transition` sai
 * junto (o par deixou de existir), e o início continua o mesmo. Recusa (`E_DELETE_UNSUPPORTED`)
 * quando o cálculo atravessaria escopos: o `data-start` por referência resolve por id no arquivo
 * todo, mas o número que sai é do escopo do referenciador.
 */
export function deleteClip(source: string, request: DeleteRequest): string {
  const { clipId } = request;
  const composition = loadComposition(source);
  const all = flatten(composition.clips);
  const clip = topLevelClip(composition, clipId, "E_DELETE_UNSUPPORTED", "edite o arquivo da sub-composição");
  locateClip(source, clipId);
  const removed = new Set(flatten([clip]).map((item) => item.id));
  const referrers = referrersOf(all, removed, source, "E_DELETE_UNSUPPORTED");

  const patches: ClipPatch[] = [];
  for (const referrer of referrers) {
    const target = referrer.startExpr.kind === "reference" ? referrer.startExpr.refId : "";
    // Mesmo escopo: referenciador na raiz apontando para o próprio clip (não para um descendente).
    if (!composition.clips.includes(referrer) || target !== clipId) {
      throw new EditError(
        "E_DELETE_UNSUPPORTED",
        `clip "${referrer.id}" referencia "${target}" a partir de outro escopo; ajuste o data-start dele no arquivo antes de excluir`,
      );
    }
    if (referrer.start === undefined) {
      throw new EditError("E_DELETE_UNSUPPORTED", `clip "${referrer.id}" não tem início resolvido; corrija o contrato antes de excluir`);
    }
    const attributes: Record<string, string | null> = { "data-start": seconds(referrer.start) };
    if (attr(locateClip(source, referrer.id).node, "data-transition") !== undefined) attributes["data-transition"] = null;
    patches.push({ clipId: referrer.id, attributes });
  }

  const patched = patches.length > 0 ? applyPatches(source, patches) : source;
  const location = locateClip(patched, clipId);
  return removeRange(patched, location.start, location.end);
}

export interface TrimStartRequest {
  clipId: string;
  /** Novo início, em segundos no tempo da raiz (o mesmo de `clip.start`). */
  start: number;
}

/**
 * Apara o clip pela borda esquerda: o início vai para `start` e o fim fica onde estava. Em vídeo/áudio
 * `data-offset` avança `delta × data-playback-rate` (o trecho cortado é o começo da fonte); `data-start`
 * por referência continua referência, só muda o deslocamento. O motion (`data-enter` etc.) é local ao
 * clip e passa a tocar no novo início. Como o fim não muda, quem referencia o clip não se move.
 */
export function trimClipStart(source: string, request: TrimStartRequest): string {
  const { clipId, start } = request;
  if (!Number.isFinite(start)) throw new EditError("E_TRIM_OUT_OF_RANGE", "início precisa ser número");
  const composition = loadComposition(source);
  const clip = topLevelClip(composition, clipId, "E_TRIM_UNSUPPORTED", "apare no arquivo dela");
  if (clip.isSubComposition || clip.children.length > 0) {
    throw new EditError("E_TRIM_UNSUPPORTED", `clip "${clipId}" contém outros clips; aparar deslocaria a sub-timeline`);
  }
  if (clip.keyframes !== undefined) {
    throw new EditError("E_TRIM_UNSUPPORTED", `clip "${clipId}" tem data-keyframes; o tempo local mudaria, remova a automação antes de aparar`);
  }
  if (clip.start === undefined || clip.end === undefined) {
    throw new EditError("E_TRIM_UNSUPPORTED", `clip "${clipId}" não tem início e fim resolvidos; declare data-duration`);
  }
  const location = locateClip(source, clipId);
  // A sobreposição da transição é o deslocamento de data-start; aparar a mudaria (ou a invalidaria).
  if (attr(location.node, "data-transition") !== undefined) {
    throw new EditError("E_TRIM_UNSUPPORTED", `clip "${clipId}" tem data-transition; remova a transição antes de aparar`);
  }

  const maxStart = clip.end - MIN_DURATION_SECONDS;
  if (start < 0 || start > maxStart) {
    throw new EditError(
      "E_TRIM_OUT_OF_RANGE",
      `início ${seconds(start)}s fora do permitido para "${clipId}": entre 0 e ${seconds(maxStart)}s`,
    );
  }
  const delta = start - clip.start;
  const media = clip.tag === "video" || clip.tag === "audio";
  const attributes: Record<string, string | null> = { "data-duration": seconds(clip.end - start) };
  if (clip.startExpr.kind === "reference") {
    attributes["data-start"] = `${clip.startExpr.refId}${refSuffix(clip.startExpr.offset + delta)}`;
  } else {
    attributes["data-start"] = seconds(start);
  }
  if (media) {
    const offset = clip.offset + delta * clip.playbackRate;
    if (offset < -1e-9) {
      const earliest = clip.start - clip.offset / clip.playbackRate;
      throw new EditError(
        "E_TRIM_OUT_OF_RANGE",
        `não há mídia antes do começo da fonte em "${clipId}": o início mais cedo é ${seconds(Math.max(0, earliest))}s`,
      );
    }
    attributes["data-offset"] = seconds(Math.max(0, offset));
  }
  return applyPatches(source, [{ clipId, attributes }]);
}

/** Tolerância para dizer que A termina onde B começa (segundos). */
const ADJACENT_EPS = 1e-6;
const REFERENCE_ID = /^[A-Za-z0-9_.:-]+$/;

export interface TransitionRequest {
  /** Clip B, o que entra. */
  clipId: string;
  /** Preset de transição, ou `null` para remover a transição e deixar B encostado em A. */
  preset: string | null;
  /** Sobreposição em segundos (> 0); obrigatória com preset. */
  dur?: number;
  /** Chaves do preset (`dir`, `fx`...); a validação fina é do contrato. */
  params?: Record<string, string>;
}

/** Próximo `clip-N` livre entre os ids da composição e os `data-clip-id` do arquivo. */
function freeClipId(source: string, used: string[]): string {
  const taken = new Set([...used, ...[...source.matchAll(/\bdata-clip-id\s*=\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "")]);
  let n = 1;
  for (const id of taken) {
    const match = /^clip-(\d+)$/.exec(id);
    if (match) n = Math.max(n, Number(match[1]) + 1);
  }
  while (taken.has(`clip-${n}`)) n += 1;
  return `clip-${n}`;
}

/**
 * Dá `data-clip-id` ao clip sem id explícito (id automático `tag#n` não cabe em `data-start`).
 * O elemento é achado pelo próprio contrato: o candidato certo é o que, ao ganhar o id, deixa a lista de ids
 * da composição igual à original com `partner.id` trocado por `newId`.
 */
function nameClip(source: string, partner: ResolvedClip, allIds: string[], newId: string): string {
  const expected = allIds.map((id) => (id === partner.id ? newId : id));
  for (const node of walk(parseSource(source).childNodes)) {
    if (node.nodeName !== partner.tag) continue;
    if (attr(node, "data-clip-id") !== undefined || attr(node, "data-composition-id") !== undefined) continue;
    const tag = node.sourceCodeLocation?.startTag;
    if (!tag) continue;
    // Elemento vazio `<img ... />`: o atributo entra antes da barra.
    const at = source[tag.endOffset - 2] === "/" ? tag.endOffset - 2 : tag.endOffset - 1;
    const candidate = `${source.slice(0, at)} data-clip-id="${newId}"${source.slice(at)}`;
    const ids = flatten(loadComposition(candidate).clips).map((clip) => clip.id);
    if (ids.length === expected.length && ids.every((id, index) => id === expected[index])) return candidate;
  }
  throw new EditError(
    "E_CLIP_NOT_FOUND",
    `clip "${partner.id}" não tem data-clip-id e não foi possível localizá-lo no arquivo; dê um data-clip-id a ele`,
  );
}

/**
 * Liga o clip B a quem termina onde ele começa (A) por uma transição (§7b.10): B passa a começar `dur` antes
 * do fim de A (`data-start="<A> - <dur>"`) e ganha `data-transition`. Com `preset: null` a transição sai e B
 * volta a começar no fim de A. A é o clip da raiz, anterior a B no documento, que termina no início de B, ou
 * o que B já referencia numa transição existente; nenhum → `E_TRANSITION_GAP`. Se A não tem `data-clip-id`, ele
 * é gravado no mesmo resultado. Função pura: o contrato do resultado é validado por quem chama.
 */
export function applyTransition(source: string, request: TransitionRequest): string {
  const { clipId, preset } = request;
  const params = request.params ?? {};
  const composition = loadComposition(source);
  const all = flatten(composition.clips);
  const clip = topLevelClip(composition, clipId, "E_TRANSITION_GAP", "transição só entre clips da raiz");
  const location = locateClip(source, clipId);
  if (clip.start === undefined) {
    throw new EditError("E_TRANSITION_GAP", `clip "${clipId}" não tem início resolvido; corrija o contrato antes`);
  }

  // Texto do atributo, validado antes de qualquer outra coisa para não gravar lixo.
  let value: string | undefined;
  if (preset !== null) {
    const dur = request.dur;
    if (typeof dur !== "number" || !Number.isFinite(dur) || dur <= 0) {
      throw new EditError("E_ATTRIBUTE_INVALID", '"dur" da transição precisa ser um número > 0');
    }
    if (!listPresets("transition").some((item) => item.name === preset)) {
      throw new EditError(
        "E_ATTRIBUTE_INVALID",
        `"${preset}" não é um preset de transição (${listPresets("transition").map((item) => item.name).join(", ")})`,
      );
    }
    value = [preset, ...Object.entries(params).map(([key, item]) => `${key}=${item}`)].join(" ");
    const parsed = parseMotionValue(value);
    const same =
      parsed.ok &&
      parsed.preset === preset &&
      Object.keys(parsed.params).length === Object.keys(params).length &&
      Object.entries(params).every(([key, item]) => parsed.params[key] === item);
    if (!same) throw new EditError("E_ATTRIBUTE_INVALID", `parâmetros inválidos para a transição: ${JSON.stringify(params)}`);
  }

  // Parceiro A: o referenciado com sobreposição (transição existente) ou o que termina onde B começa.
  const before = composition.clips.slice(0, composition.clips.indexOf(clip));
  const expr = clip.startExpr;
  const hasTransition = attr(location.node, "data-transition") !== undefined;
  const overlapping = expr.kind === "reference" && expr.offset < 0;
  let partner: ResolvedClip | undefined;
  if (overlapping) partner = before.find((item) => item.id === expr.refId);
  partner ??= [...before]
    .reverse()
    .find((item) => item.end !== undefined && Math.abs(item.end - clip.start!) <= ADJACENT_EPS);

  if (preset === null && !hasTransition && !overlapping) return source;
  if (partner === undefined) {
    throw new EditError("E_TRANSITION_GAP", `nenhum clip termina onde "${clipId}" começa; encoste um clip nele antes de criar a transição`);
  }

  let named = source;
  let reference = partner.id;
  if (!REFERENCE_ID.test(partner.id)) {
    reference = freeClipId(source, all.map((item) => item.id));
    named = nameClip(source, partner, all.map((item) => item.id), reference);
  }

  if (preset === null) {
    return applyPatches(named, [{ clipId, attributes: { "data-transition": null, "data-start": reference } }]);
  }
  return applyPatches(named, [
    { clipId, attributes: { "data-start": `${reference}${refSuffix(-request.dur!)}`, "data-transition": value! } },
  ]);
}
