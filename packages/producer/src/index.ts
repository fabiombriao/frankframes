// FrankFrames — proprietário. Ver LICENSE na raiz.
export { renderComposition, prepare, RenderError, timedClips, frameCountFor } from "./render.ts";
export { RENDER_ERROR_CODES, sanitizeMessage, toErrorPayload } from "./errors.ts";
export type { ErrorPayload, RenderCode } from "./errors.ts";
export type { PrepareOptions, PreparedComposition, RenderOptions, RenderResult, RenderStage } from "./render.ts";
export { captureFrameAt, captureGolden, engineSignature, sampleFrames } from "./goldens.ts";
export type { GoldenBlock, GoldenFrame, GoldenManifest } from "./goldens.ts";
export { resolveFfmpeg } from "./ffmpeg.ts";
export type { FfmpegPair } from "./ffmpeg.ts";
export { annotateTiming, mergeSubCompositions, compileComposition } from "./compile.ts";
export { buildCaptionComposition } from "./captions.ts";
export type { CaptionOptions, CaptionSegment } from "./captions.ts";
export { mixAudio, buildAudioGraph } from "./audio.ts";
export type { AudioClip, AudioGraph, MixOptions } from "./audio.ts";
