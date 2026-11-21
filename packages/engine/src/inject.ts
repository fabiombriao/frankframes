// FrankFrames — proprietário. Ver LICENSE na raiz.
import { CLOCK_SOURCE } from "./clock.ts";
import { MEDIA_SHIM_SOURCE } from "./media-shim.ts";
import { PREVIEW_AUDIO_SOURCE } from "./preview-audio.ts";
import { PREVIEW_RELOAD_SOURCE, PREVIEW_UI_SOURCE } from "./preview-ui.ts";
import type { Fps } from "@frankframes/contract";
import { fontFaceCss } from "./fonts.ts";
import type { MediaManifest } from "./media.ts";

export interface Injection {
  manifest?: MediaManifest;
  /** Desliga a substituição de vídeo (testes do relógio isolado). */
  disableMediaShim?: boolean;
  /** Base pública das fontes embarcadas; `null` desliga a injeção. */
  fontsBase?: string | null;
  /** Preview: relógio em tempo real e recarga por SSE. */
  live?: boolean;
  /** Preview com barra de controle; `frames` alimenta o scrub. */
  preview?: { fps: Fps; frames: number; id?: string; reload?: boolean };
  /**
   * Áudio do preview: `src` é o mix do servidor; `error` mostra a falha do mix na barra;
   * `disabled` explica por que não há áudio (composição longa demais).
   */
  audio?: PreviewAudioConfig;
}

export type PreviewAudioConfig = { src: string } | { error: string } | { disabled: string };

/**
 * Monta o bloco que precisa rodar ANTES de qualquer script do autor, nesta ordem:
 * 1. relógio virtual; 2. manifesto de mídia; 3. shim de `<video>`; 4. áudio do preview
 * (precisa dos hooks do relógio e registrar-se antes da barra, que chama `startLive`).
 */
export function injectionScript(injection: Injection = {}): string {
  const parts: string[] = [];
  if (injection.fontsBase !== null) {
    parts.push(`<style>${fontFaceCss(injection.fontsBase ?? "/__ff_fonts")}</style>`);
  }
  parts.push(`<script>${CLOCK_SOURCE}</script>`);
  if (injection.manifest) {
    parts.push(`<script>window.__ffMedia=${JSON.stringify(injection.manifest)};</script>`);
    if (!injection.disableMediaShim) parts.push(`<script>${MEDIA_SHIM_SOURCE}</script>`);
  }
  if (injection.audio) {
    // `<` escapado: a mensagem de erro não pode fechar o <script>.
    const config = JSON.stringify(injection.audio).replace(/</g, "\\u003c");
    parts.push(`<script>window.__ffPreviewAudio=${config};</script>`, `<script>${PREVIEW_AUDIO_SOURCE}</script>`);
  }
  if (injection.preview) {
    parts.push(`<script>window.__ffPreviewMeta=${JSON.stringify(injection.preview)};</script>`);
    parts.push(
      `<script>document.addEventListener("DOMContentLoaded",function(){${PREVIEW_UI_SOURCE}${
        injection.preview.reload === false ? "" : PREVIEW_RELOAD_SOURCE
      }});</script>`,
    );
  } else if (injection.live) {
    parts.push(
      `<script>document.addEventListener("DOMContentLoaded",function(){var t=0;try{t=Number(sessionStorage.getItem("__ffTime")||0)}catch(e){window.__ff.liveErrors.push("sessionStorage: "+(e&&e.message?e.message:e))}window.__ff.startLive(t||0);var es=new EventSource("/__ff_reload");es.onmessage=function(){location.reload()}});</script>`,
    );
  }
  return parts.join("");
}

/** Injeta o bloco no início do `<head>` (ou do `<html>`, ou do documento). */
export function injectEngine(html: string, injection: Injection = {}): string {
  const block = injectionScript(injection);
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${block}${html.slice(at)}`;
  }
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return `${html.slice(0, at)}${block}${html.slice(at)}`;
  }
  return `${block}${html}`;
}
