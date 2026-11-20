// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Shell pinado. Versão e digest são a garantia de que a rasterização não muda
 * entre a máquina de desenvolvimento e o cliente.
 */
export const PINNED_BROWSER = {
  version: "158.0.8127.36",
  platform: "win64",
  sha256: "c8522395b1e3c0cb9c86308b4a963abf6a2bb49d28acddb76ca26fe8b68a3be5",
  relative: "chrome-headless-shell/win64-158.0.8127.36/chrome-headless-shell-win64/chrome-headless-shell.exe",
} as const;

const VENDOR_ROOT = fileURLToPath(new URL("../../../vendor/browsers/", import.meta.url));

export function pinnedBrowserPath(): string {
  return process.env.FRANKFRAMES_BROWSER_PATH ?? join(VENDOR_ROOT, PINNED_BROWSER.relative);
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface PinCheck {
  path: string;
  present: boolean;
  digest?: string;
  matches: boolean;
}

/** Verifica o shell pinado. Digest diferente = binário trocado: nunca usar em silêncio. */
export async function checkPinnedBrowser(): Promise<PinCheck> {
  const path = pinnedBrowserPath();
  try {
    await access(path);
  } catch {
    return { path, present: false, matches: false };
  }
  const digest = await fileSha256(path);
  return { path, present: true, digest, matches: digest === PINNED_BROWSER.sha256 };
}
