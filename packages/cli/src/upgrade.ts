// FrankFrames — proprietário. Ver LICENSE na raiz.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

/** Compara `a` com `b` no formato x.y.z. Negativo se `a < b`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export type UpgradeDecision = "atualizado" | "atualizar" | "não publicado" | "versão local mais nova";

export function decideUpgrade(current: string, latest: string | null): UpgradeDecision {
  if (latest === null) return "não publicado";
  const comparison = compareVersions(latest, current);
  if (comparison > 0) return "atualizar";
  if (comparison < 0) return "versão local mais nova";
  return "atualizado";
}

async function latestPublished(): Promise<string | null> {
  const response = await fetch("https://registry.npmjs.org/@frankframes%2Fcli/latest", {
    headers: { accept: "application/json" },
  }).catch(() => null);
  if (response === null || response.status === 404) return null;
  if (!response.ok) throw new Error(`registro npm respondeu HTTP ${response.status}`);
  const body = (await response.json()) as { version?: string };
  return body.version ?? null;
}

export async function runUpgrade(options: { apply: boolean }): Promise<number> {
  const manifest: unknown = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));
  const version = manifest !== null && typeof manifest === "object" && "version" in manifest ? manifest.version : undefined;
  if (typeof version !== "string") throw new Error("package.json sem campo version");
  const current = version;
  const latest = await latestPublished();
  const decision = decideUpgrade(current, latest);

  if (decision === "não publicado") {
    process.stdout.write(`versão local ${current}; @frankframes/cli ainda não está publicado no npm\n`);
    return 0;
  }
  if (decision === "atualizado") {
    process.stdout.write(`já está na versão publicada (${current})\n`);
    return 0;
  }
  if (decision === "versão local mais nova") {
    process.stdout.write(`local ${current} é mais nova que a publicada ${latest}\n`);
    return 0;
  }

  process.stdout.write(`atualização disponível: ${current} -> ${latest}\n`);
  if (!options.apply) {
    process.stdout.write("rode `frankframes upgrade --apply` para instalar\n");
    return 0;
  }

  const args = ["install", "-g", "@frankframes/cli@latest"];
  const child = spawn(process.platform === "win32" ? "cmd" : "npm", process.platform === "win32" ? ["/c", "npm", ...args] : args, {
    stdio: "inherit",
  });
  const exited = Promise.withResolvers<number>();
  child.on("exit", (code) => exited.resolve(code ?? 1));
  child.on("error", () => exited.resolve(1));
  return await exited.promise;
}
