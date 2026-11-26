// FrankFrames — proprietário. Ver LICENSE na raiz.
import { EncodePolicyError } from "./policy.ts";

/** Plataformas com build de FFmpeg pinado. Qualquer outra falha alto em `ffmpegBuildFor`. */
export type FfmpegPlatform = "win64" | "linux64";

export interface FfmpegBuild {
  platform: FfmpegPlatform;
  /** `git describe` do FFmpeg: igual nas duas plataformas, senão o encode deixa de ser comparável. */
  version: string;
  /** Tag datada e imutável do BtbN/FFmpeg-Builds (`latest` é móvel: o SHA-256 deixaria de bater). */
  tag: string;
  archive: string;
  url: string;
  /** SHA-256 do arquivo baixado (não dos binários, que o manifesto guarda depois de extrair). */
  sha256: string;
  /** Pasta que o arquivo cria ao extrair. */
  root: string;
  /** `zip` no Windows; `tar.xz` no Linux (extração por `tar -xJf`). */
  format: "zip" | "tar.xz";
}

const VERSION = "N-129308-g17de9f8597";
const TAG = "autobuild-2026-11-26-12-56";

function build(platform: FfmpegPlatform, format: FfmpegBuild["format"], sha256: string): FfmpegBuild {
  const root = `ffmpeg-${VERSION}-${platform}-lgpl`;
  const archive = `${root}.${format}`;
  return {
    platform,
    version: VERSION,
    tag: TAG,
    archive,
    url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${TAG}/${archive}`,
    sha256,
    root,
    format,
  };
}

/** Builds LGPL (sem `--enable-gpl`, sem libx264/libx265) que o produto embarca, uma por plataforma. */
export const FFMPEG_BUILDS: Record<FfmpegPlatform, FfmpegBuild> = {
  win64: build("win64", "zip", "a5d0ac2c93907d281063a4c39fd2f14e2fd1189575b699216cff5f008f25540c"),
  linux64: build("linux64", "tar.xz", "671e661c5b0a9efd08e7dcb1922c1cc62c373adda4db4256b8fb7e5a87b39bac"),
};

/** Chave de plataforma do pin para o par `process.platform`/`process.arch`; `undefined` quando não há build pinado. */
export function ffmpegPlatform(platform: string = process.platform, arch: string = process.arch): FfmpegPlatform | undefined {
  if (arch !== "x64") return undefined;
  if (platform === "win32") return "win64";
  if (platform === "linux") return "linux64";
  return undefined;
}

/** Build pinado da plataforma. Sem pin é erro com código e `hint`: nunca cai num build de outra plataforma. */
export function ffmpegBuildFor(platform: string = process.platform, arch: string = process.arch): FfmpegBuild {
  const key = ffmpegPlatform(platform, arch);
  if (key === undefined) {
    throw new EncodePolicyError(
      "E_FFMPEG_PLATFORM_UNSUPPORTED",
      `sem build de FFmpeg pinado para ${platform}/${arch}`,
      { hint: `plataformas com pin: ${Object.keys(FFMPEG_BUILDS).join(", ")}; em outra, aponte FFMPEG_PATH e FFPROBE_PATH para um FFmpeg LGPL seu` },
    );
  }
  return FFMPEG_BUILDS[key];
}
