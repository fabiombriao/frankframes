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

export interface RawComposition {
  id: string;
  width?: number;
  height?: number;
  fps: Fps;
  /** `data-duration` da raiz. Tem precedência sobre qualquer derivação. */
  authoredDuration?: number;
  clips: RawClip[];
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
  diagnostics: Diagnostic[];
  /** `true` quando nenhum diagnóstico tem severidade `error`. */
  ok: boolean;
}
