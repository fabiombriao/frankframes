// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Escreve `data-ff-motion` nos alvos (docs/contract.md §7b.12). O contrato já resolveu
 * as trilhas em segundos locais ao clip dono; aqui elas viram milissegundos relativos ao
 * escopo que o relógio usa (`data-ff-comp-start` mais próximo). Sem I/O.
 */
import { defaultTreeAdapter, html } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { bindingsFor, motionElements, scanSplit, splitText } from "@frankframes/contract";
import type { Composition, DomNode, MotionTarget, MotionTrack } from "@frankframes/contract";

/** Formato de `data-ff-motion`, versão 1. */
export interface MotionRuntimeSpec {
  v: 1;
  a: Array<{ p: string; d: number; n: number; k: Array<[number, number | string, string | null]> }>;
  s: Array<[string, string]>;
}

const round3 = (value: number): number => Number(value.toFixed(3));

function attrOf(node: DomNode, name: string): string | undefined {
  return (node.attrs ?? []).find((a) => a.name === name)?.value;
}

function setAttr(node: DomNode, name: string, value: string): void {
  node.attrs ??= [];
  const existing = node.attrs.find((a) => a.name === name);
  if (existing) existing.value = value;
  else node.attrs.push({ name, value });
}

/**
 * Converte um alvo para o formato do runtime.
 * @param clipStart início absoluto do clip dono, em segundos
 * @param scopeMs `data-ff-comp-start` do escopo do alvo, em ms (o que o relógio subtrai)
 */
export function toRuntimeSpec(target: MotionTarget | { tracks: MotionTrack[] }, clipStart: number, scopeMs: number): MotionRuntimeSpec {
  const bindings = bindingsFor(target.tracks.map((track) => track.prop));
  // Transição (§7b.10): camada própria desde o primeiro frame, senão a emenda entre A e B varia com a ordem do seek.
  if ("layer" in target && target.layer === true) bindings.push(["will-change", "transform, opacity"]);
  return {
    v: 1,
    a: target.tracks.map((track) => {
      const keys = track.keys.map((key): [number, number | string, string | null] => [key.offset, cssValue(track.prop, key.value), key.easing]);
      // Trilha constante (um ponto de keyframe): o WAAPI precisa de dois quadros, os dois iguais.
      if (keys.length === 1) keys.push([1, keys[0]![1], null]);
      return {
        p: track.prop,
        d: round3((clipStart + track.start) * 1000 - scopeMs),
        n: Math.max(1, round3(track.duration * 1000)),
        k: keys,
      };
    }),
    s: bindings,
  };
}

/**
 * Valor CSS do quadro. As propriedades registradas (`@property`) exigem unidade:
 * número solto só vale em opacity e escalas; texto (`%`, `inset(...)`) já vem formatado.
 */
function cssValue(prop: string, value: number | string): number | string {
  if (typeof value === "string") return value;
  switch (prop) {
    case "--ff-x":
    case "--ff-y":
    case "--ff-blur":
      return `${value}px`;
    case "--ff-rot":
      return `${value}deg`;
    default:
      return value;
  }
}

const INLINE_BLOCK = "display:inline-block";
const NOWRAP = "white-space:nowrap";

/** `display:inline-block` no fim do `style`, a não ser que o autor já tenha declarado `display`. */
function withInlineBlock(style: string | undefined): string {
  const current = (style ?? "").trim();
  if (/(^|;)\s*display\s*:/i.test(current)) return current;
  if (current === "") return INLINE_BLOCK;
  return `${current.endsWith(";") ? current : `${current};`}${INLINE_BLOCK}`;
}

type P5Element = DefaultTreeAdapterTypes.Element;
type P5Parent = DefaultTreeAdapterTypes.ParentNode;
type P5Child = DefaultTreeAdapterTypes.ChildNode;

function span(attrs: Array<{ name: string; value: string }>): P5Element {
  return defaultTreeAdapter.createElement("span", html.NS.HTML, attrs);
}

/**
 * Reescreve o texto de um alvo com `data-split` (§7b.8) e devolve as unidades, na ordem do documento.
 * Modo automático: cada nó de texto vira unidades `<span data-ff-unit>` com `display:inline-block`
 * (o transform não vale em inline) e texto solto entre elas; no modo letter, cada palavra vai num
 * `<span>` com `white-space:nowrap` para a linha não quebrar no meio. Modo explícito: os elementos
 * `data-unit` do autor só ganham `data-ff-unit` e `display:inline-block`. O texto passa pelo
 * serializer do parse5, que escapa; nada de HTML concatenado.
 */
function rewriteSplit(owner: string, element: DomNode, target: MotionTarget): DomNode[] {
  const split = target.split!;
  const scan = scanSplit(element);
  const units: DomNode[] = [];

  if (split.explicit) {
    for (const node of scan.explicit) {
      setAttr(node, "data-ff-unit", String(units.length));
      setAttr(node, "style", withInlineBlock(attrOf(node, "style")));
      units.push(node);
    }
  } else {
    for (const text of scan.texts) {
      const pieces = splitText(text.value ?? "", split.mode);
      if (!pieces.some((piece) => piece.unit)) continue;
      const node = text as unknown as P5Child;
      const parent = node.parentNode as P5Parent | null;
      if (parent === null) throw new Error(`motion: texto de "${owner}" sem pai no documento compilado`);
      let wrapper: P5Element | undefined;
      let wrapperWord: number | undefined;
      for (const piece of pieces) {
        if (!piece.unit) {
          wrapper = undefined;
          defaultTreeAdapter.insertTextBefore(parent, piece.text, node);
          continue;
        }
        const unit = span([
          { name: "data-ff-unit", value: String(units.length) },
          { name: "style", value: INLINE_BLOCK },
        ]);
        defaultTreeAdapter.insertText(unit, piece.text);
        if (split.mode === "letter") {
          if (wrapper === undefined || wrapperWord !== piece.word) {
            wrapper = span([{ name: "style", value: NOWRAP }]);
            wrapperWord = piece.word;
            defaultTreeAdapter.insertBefore(parent, wrapper, node);
          }
          defaultTreeAdapter.appendChild(wrapper, unit);
        } else {
          defaultTreeAdapter.insertBefore(parent, unit, node);
        }
        units.push(unit as unknown as DomNode);
      }
      defaultTreeAdapter.detachNode(node);
    }
  }
  if (units.length !== (target.units?.length ?? 0)) {
    throw new Error(`motion: "${owner}" tem ${units.length} unidades no documento e ${target.units?.length ?? 0} no contrato (alvo ${target.ordinal})`);
  }
  return units;
}

/** Início absoluto de cada clip, em segundos (mesma conta do tempo anotado). */
function absoluteStarts(clips: Composition["clips"], base: number, into: Map<string, number>): void {
  for (const clip of clips) {
    const start = base + (clip.start ?? 0);
    into.set(clip.id, start);
    absoluteStarts(clip.children, start, into);
  }
}

/**
 * Anota o documento (já com `data-ff-comp-start`, ver `annotateTiming`). Devolve quantos
 * alvos receberam `data-ff-motion`. Depende de o documento ser o mesmo que o contrato leu:
 * o ordinal de cada alvo é a posição em `motionElements`.
 */
export function annotateMotion(document: { childNodes?: DomNode[] }, composition: Composition): number {
  const owners = Object.keys(composition.motion);
  if (owners.length === 0) return 0;

  const starts = new Map<string, number>();
  absoluteStarts(composition.clips, 0, starts);

  const nodes = new Map<string, DomNode>();
  const index = (list: DomNode[] | undefined): void => {
    for (const node of list ?? []) {
      if (node.nodeName === "#text") continue;
      const id = attrOf(node, "data-clip-id") ?? attrOf(node, "data-composition-id");
      if (id !== undefined && composition.motion[id] !== undefined) nodes.set(id, node);
      index(node.content?.childNodes);
      index(node.childNodes);
    }
  };
  index(document.childNodes);

  // Escopo de cada elemento: `data-ff-comp-start` mais próximo, ele mesmo ou um ancestral.
  const scopes = new Map<DomNode, number>();
  const mark = (list: DomNode[] | undefined, scope: number): void => {
    for (const node of list ?? []) {
      if (node.nodeName === "#text") continue;
      const own = attrOf(node, "data-ff-comp-start");
      const here = own === undefined ? scope : Number(own);
      scopes.set(node, here);
      mark(node.content?.childNodes, here);
      mark(node.childNodes, here);
    }
  };
  mark(document.childNodes, 0);

  let annotated = 0;
  for (const owner of owners) {
    const node = nodes.get(owner);
    const clipStart = starts.get(owner);
    if (node === undefined || clipStart === undefined) {
      throw new Error(`motion: clip "${owner}" não está no documento compilado`);
    }
    const elements = motionElements(node);
    for (const target of composition.motion[owner]!) {
      // Alvo sintético (A de uma transição, §7b.10): é o próprio clip, mesmo sem atributo de motion.
      const element = target.own === true ? node : elements[target.ordinal];
      if (element === undefined || element.nodeName !== target.tag) {
        throw new Error(`motion: alvo ${target.ordinal} de "${owner}" não bate com o documento (esperado <${target.tag}>)`);
      }
      const scope = scopes.get(element) ?? 0;
      // Com split, `tracks` é só o que vale pro elemento inteiro (data-keyframes); o resto vai por unidade.
      if (target.tracks.length > 0) setAttr(element, "data-ff-motion", JSON.stringify(toRuntimeSpec(target, clipStart, scope)));
      if (target.split !== undefined && target.units !== undefined) {
        const unitNodes = rewriteSplit(owner, element, target);
        for (const [i, unit] of unitNodes.entries()) {
          const tracks = target.units[i]!;
          if (tracks.length > 0) setAttr(unit, "data-ff-motion", JSON.stringify(toRuntimeSpec({ tracks }, clipStart, scopes.get(unit) ?? scope)));
        }
      }
      annotated++;
    }
  }
  return annotated;
}
