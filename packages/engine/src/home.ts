// FrankFrames — proprietário. Ver LICENSE na raiz.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Raiz dos assets baixados (fontes, browser, FFmpeg, modelos).
 *
 * Ordem: `FRANKFRAMES_HOME` -> `vendor/` ao lado do código (monorepo) ->
 * `~/.frankframes` (instalação global, onde o pacote não é gravável ou não tem vendor).
 */
export function assetHome(): string {
  const fromEnv = process.env.FRANKFRAMES_HOME;
  if (fromEnv) return resolve(fromEnv);
  const repoVendor = fileURLToPath(new URL("../../../vendor/", import.meta.url));
  if (existsSync(repoVendor)) return repoVendor;
  return join(homedir(), ".frankframes");
}

export function assetPath(...segments: string[]): string {
  return join(assetHome(), ...segments);
}
