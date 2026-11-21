// FrankFrames — proprietário. Ver LICENSE na raiz.
import { parse } from "parse5";

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
  readonly code: "E_CLIP_NOT_FOUND" | "E_AMBIGUOUS_CLIP" | "E_TEXT_NOT_EDITABLE" | "E_ATTRIBUTE_INVALID";

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
