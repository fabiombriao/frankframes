// FrankFrames — proprietário. Ver LICENSE na raiz.
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface FfmpegPair {
  ffmpeg: string;
  ffprobe: string;
  /** `vendor` = binário que nós distribuímos; `env`/`path` = escolha do usuário. */
  source: "env" | "vendor" | "path";
  warnings: string[];
}

const VENDOR_BIN = fileURLToPath(new URL("../vendor/ffmpeg/bin/", import.meta.url));
const EXE = process.platform === "win32" ? ".exe" : "";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ordem: env explícito -> build LGPL que embarcamos -> PATH.
 * A ordem importa para a política de licença: só o binário `vendor` é "nosso".
 */
export async function resolveFfmpeg(): Promise<FfmpegPair> {
  const envFfmpeg = process.env.FFMPEG_PATH;
  const envFfprobe = process.env.FFPROBE_PATH;
  if (envFfmpeg) {
    return {
      ffmpeg: envFfmpeg,
      ffprobe: envFfprobe ?? envFfmpeg.replace(/ffmpeg(\.exe)?$/i, `ffprobe$1`),
      source: "env",
      warnings: [],
    };
  }

  const vendored = join(VENDOR_BIN, `ffmpeg${EXE}`);
  if (await exists(vendored)) {
    return { ffmpeg: vendored, ffprobe: join(VENDOR_BIN, `ffprobe${EXE}`), source: "vendor", warnings: [] };
  }

  return {
    ffmpeg: "ffmpeg",
    ffprobe: "ffprobe",
    source: "path",
    warnings: ["usando FFmpeg do PATH: o render depende de um binário que não controlamos; rode `node scripts/vendor-ffmpeg.ts`"],
  };
}
