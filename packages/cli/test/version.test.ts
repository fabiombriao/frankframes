// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-65: `frankframes --version` / `-v` imprime a versão do package.json do pacote cli.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));
const version = (JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string }).version;

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("--version imprime só a versão do package.json do cli e sai com 0", () => {
  assert.match(version, /^\d+\.\d+\.\d+/);
  const result = run("--version");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${version}\n`);
  assert.equal(result.stderr, "");
});

test("-v é o mesmo que --version", () => {
  const result = run("-v");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${version}\n`);
});

test("a ajuda documenta --version", () => {
  const result = run("--help");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /frankframes --version/);
});

test("package.json sem version: falha com E_VERSION_UNREADABLE, dica e exit 1", () => {
  // Cópia do src ao lado de um package.json sem `version`; dentro do repo para os imports de pacote resolverem.
  const base = mkdtempSync(join(fileURLToPath(new URL("../../../out/", import.meta.url)), "version-unreadable-"));
  try {
    cpSync(fileURLToPath(new URL("../src", import.meta.url)), join(base, "src"), { recursive: true });
    writeFileSync(join(base, "package.json"), JSON.stringify({ name: "@frankframes/cli", type: "module" }));
    const result = spawnSync(process.execPath, [join(base, "src", "cli.ts"), "--version"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^E_VERSION_UNREADABLE: package\.json sem campo version/);
    assert.match(result.stderr, /dica: reinstale/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("sem package.json ao lado de src/ também falha com E_VERSION_UNREADABLE", () => {
  const base = mkdtempSync(join(fileURLToPath(new URL("../../../out/", import.meta.url)), "version-unreadable-"));
  try {
    cpSync(fileURLToPath(new URL("../src", import.meta.url)), join(base, "src"), { recursive: true });
    // Nenhum package.json em `base`: a leitura falha com ENOENT.
    const result = spawnSync(process.execPath, [join(base, "src", "cli.ts"), "-v"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /^E_VERSION_UNREADABLE: /);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
