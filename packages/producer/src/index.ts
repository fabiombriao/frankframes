// FrankFrames — proprietário. Ver LICENSE na raiz.
export { renderComposition, prepare, RenderError, timedClips, frameCountFor } from "./render.ts";
export { RENDER_ERROR_CODES, sanitizeMessage, toErrorPayload } from "./errors.ts";
export type { ErrorPayload, RenderCode } from "./errors.ts";
export type { PrepareOptions, PreparedComposition, RenderOptions, RenderResult, RenderStage } from "./render.ts";
export { GOLDEN_ERROR_CODES, GoldenSetMissingError, captureFrameAt, captureGolden, engineSignature, goldenDir, loadGoldenSet, psnr, sampleFrames } from "./goldens.ts";
export type { GoldenBlock, GoldenFrame, GoldenManifest, GoldenSet } from "./goldens.ts";
export { resolveFfmpeg } from "./ffmpeg.ts";
export type { FfmpegPair } from "./ffmpeg.ts";
export { annotateCompiled, annotateTiming, mergeSubCompositions, compileComposition } from "./compile.ts";
export { annotateMotion, toRuntimeSpec } from "./motion.ts";
export type { MotionRuntimeSpec } from "./motion.ts";
export { applyPatches, applyTransition, authoredClipText, deleteClip, duplicateClip, editComposition, EDIT_ERROR_CODES, EditError, splitClip, trimClipStart, explicitClipIds, locateClip, topLevelClip, referrersOf, removeRange, refSuffix } from "./edit.ts";
export { editKeyframes, mergeKeyframePoints } from "./keyframes-edit.ts";
export type { KeyframePoint, KeyframeProp, KeyframeRequest } from "./keyframes-edit.ts";
export type { ClipLocation, ClipPatch, CompositionPatch, DeleteRequest, DuplicateRequest, DuplicateResult, SplitRequest, TrimStartRequest, TransitionRequest } from "./edit.ts";
export { buildCaptionComposition, countKaraokeWords, editCaptionText, hasCaptionMeta, readCaptionFile, renderCue } from "./captions.ts";
export type { CaptionCue, CaptionLayout } from "./captions.ts";
export type { CaptionOptions, CaptionSegment } from "./captions.ts";
export { mixAudio, buildAudioGraph, codecArgs, enforceTruePeak, truePeakCorrectionDb, AudioTruePeakError, AUDIO_ERROR_CODES, TRUE_PEAK_MARGIN_DB } from "./audio.ts";
export type { AudioClip, AudioFormat, AudioGraph, MixOptions } from "./audio.ts";
export {
  PREVIEW_AUDIO_ERROR_CODES,
  PREVIEW_AUDIO_MAX_SECONDS,
  PreviewAudioError,
  audioClipsFor,
  previewAudioKey,
  renderPreviewAudio,
} from "./preview-audio.ts";
export type { PreviewAudioDisabled, PreviewAudioMix, PreviewAudioOptions } from "./preview-audio.ts";
export { applyVariables, collectVariables, VariableError, VARIABLE_KEY } from "./variables.ts";
export type { VariableErrorCode } from "./variables.ts";
export { BatchError, assertBatchEntries, parseBatchFile, runBatch, workersPerJob } from "./batch.ts";
export type { BatchJob, BatchJobReport, BatchRenderChoices, BatchReport, BatchSpec, GpuChoice, RunBatchOptions } from "./batch.ts";
export { FRAMES_ERROR_CODES, FramesError, inspectFrames, lumaStats, parseFrameTimes } from "./frames.ts";
export type { FrameStat, FramesCode, FramesReport, InspectFramesOptions } from "./frames.ts";
