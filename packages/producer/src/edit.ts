// FrankFrames — proprietário. Ver LICENSE na raiz.
import { parse } from "parse5";
import { loadComposition } from "@frankframes/contract";
import type { ResolvedClip } from "@frankframes/contract";

interface P5Location {
  startOffset: number;
  endOffset: number;
  startTag?: { startOffset: number; endOffset: number };
  endTag?: { startOffset: number; endOffset: number };
  attrs?: Record<string, { startOffset: number; endOffset: number }>;
}

interface P5Node {
  nodeName: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: P5Node[];
  content?: { childNodes: P5Node[] };
  sourceCodeLocation?: P5Location | null;
}

export interface ClipPatch {
  clipId: string;
  /** `null` remove o atributo. */
  attributes?: Record<string, string | null>;
  /** Substitui o texto do elemento — só quando ele tem um único nó de texto. */
  text?: string;
}

export class EditError extends Error {
  readonly code:
    | "E_CLIP_NOT_FOUND"
    | "E_AMBIGUOUS_CLIP"
    | "E_TEXT_NOT_EDITABLE"
    | "E_ATTRIBUTE_INVALID"
    | "E_SPLIT_UNSUPPORTED"
    | "E_SPLIT_OUT_OF_RANGE";

  constructor(code: EditError["code"], message: string) {
    super(message);
    this.name = "EditError";
    this.code = code;
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

/**
 * Edita atributos e texto mantendo o arquivo original intacto fora dos trechos
 * alterados — usa a localização do parse5 em vez de re-serializar o documento.
 */
export function applyPatches(source: string, patches: ClipPatch[]): string {
  const document = parse(source, { sourceCodeLocationInfo: true }) as unknown as P5Node;
  const replacements: Replacement[] = [];

  for (const patch of patches) {
    const matches = findClips(document, patch.clipId);
    if (matches.length === 0) throw new EditError("E_CLIP_NOT_FOUND", `clip "${patch.clipId}" não existe`);
    if (matches.length > 1) throw new EditError("E_AMBIGUOUS_CLIP", `clip "${patch.clipId}" aparece ${matches.length} vezes`);
    const node = matches[0]!;
    const location = node.sourceCodeLocation;
    if (!location?.startTag) throw new EditError("E_CLIP_NOT_FOUND", `clip "${patch.clipId}" sem localização no arquivo`);

    for (const [name, value] of Object.entries(patch.attributes ?? {})) {
      if (!ATTRIBUTE_NAME.test(name)) throw new EditError("E_ATTRIBUTE_INVALID", `atributo inválido: ${name}`);
      const range = location.attrs?.[name];
      if (value === null) {
        if (!range) continue;
        // Remove o espaço anterior junto com "nome=valor".
        const start = source[range.startOffset - 1] === " " ? range.startOffset - 1 : range.startOffset;
        replacements.push({ start, end: range.endOffset, text: "" });
      } else if (range) {
        replacements.push({ start: range.startOffset, end: range.endOffset, text: `${name}="${escapeAttribute(value)}"` });
      } else {
        const at = location.startTag.endOffset - 1;
        replacements.push({ start: at, end: at, text: ` ${name}="${escapeAttribute(value)}"` });
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
        text: patch.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
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
  const clip = all.find((item) => item.id === clipId);
  if (clip === undefined) throw new EditError("E_CLIP_NOT_FOUND", `clip "${clipId}" não existe`);
  if (!composition.clips.includes(clip)) {
    throw new EditError("E_SPLIT_UNSUPPORTED", `clip "${clipId}" está dentro de uma sub-composição; divida no arquivo dela`);
  }
  if (clip.isSubComposition || clip.children.length > 0) {
    throw new EditError("E_SPLIT_UNSUPPORTED", `clip "${clipId}" contém outros clips; dividir copiaria a sub-timeline inteira`);
  }
  if (clip.keyframes !== undefined) {
    throw new EditError("E_SPLIT_UNSUPPORTED", `clip "${clipId}" tem data-keyframes; remova a automação antes de dividir`);
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

  const document = parse(source, { sourceCodeLocationInfo: true }) as unknown as P5Node;
  const nodes = [...walk(document.childNodes)].filter((node) => node.nodeName !== "#text" && attr(node, "data-clip-id") === clipId);
  if (nodes.length !== 1) {
    throw new EditError("E_CLIP_NOT_FOUND", `clip "${clipId}" precisa de data-clip-id explícito no arquivo para ser dividido`);
  }
  const location = nodes[0]!.sourceCodeLocation;
  if (!location) throw new EditError("E_CLIP_NOT_FOUND", `clip "${clipId}" sem localização no arquivo`);

  // Quem referencia o clip precisa ter id no arquivo para ser reescrito.
  const referrers = all.filter((item) => item.id !== clipId && item.startExpr.kind === "reference" && item.startExpr.refId === clipId);
  const referrerIds = new Set(
    [...walk(document.childNodes)].map((node) => attr(node, "data-clip-id")).filter((id): id is string => id !== undefined),
  );
  for (const referrer of referrers) {
    if (!referrerIds.has(referrer.id)) {
      throw new EditError("E_SPLIT_UNSUPPORTED", `clip "${referrer.id}" referencia "${clipId}" mas não tem data-clip-id no arquivo`);
    }
  }

  const first = at - clip.start;
  const copyAttributes: Record<string, string | null> = {
    "data-clip-id": newId,
    "data-start": clipId,
    "data-duration": seconds(clip.end - at),
    "data-fade-in": null,
  };
  if (clip.tag === "video" || clip.tag === "audio") copyAttributes["data-offset"] = seconds(clip.offset + first * clip.playbackRate);
  const copy = applyPatches(source.slice(location.startOffset, location.endOffset), [{ clipId, attributes: copyAttributes }]);

  const lineStart = source.lastIndexOf("\n", location.startOffset - 1) + 1;
  const lead = source.slice(lineStart, location.startOffset);
  const separator = /^[ \t]*$/.test(lead) ? `\n${lead}` : "";
  const inserted = source.slice(0, location.endOffset) + separator + copy + source.slice(location.endOffset);

  const patches: ClipPatch[] = [{ clipId, attributes: { "data-duration": seconds(first), "data-fade-out": null } }];
  for (const referrer of referrers) {
    const offset = referrer.startExpr.kind === "reference" ? referrer.startExpr.offset : 0;
    const suffix = offset > 0 ? ` + ${seconds(offset)}` : offset < 0 ? ` - ${seconds(-offset)}` : "";
    patches.push({ clipId: referrer.id, attributes: { "data-start": `${newId}${suffix}` } });
  }
  return applyPatches(inserted, patches);
}
