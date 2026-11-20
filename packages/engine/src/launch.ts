// FrankFrames — proprietário. Ver LICENSE na raiz.
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const WINDOWS_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

/** Candidatos para o shell headless. O download pinado entra na próxima fatia (E1b). */
export function defaultChromeCandidates(): string[] {
  const fromEnv = process.env.FRANKFRAMES_CHROME;
  const env = fromEnv ? [fromEnv] : [];
  return process.platform === "win32" ? [...env, ...WINDOWS_CANDIDATES] : env;
}

export async function resolveChrome(explicit?: string): Promise<{ path: string; version: string }> {
  const candidates = explicit ? [explicit] : defaultChromeCandidates();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const { stdout } = await run(path, ["--version"], { timeout: 20_000 });
    return { path, version: stdout.trim().replace(/^Google Chrome\s*/i, "") };
  }
  throw new Error(
    `Chrome não encontrado. Defina FRANKFRAMES_CHROME ou passe executablePath. Tentado: ${candidates.join(", ") || "(nada)"}`,
  );
}
