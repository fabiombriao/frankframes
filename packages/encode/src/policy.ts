// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Fatos de um binário FFmpeg, coletados de `-version` e `-encoders`. */
export interface FfmpegFacts {
  binary: string;
  version: string;
  /** Flags de build (`--enable-gpl`, `--enable-libx264`, ...). */
  configuration: string[];
  encoders: string[];
}

export type Preset = "draft" | "standard" | "high";
export type VideoCodec = "av1" | "vp9" | "h264";

export type PolicyCode =
  | "E_FFMPEG_GPL"
  | "E_GPL_ENCODER"
  | "E_ENCODER_MISSING"
  | "E_H264_NOT_OPTED_IN"
  | "E_CODEC_UNSUPPORTED";

export class EncodePolicyError extends Error {
  readonly code: PolicyCode;
  constructor(code: PolicyCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EncodePolicyError";
    this.code = code;
  }
}

/** Encoders que tornam o binário GPL. Nunca chamados, em nenhum preset. */
export const GPL_ENCODERS = ["libx264", "libx264rgb", "libx265", "libx262", "libfdk_aac"] as const;

interface PresetSpec {
  av1: { crf: number; svtPreset: number };
  vp9: { crf: number; cpuUsed: number };
  h264: { bitrate: string; profile: string };
}

/** Números medidos nesta máquina: 1080p30, 60 frames. Ver docs/encode.md. */
export const PRESETS: Record<Preset, PresetSpec> = {
  draft: { av1: { crf: 42, svtPreset: 10 }, vp9: { crf: 48, cpuUsed: 5 }, h264: { bitrate: "3M", profile: "baseline" } },
  standard: { av1: { crf: 32, svtPreset: 8 }, vp9: { crf: 34, cpuUsed: 4 }, h264: { bitrate: "8M", profile: "main" } },
  high: { av1: { crf: 26, svtPreset: 6 }, vp9: { crf: 28, cpuUsed: 2 }, h264: { bitrate: "16M", profile: "high" } },
};

export const CODECS: VideoCodec[] = ["av1", "vp9", "h264"];

/** Extrai configuração e encoders das saídas de `-version` e `-encoders`. */
export function parseFacts(binary: string, versionText: string, encodersText: string): FfmpegFacts {
  const lines = versionText.split(/\r?\n/);
  const version = (lines[0] ?? "").replace(/^ffmpeg version\s*/i, "").split(/\s+/)[0] ?? "";
  const configuration = lines
    .filter((l) => l.includes("--enable-"))
    .flatMap((l) => l.trim().split(/\s+/))
    .filter((flag) => flag.startsWith("--enable-"));

  const encoders: string[] = [];
  for (const line of encodersText.split(/\r?\n/)) {
    const m = /^\s*[VAS][.A-Z]{5}\s+(\S+)/.exec(line);
    if (m) encoders.push(m[1]!);
  }
  return { binary, version, configuration, encoders };
}

/**
 * Recusa qualquer configuração que torne o produto indefensável na distribuição.
 * Chamado antes do primeiro encode, em todo processo, inclusive nos testes.
 */
export function assertDistributionSafe(facts: FfmpegFacts): void {
  if (facts.configuration.includes("--enable-gpl")) {
    throw new EncodePolicyError(
      "E_FFMPEG_GPL",
      `${facts.binary} foi compilado com --enable-gpl (versão ${facts.version}); distribuir esse binário impõe GPL ao produto`,
      { cause: { configuration: facts.configuration.filter((f) => f.startsWith("--enable-gpl") || f.startsWith("--enable-libx")) } },
    );
  }
  for (const encoder of GPL_ENCODERS) {
    if (facts.encoders.includes(encoder)) {
      throw new EncodePolicyError(
        "E_GPL_ENCODER",
        `${facts.binary} expõe o encoder ${encoder}, que é GPL; use libsvtav1, libvpx-vp9 ou libopenh264`,
      );
    }
  }
}

export interface CodecChoice {
  codec: VideoCodec;
  /** H.264 só existe via libopenh264, que precisa de opt-in explícito. */
  allowH264?: boolean;
}

export function assertCodecAllowed(facts: FfmpegFacts, choice: CodecChoice): void {
  const required = choice.codec === "av1" ? ["libsvtav1"] : choice.codec === "vp9" ? ["libvpx-vp9"] : ["libopenh264"];
  for (const encoder of required) {
    if (!facts.encoders.includes(encoder)) {
      throw new EncodePolicyError("E_ENCODER_MISSING", `${facts.binary} não tem ${encoder}; codec ${choice.codec} indisponível`);
    }
  }
  if (choice.codec === "h264" && choice.allowH264 !== true) {
    throw new EncodePolicyError(
      "E_H264_NOT_OPTED_IN",
      "H.264 exige --allow-h264-openh264: patentes AVC não são cobertas por escrever código próprio",
    );
  }
}

export function containerFor(codec: VideoCodec): "mp4" | "webm" {
  return codec === "vp9" ? "webm" : "mp4";
}

/** Argumentos de vídeo. Determinísticos: mesma entrada, mesma string. */
export function buildVideoArgs(codec: VideoCodec, preset: Preset): string[] {
  const spec = PRESETS[preset];
  if (codec === "av1") {
    return ["-c:v", "libsvtav1", "-preset", String(spec.av1.svtPreset), "-crf", String(spec.av1.crf), "-pix_fmt", "yuv420p"];
  }
  if (codec === "vp9") {
    return [
      "-c:v",
      "libvpx-vp9",
      "-crf",
      String(spec.vp9.crf),
      "-b:v",
      "0",
      "-row-mt",
      "1",
      "-deadline",
      "good",
      "-cpu-used",
      String(spec.vp9.cpuUsed),
      "-pix_fmt",
      "yuv420p",
    ];
  }
  return ["-c:v", "libopenh264", "-b:v", spec.h264.bitrate, "-profile:v", spec.h264.profile, "-pix_fmt", "yuv420p"];
}

/** Args de muxing. `+faststart` é MP4-only; WebM nunca recebe a flag. */
export function buildMuxArgs(codec: VideoCodec): string[] {
  const container = containerFor(codec);
  return container === "mp4" ? ["-movflags", "+faststart"] : [];
}

/** Args completos do encode de uma sequência de PNGs (`frame_%06d.png`). */
export function buildFrameSequenceArgs(input: {
  framesDir: string;
  fps: { num: number; den: number };
  codec: VideoCodec;
  preset: Preset;
  outPath: string;
}): string[] {
  const rate = input.fps.den === 1 ? String(input.fps.num) : `${input.fps.num}/${input.fps.den}`;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-xerror",
    "-framerate",
    rate,
    "-i",
    `${input.framesDir}/frame_%06d.png`,
    ...buildVideoArgs(input.codec, input.preset),
    "-r",
    rate,
    "-video_track_timescale",
    "90000",
    ...buildMuxArgs(input.codec),
    "-y",
    input.outPath,
  ];
}
