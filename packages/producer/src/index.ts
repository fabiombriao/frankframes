// FrankFrames — proprietário. Ver LICENSE na raiz.
export { renderComposition, prepare, RenderError, timedClips, frameCountFor } from "./render.ts";
export type { PrepareOptions, PreparedComposition, RenderOptions, RenderResult, RenderStage } from "./render.ts";
export { captureGolden, engineSignature, sampleFrames } from "./goldens.ts";
export type { GoldenBlock, GoldenFrame, GoldenManifest } from "./goldens.ts";
export { resolveFfmpeg } from "./ffmpeg.ts";
export type { FfmpegPair } from "./ffmpeg.ts";
export { annotateTiming, mergeSubCompositions, compileComposition } from "./compile.ts";
export { mixAudio, buildAudioGraph } from "./audio.ts";
export type { AudioClip, AudioGraph, MixOptions } from "./audio.ts";
