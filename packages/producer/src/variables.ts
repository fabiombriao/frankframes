// FrankFrames — proprietário. Ver LICENSE na raiz.
import { parse } from "parse5";

/**
 * Variáveis de dados (§11 do contrato): `data-var="chave"` troca o texto do elemento e
 * `data-var-attr="atributo:chave; outro:chave2"` troca atributos. Passo de compilação do producer, antes
 * do contrato: duração e tempo alterados por variável são validados como qualquer valor autoral.
 */

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

export type VariableErrorCode = "E_VAR_MISSING" | "E_VAR_UNKNOWN" | "E_VAR_INVALID";

export class VariableError extends Error {
  readonly code: VariableErrorCode;
  readonly hint: string;

  constructor(code: VariableErrorCode, message: string, hint: string) {
    super(`${message} (${hint})`);
    this.name = "VariableError";
    this.code = code;
    this.hint = hint;
  }
}

/** Forma de uma chave de variável: letra ou `_`, depois letras, dígitos, `_` e `-`. */
export const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const ATTRIBUTE_NAME = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;
/** Conteúdo bruto (sem escape de entidade): o texto não pode ser trocado por escape. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);
/** Os próprios marcadores nunca são alvo de troca: a variável não pode reescrever a si mesma. */
const RESERVED_ATTRIBUTES = new Set(["data-var", "data-var-attr"]);

interface TextUse {
  key: string;
  node: P5Node;
}

interface AttributeUse {
  key: string;
  node: P5Node;
  name: string;
}

interface Scan {
  texts: TextUse[];
  attributes: AttributeUse[];
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

function describe(node: P5Node): string {
  const id = attr(node, "data-clip-id") ?? attr(node, "id");
  return id === undefined ? `<${node.nodeName}>` : `<${node.nodeName}> "${id}"`;
}

function invalid(message: string, hint: string): VariableError {
  return new VariableError("E_VAR_INVALID", message, hint);
}

/** Lê todos os `data-var` e `data-var-attr` do documento, validando a forma de cada um. */
function scan(document: P5Node): Scan {
  const texts: TextUse[] = [];
  const attributes: AttributeUse[] = [];
  for (const node of walk(document.childNodes)) {
    if (node.nodeName.startsWith("#")) continue;
    const textKey = attr(node, "data-var");
    if (textKey !== undefined) {
      if (!VARIABLE_KEY.test(textKey)) {
        throw invalid(`data-var="${textKey}" em ${describe(node)} não é um nome de variável`, "use letras, dígitos, _ e -, começando por letra ou _");
      }
      texts.push({ key: textKey, node });
    }
    const spec = attr(node, "data-var-attr");
    if (spec !== undefined) {
      const seen = new Set<string>();
      for (const part of spec.split(";")) {
        const item = part.trim();
        if (item === "") continue;
        const colon = item.lastIndexOf(":");
        const name = colon < 0 ? "" : item.slice(0, colon).trim().toLowerCase();
        const key = colon < 0 ? "" : item.slice(colon + 1).trim();
        if (!ATTRIBUTE_NAME.test(name) || !VARIABLE_KEY.test(key)) {
          throw invalid(
            `data-var-attr="${spec}" em ${describe(node)}: "${item}" não tem a forma atributo:variável`,
            'escreva data-var-attr="src:foto; data-duration:tempo"',
          );
        }
        if (RESERVED_ATTRIBUTES.has(name)) {
          throw invalid(`data-var-attr em ${describe(node)} não pode trocar "${name}"`, "troque o atributo de dados, não o marcador de variável");
        }
        if (seen.has(name)) {
          throw invalid(`data-var-attr em ${describe(node)} troca "${name}" duas vezes`, "use uma variável por atributo");
        }
        seen.add(name);
        attributes.push({ key, node, name });
      }
    }
  }
  return { texts, attributes };
}

function parseDocument(html: string): P5Node {
  return parse(html, { sourceCodeLocationInfo: true }) as unknown as P5Node;
}

/** Chaves usadas no HTML, sem repetição e em ordem alfabética. */
export function collectVariables(html: string): string[] {
  const { texts, attributes } = scan(parseDocument(html));
  return [...new Set([...texts.map((use) => use.key), ...attributes.map((use) => use.key)])].sort();
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Aplica `vars` ao HTML. O que não é variável fica byte a byte como estava: a troca usa a posição do
 * parse5, sem re-serializar o documento. Falta de valor, valor sem uso e forma inválida são erros, nunca
 * valor autoral usado em silêncio (um erro de digitação no lote não pode passar).
 */
export function applyVariables(html: string, vars: Record<string, string>): { html: string; used: string[] } {
  for (const [key, value] of Object.entries(vars)) {
    if (!VARIABLE_KEY.test(key)) {
      throw invalid(`a variável "${key}" não é um nome válido`, "use letras, dígitos, _ e -, começando por letra ou _");
    }
    if (typeof value !== "string") {
      throw invalid(`o valor de "${key}" precisa ser texto`, "converta o número ou o booleano para texto no lote");
    }
  }

  const { texts, attributes } = scan(parseDocument(html));
  const used = [...new Set([...texts.map((use) => use.key), ...attributes.map((use) => use.key)])].sort();

  const missing = used.filter((key) => !Object.hasOwn(vars, key));
  if (missing.length > 0) {
    throw new VariableError(
      "E_VAR_MISSING",
      `variável usada no HTML e sem valor: ${missing.join(", ")}`,
      `passe ${missing.map((key) => `"${key}"`).join(", ")} em vars`,
    );
  }
  const unknown = Object.keys(vars).filter((key) => !used.includes(key));
  if (unknown.length > 0) {
    throw new VariableError(
      "E_VAR_UNKNOWN",
      `variável sem uso no HTML: ${unknown.join(", ")}`,
      "confira a grafia da chave ou adicione data-var / data-var-attr ao elemento",
    );
  }

  const replacements: Replacement[] = [];
  for (const { key, node } of texts) {
    const location = node.sourceCodeLocation;
    if (RAW_TEXT_ELEMENTS.has(node.nodeName)) {
      throw invalid(`data-var="${key}" em ${describe(node)}: ${node.nodeName} guarda código, não texto`, "use data-var num elemento de texto");
    }
    if (!location?.startTag || !location.endTag) {
      throw invalid(`data-var="${key}" em ${describe(node)}: o elemento precisa ter tag de fechamento`, "elementos vazios (como <img>) usam data-var-attr");
    }
    if ((node.childNodes ?? []).some((child) => child.nodeName !== "#text")) {
      throw invalid(`data-var="${key}" em ${describe(node)} tem marcação interna`, "o elemento com data-var só pode conter texto");
    }
    replacements.push({ start: location.startTag.endOffset, end: location.endTag.startOffset, text: escapeText(vars[key]!) });
  }

  // Atributos novos entram juntos, num único ponto do elemento: a ordem fica estável.
  const inserted = new Map<P5Node, { at: number; text: string }>();
  for (const { key, node, name } of attributes) {
    const location = node.sourceCodeLocation;
    if (!location?.startTag) throw invalid(`data-var-attr em ${describe(node)} sem localização no arquivo`, "salve o arquivo em HTML válido");
    const text = `${name}="${escapeAttribute(vars[key]!)}"`;
    const range = location.attrs?.[name];
    if (range) {
      replacements.push({ start: range.startOffset, end: range.endOffset, text });
      continue;
    }
    const current = inserted.get(node);
    if (current) {
      current.text += ` ${text}`;
      continue;
    }
    // Elemento vazio `<img ... />`: o atributo entra antes do espaço e da barra.
    let at = location.startTag.endOffset - 1;
    if (html[at - 1] === "/") at = html[at - 2] === " " ? at - 2 : at - 1;
    inserted.set(node, { at, text: ` ${text}` });
  }
  for (const { at, text } of inserted.values()) replacements.push({ start: at, end: at, text });

  // De trás para a frente, para não deslocar as posições seguintes.
  let result = html;
  for (const item of replacements.sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = result.slice(0, item.start) + item.text + result.slice(item.end);
  }
  return { html: result, used };
}
