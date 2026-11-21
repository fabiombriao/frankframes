// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Escreve `data-ff-motion` nos alvos (docs/contract.md §7b.12). O contrato já resolveu
 * as trilhas em segundos locais ao clip dono; aqui elas viram milissegundos relativos ao
 * escopo que o relógio usa (`data-ff-comp-start` mais próximo). Sem I/O.
 */
import { bindingsFor, motionElements } from "@frankframes/contract";
import type { Composition, DomNode, MotionTarget } from "@frankframes/contract";

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
export function toRuntimeSpec(target: MotionTarget, clipStart: number, scopeMs: number): MotionRuntimeSpec {
  return {
    v: 1,
    a: target.tracks.map((track) => ({
      p: track.prop,
      d: round3((clipStart + track.start) * 1000 - scopeMs),
      n: Math.max(1, round3(track.duration * 1000)),
      k: track.keys.map((key): [number, number | string, string | null] => [key.offset, key.value, key.easing]),
    })),
    s: bindingsFor(target.tracks.map((track) => track.prop)),
  };
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
      const element = elements[target.ordinal];
      if (element === undefined || element.nodeName !== target.tag) {
        throw new Error(`motion: alvo ${target.ordinal} de "${owner}" não bate com o documento (esperado <${target.tag}>)`);
      }
      const spec = toRuntimeSpec(target, clipStart, scopes.get(element) ?? 0);
      setAttr(element, "data-ff-motion", JSON.stringify(spec));
      annotated++;
    }
  }
  return annotated;
}
