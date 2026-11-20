// FrankFrames — proprietário. Ver LICENSE na raiz.
export { renderComposition, RenderError } from "./render.ts";
export type { RenderOptions, RenderResult, RenderStage } from "./render.ts";
export { resolveFfmpeg } from "./ffmpeg.ts";
export type { FfmpegPair } from "./ffmpeg.ts";
export { annotateTiming, mergeSubCompositions, compileComposition } from "./compile.ts";
export { mixAudio, buildAudioGraph } from "./audio.ts";
export type { AudioClip, AudioGraph, MixOptions } from "./audio.ts";
