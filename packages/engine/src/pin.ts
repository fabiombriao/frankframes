// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { assetPath } from "./home.ts";

/** Versão do shell headless: a mesma nas duas plataformas, senão o raster deixa de ser comparável. */
export const PINNED_BROWSER_VERSION = "158.0.8127.36";

/** Plataformas com shell pinado. Qualquer outra falha alto em `pinnedBrowser`. */
export type BrowserPlatform = "win64" | "linux64";

export interface BrowserPin {
  version: string;
  platform: BrowserPlatform;
  /** SHA-256 do executável (não do zip): é o que `checkPinnedBrowser` confere em disco. */
  sha256: string;
  /** Caminho do executável dentro de `browsers/`, como o `@puppeteer/browsers` o instala. */
  relative: string;
}

/**
 * Shell pinado, um por plataforma. Versão e digest são a garantia de que a rasterização não muda
 * entre a máquina de desenvolvimento e o cliente.
 */
export const BROWSER_PINS: Record<BrowserPlatform, BrowserPin> = {
  win64: {
    version: PINNED_BROWSER_VERSION,
    platform: "win64",
    sha256: "c8522395b1e3c0cb9c86308b4a963abf6a2bb49d28acddb76ca26fe8b68a3be5",
    relative: `chrome-headless-shell/win64-${PINNED_BROWSER_VERSION}/chrome-headless-shell-win64/chrome-headless-shell.exe`,
  },
  linux64: {
    version: PINNED_BROWSER_VERSION,
    platform: "linux64",
    sha256: "ed65d54a43663fa60ed8a277329fe73f307c31dd5b5db8dcfe91fda4274cf963",
    relative: `chrome-headless-shell/linux-${PINNED_BROWSER_VERSION}/chrome-headless-shell-linux64/chrome-headless-shell`,
  },
};

/** Códigos que o seletor de pin emite; entram no `docs/reference/diagnostics.md`. */
export const PLATFORM_ERROR_CODES = ["E_BROWSER_PLATFORM_UNSUPPORTED"] as const;

/** Plataforma sem shell pinado: erro com código e `hint` (o hint já vai dentro da `message`). */
export class BrowserPlatformError extends Error {
  readonly code = "E_BROWSER_PLATFORM_UNSUPPORTED";
  readonly hint: string;
  constructor(platform: string, arch: string) {
    const hint = `plataformas com pin: ${Object.keys(BROWSER_PINS).join(", ")}; em outra, aponte FRANKFRAMES_CHROME para um Chrome seu (os pixels não são garantidos entre máquinas)`;
    super(`E_BROWSER_PLATFORM_UNSUPPORTED: sem shell do Chrome pinado para ${platform}/${arch} (${hint})`);
    this.name = "BrowserPlatformError";
    this.hint = hint;
  }
}

/** Chave de plataforma do pin para o par `process.platform`/`process.arch`; `undefined` quando não há shell pinado. */
export function browserPlatform(platform: string = process.platform, arch: string = process.arch): BrowserPlatform | undefined {
  if (arch !== "x64") return undefined;
  if (platform === "win32") return "win64";
  if (platform === "linux") return "linux64";
  return undefined;
}

/** Shell pinado da plataforma. Sem pin é erro (`E_BROWSER_PLATFORM_UNSUPPORTED`): nunca usa o de outra plataforma. */
export function pinnedBrowser(platform: string = process.platform, arch: string = process.arch): BrowserPin {
  const key = browserPlatform(platform, arch);
  if (key === undefined) throw new BrowserPlatformError(platform, arch);
  return BROWSER_PINS[key];
}

export function pinnedBrowserPath(): string {
  return process.env.FRANKFRAMES_BROWSER_PATH ?? assetPath("browsers", pinnedBrowser().relative);
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
  return { path, present: true, digest, matches: digest === pinnedBrowser().sha256 };
}
