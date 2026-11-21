// FrankFrames — proprietário. Ver LICENSE na raiz.
export { renderComposition, prepare, RenderError, timedClips, frameCountFor } from "./render.ts";
export { RENDER_ERROR_CODES, sanitizeMessage, toErrorPayload } from "./errors.ts";
export type { ErrorPayload, RenderCode } from "./errors.ts";
export type { PrepareOptions, PreparedComposition, RenderOptions, RenderResult, RenderStage } from "./render.ts";
export { captureFrameAt, captureGolden, engineSignature, psnr, sampleFrames } from "./goldens.ts";
export type { GoldenBlock, GoldenFrame, GoldenManifest } from "./goldens.ts";
export { resolveFfmpeg } from "./ffmpeg.ts";
export type { FfmpegPair } from "./ffmpeg.ts";
export { annotateCompiled, annotateTiming, mergeSubCompositions, compileComposition } from "./compile.ts";
export { annotateMotion, toRuntimeSpec } from "./motion.ts";
export type { MotionRuntimeSpec } from "./motion.ts";
export { applyPatches, applyTransition, deleteClip, EditError, splitClip, trimClipStart, explicitClipIds, locateClip, topLevelClip, referrersOf, removeRange, refSuffix } from "./edit.ts";
export { editKeyframes, mergeKeyframePoints } from "./keyframes-edit.ts";
export type { KeyframePoint, KeyframeProp, KeyframeRequest } from "./keyframes-edit.ts";
export type { ClipLocation, ClipPatch, DeleteRequest, SplitRequest, TrimStartRequest, TransitionRequest } from "./edit.ts";
export { buildCaptionComposition } from "./captions.ts";
export type { CaptionOptions, CaptionSegment } from "./captions.ts";
export { mixAudio, buildAudioGraph, codecArgs } from "./audio.ts";
export type { AudioClip, AudioFormat, AudioGraph, MixOptions } from "./audio.ts";
export {
  PREVIEW_AUDIO_MAX_SECONDS,
  PreviewAudioError,
  audioClipsFor,
  previewAudioKey,
  renderPreviewAudio,
} from "./preview-audio.ts";
export type { PreviewAudioDisabled, PreviewAudioMix, PreviewAudioOptions } from "./preview-audio.ts";
