// FrankFrames — proprietário. Ver LICENSE na raiz.
import { basename, extname, resolve } from "node:path";
import { assertCodecAllowed, assertFfmpegAllowed, containerFor, detectFfmpeg } from "@frankframes/encode";
import type { VideoCodec } from "@frankframes/encode";
import type { FfmpegPair } from "@frankframes/producer";

/** Saída padrão: `<pasta>/<nome>.<contêiner>`; sem pasta, `out/` a partir do diretório atual. */
export function defaultOutput(entry: string, codec: VideoCodec, dir: string = resolve("out")): string {
  return resolve(dir,`${basename(entry, extname(entry))}.${containerFor(codec)}`);
}

/**
 * Guarda de licença do encode, a mesma para `frankframes render` e para o Studio: o FFmpeg precisa passar
 * na política (build LGPL; `distribution` recusa, `user-provided` só avisa) e ter o encoder do codec
 * pedido (H.264 só com `FRANKFRAMES_ALLOW_H264=1`). Lança `EncodePolicyError`. Os avisos de licença saem por
 * `onWarning` antes da checagem do codec, para chegarem ao usuário mesmo quando o codec é recusado.
 */
export async function guardEncoder(options: {
  pair: FfmpegPair;
  codec: VideoCodec;
  onWarning?: (warning: string) => void;
}): Promise<void> {
  const { pair, codec } = options;
  const mode =
    process.env.FRANKFRAMES_FFMPEG_MODE === "distribution" || process.env.FRANKFRAMES_FFMPEG_MODE === "user-provided"
      ? (process.env.FRANKFRAMES_FFMPEG_MODE as "distribution" | "user-provided")
      : pair.source === "vendor"
        ? "distribution"
        : "user-provided";
  const facts = await detectFfmpeg(pair.ffmpeg);
  for (const warning of assertFfmpegAllowed(facts, mode)) options.onWarning?.(warning);
  assertCodecAllowed(facts, { codec, allowH264: process.env.FRANKFRAMES_ALLOW_H264 === "1" });
}
