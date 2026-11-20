// FrankFrames — proprietário. Ver LICENSE na raiz.
export {
  PRESETS,
  CODECS,
  GPL_ENCODERS,
  EncodePolicyError,
  parseFacts,
  assertDistributionSafe,
  assertCodecAllowed,
  containerFor,
  buildVideoArgs,
  buildMuxArgs,
  buildFrameSequenceArgs,
} from "./policy.ts";
export type { FfmpegFacts, Preset, VideoCodec, PolicyCode, CodecChoice } from "./policy.ts";
export { detectFfmpeg } from "./detect.ts";
