// FrankFrames — proprietário. Ver LICENSE na raiz.
export {
  PRESETS,
  CODECS,
  GPL_ENCODERS,
  POLICY_CODES,
  EncodePolicyError,
  parseFacts,
  policyViolations,
  assertFfmpegAllowed,
  assertDistributionSafe,
  assertCodecAllowed,
  containerFor,
  buildVideoArgs,
  buildMuxArgs,
  buildFramePipeArgs,
  buildFrameSequenceArgs,
} from "./policy.ts";
export type { FfmpegFacts, Preset, VideoCodec, PolicyCode, CodecChoice } from "./policy.ts";
export { detectFfmpeg } from "./detect.ts";
export { FFMPEG_BUILDS, ffmpegBuildFor, ffmpegPlatform } from "./ffmpeg-build.ts";
export type { FfmpegBuild, FfmpegPlatform } from "./ffmpeg-build.ts";
