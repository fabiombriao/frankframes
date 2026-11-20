// FrankFrames — proprietário. Ver LICENSE na raiz.
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PINNED_BROWSER, checkPinnedBrowser } from "./pin.ts";

const run = promisify(execFile);

const WINDOWS_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

export interface ResolvedChrome {
  path: string;
  version: string;
  /** `true` quando é o shell pinado com digest conferido. */
  pinned: boolean;
  /** Avisos que o chamador deve propagar ao usuário. */
  warnings: string[];
}

/** Ordem: explícito -> env -> shell pinado -> Chrome do sistema (com aviso). */
export async function resolveChrome(explicit?: string): Promise<ResolvedChrome> {
  const warnings: string[] = [];

  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`binário inexistente: ${explicit}`);
    const { stdout } = await run(explicit, ["--version"], { timeout: 20_000 });
    return { path: explicit, version: stdout.trim().replace(/^Google Chrome\s*/i, ""), pinned: false, warnings };
  }

  const envPath = process.env.FRANKFRAMES_CHROME;
  if (envPath) {
    if (!existsSync(envPath)) throw new Error(`FRANKFRAMES_CHROME aponta para arquivo inexistente: ${envPath}`);
    const { stdout } = await run(envPath, ["--version"], { timeout: 20_000 });
    return { path: envPath, version: stdout.trim().replace(/^Google Chrome\s*/i, ""), pinned: false, warnings };
  }

  const pin = await checkPinnedBrowser();
  if (pin.present && pin.matches) {
    return { path: pin.path, version: PINNED_BROWSER.version, pinned: true, warnings };
  }
  if (pin.present && !pin.matches) {
    warnings.push(
      `shell pinado com digest diferente (esperado ${PINNED_BROWSER.sha256.slice(0, 16)}…, obtido ${(pin.digest ?? "").slice(0, 16)}…): não será usado`,
    );
  }

  if (process.platform === "win32") {
    for (const path of WINDOWS_CANDIDATES) {
      if (!existsSync(path)) continue;
      const { stdout } = await run(path, ["--version"], { timeout: 20_000 });
      warnings.push(`usando Chrome do sistema (${path}); pixels não são garantidos entre máquinas — rode \`frankframes browser install\``);
      return { path, version: stdout.trim().replace(/^Google Chrome\s*/i, ""), pinned: false, warnings };
    }
  }

  throw new Error(
    "nenhum browser encontrado: rode `frankframes browser install` (shell pinado 158) ou defina FRANKFRAMES_CHROME",
  );
}
