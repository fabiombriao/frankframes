// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Tipos do contrato FrankFrames. Nada aqui depende de DOM ou I/O. */

export type Severity = "error" | "warning";

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  /** Ação concreta para corrigir. Todo erro do contrato carrega um. */
  hint?: string;
  clipId?: string;
}

export type TimeExpr =
  | { kind: "absolute"; value: number }
  | { kind: "reference"; refId: string; offset: number };

export interface Fps {
  num: number;
  den: number;
}

export interface RawClip {
  /** Identidade estável usada por `data-start` de outros clips. */
  id: string;
  tag: string;
  startExpr: TimeExpr;
  /** `data-duration`; ausente = desconhecida (nunca estimada). */
  authoredDuration?: number;
  /** `data-offset`: onde a mídia começa dentro da fonte. */
  offset: number;
  playbackRate: number;
  volume?: number;
  /** Automação de volume: pontos em segundos e ganho linear. `data-keyframes`. */
  keyframes?: Array<{ time: number; volume: number }>;
  /** Papel no mix: voz, música ou efeito. `data-audio-role`. */
  audioRole?: "voice" | "music" | "sfx";
  /** Fade de entrada, em segundos. */
  fadeIn?: number;
  /** Fade de saída, em segundos. */
  fadeOut?: number;
  /** Só UI. O render ignora. */
  track: number;
  isMedia: boolean;
  isSubComposition: boolean;
  /** `data-composition-src`, quando a sub-composição vem de outro arquivo. */
  src?: string;
  /** Atributo HTML `src` de `<video>`/`<audio>`/`<img>`. */
  mediaSrc?: string;
  /** `<audio>`, ou `<video>` sem `data-has-audio="false"`. */
  hasAudio?: boolean;
  depth: number;
  /** Clips da sub-composição inline (`<template>`), resolvidos no mesmo escopo. */
  children: RawClip[];
}

/** Atributos de movimento (docs/contract.md §7b). */
export type MotionKind = "enter" | "exit" | "emphasis" | "camera" | "transition";

/** Propriedades animáveis por `data-keyframes` (§7b.6, §7b.7). */
export type MotionProp = "opacity" | "x" | "y" | "scaleX" | "scaleY" | "rotate" | "blur" | "clip" | "zoom" | "focusX" | "focusY";

/**
 * Valor normalizado de um ponto: número (px, graus, fator) ou texto (`"10%"` em x/y;
 * `inset(...)`/`circle(...)` em clip, sempre em %).
 */
export type MotionValue = number | string;

/** Um ponto de `data-keyframes` com propriedades visuais, já validado (docs/contract.md §7b.7). */
export interface VisualKeyframe {
  /** Segundos desde o início do clip dono. */
  time: number;
  values: Partial<Record<MotionProp, MotionValue>>;
  /** Curva dos trechos que começam neste ponto (nome, `cubic-bezier(...)` ou `spring(...)`); padrão `linear`. */
  curve: string;
}

/** `data-split` já validado (§7b.8): como o texto vira unidades e o tempo entre elas. */
export interface MotionSplit {
  mode: "word" | "letter";
  /** Segundos entre unidades consecutivas (de posto em posto). */
  stagger: number;
  order: "forward" | "reverse" | "center";
  /** `true` quando o autor marcou as unidades com `data-unit` (não há segmentação). */
  explicit: boolean;
  /** Uma entrada por unidade, na ordem do documento. */
  units: Array<{
    /** `data-unit="<s>"`: início fixo da entrada, em segundos locais ao clip. */
    anchor?: number;
    /** `style` inline da unidade explícita, para detectar conflito de posse. */
    style?: string;
  }>;
}

/** Um elemento com atributos de motion, como o autor escreveu (ainda sem validar). */
export interface MotionSource {
  /** Clip dono: o próprio elemento ou o clip temporizado mais próximo acima dele. */
  clipId: string;
  /** Posição entre os elementos com motion do clip, na ordem canônica do documento. */
  ordinal: number;
  tag: string;
  /** `true` quando o elemento é o próprio clip. */
  own: boolean;
  /** Valor bruto de cada atributo presente ("" conta como presente). */
  attrs: Partial<Record<MotionKind, string>>;
  /** Atributo `style` inline, para detectar conflito de posse. */
  style?: string;
  /** Pontos visuais de `data-keyframes` (§7b.7), por ordem de `time`. Ausente quando não há. */
  keyframes?: VisualKeyframe[];
  /** `data-split` (§7b.8): enter/exit/emphasis passam a valer por unidade. Ausente quando não há. */
  split?: MotionSplit;
}

export interface MotionKey {
  /** 0..1 dentro da trilha. */
  offset: number;
  value: number | string;
  /** Easing do trecho que COMEÇA nesta chave; `null` = linear. */
  easing: string | null;
}

/** Uma animação de uma propriedade CSS, com tempo local ao clip dono. */
export interface MotionTrack {
  /** Propriedade CSS animada (`opacity`, `--ff-sx`, `clip-path`...). */
  prop: string;
  /** Segundos desde o início do clip dono; pode ser negativo (entrada antes de 0). */
  start: number;
  duration: number;
  keys: MotionKey[];
}

export interface MotionTarget {
  ordinal: number;
  tag: string;
  /**
   * `true` no alvo sintético do clip A de uma transição (§7b.10): o elemento é o próprio clip,
   * mesmo sem atributo de motion, então `ordinal` não o localiza em `motionElements`.
   */
  own?: true;
  /**
   * `true` nos alvos de uma transição (A e B, §7b.10): o producer fixa `will-change` neles para o elemento
   * ficar numa camada própria desde o primeiro frame. Sem isso o raster da emenda entre os dois clips
   * (bordas fracionárias) depende do frame visto antes, e o seek deixa de ser independente de ordem.
   */
  layer?: true;
  /** Trilhas do próprio elemento. Com `data-split`, só o que não é por unidade (`data-keyframes`). */
  tracks: MotionTrack[];
  /** Com `data-split`: as trilhas de cada unidade, na ordem do documento (§7b.8). */
  units?: MotionTrack[][];
  /** Com `data-split`: como o producer reescreve o texto. */
  split?: { mode: "word" | "letter"; explicit: boolean };
}

export interface RawComposition {
  id: string;
  width?: number;
  height?: number;
  fps: Fps;
  /** `data-duration` da raiz. Tem precedência sobre qualquer derivação. */
  authoredDuration?: number;
  clips: RawClip[];
  /** Elementos com motion, em ordem de documento. */
  motion: MotionSource[];
  diagnostics: Diagnostic[];
}

export interface ResolvedClip extends RawClip {
  /** Segundos desde o início da composição. `undefined` se não resolvível. */
  start?: number;
  end?: number;
  children: ResolvedClip[];
}

export type DurationResolution =
  | { kind: "authored"; seconds: number }
  | { kind: "derived"; seconds: number }
  | {
      kind: "unresolved";
      reason: "empty" | "invalid-start" | "pending-clips";
      /** Clips que impedem a derivação. Vazio em `empty`/`invalid-start`. */
      pending: string[];
    };

export interface Composition {
  id: string;
  width?: number;
  height?: number;
  fps: Fps;
  clips: ResolvedClip[];
  duration: DurationResolution;
  /** Motion resolvido por id de clip dono. Vazio quando a composição não usa motion. */
  motion: Record<string, MotionTarget[]>;
  diagnostics: Diagnostic[];
  /** `true` quando nenhum diagnóstico tem severidade `error`. */
  ok: boolean;
}
