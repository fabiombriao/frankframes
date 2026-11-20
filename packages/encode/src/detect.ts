// FrankFrames — proprietário. Ver LICENSE na raiz.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseFacts } from "./policy.ts";
import type { FfmpegFacts } from "./policy.ts";

const run = promisify(execFile);

/** Lê os fatos reais do binário. Sem cache: um PATH trocado não pode passar despercebido. */
export async function detectFfmpeg(binary: string): Promise<FfmpegFacts> {
  const [version, encoders] = await Promise.all([
    run(binary, ["-hide_banner", "-version"], { maxBuffer: 1 << 20 }),
    run(binary, ["-hide_banner", "-encoders"], { maxBuffer: 8 << 20 }),
  ]);
  return parseFacts(binary, version.stdout, encoders.stdout);
}
