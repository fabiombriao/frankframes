// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-85: `--help`/`-h` em todo subcomando mostra a ajuda e não escreve nada (docs/contract.md §9e).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMANDS, HELP, isCommand, wantsHelp } from "../src/help.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Subcomandos citados na ajuda (`frankframes <cmd>`), na ordem em que aparecem. */
function commandsInHelp(): string[] {
  const found: string[] = [];
  for (const match of HELP.matchAll(/^ {2}frankframes ([a-z][a-z-]*)(?=\s|$)/gm)) {
    const name = match[1] as string;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** Ações citadas na ajuda (`frankframes blocks add`, `frankframes browser install`…): `[comando, ação]`. */
function actionsInHelp(): string[][] {
  const found: string[][] = [];
  for (const match of HELP.matchAll(/^ {2}frankframes ([a-z][a-z-]*) ([a-z]+)(?=\s|$)/gm)) {
    found.push([match[1] as string, match[2] as string]);
  }
  return found;
}

/** Foto do diretório: caminho relativo, tamanho e mtime de cada entrada, recursivo. */
async function snapshot(root: string): Promise<string[]> {
  const lines: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const info = await stat(full);
      lines.push(`${full.slice(root.length)}|${info.isDirectory() ? "d" : info.size}|${info.mtimeMs}`);
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  return lines.sort();
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, home: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, FRANKFRAMES_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`frankframes ${args.join(" ")} não terminou em 60 s`));
    }, 60_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("EDT-85: o registro de subcomandos e a ajuda citam os mesmos comandos", () => {
  assert.deepEqual([...commandsInHelp()].sort(), [...COMMANDS].sort(), "COMMANDS e HELP divergem");
  for (const name of COMMANDS) assert.ok(isCommand(name), name);
  assert.equal(isCommand("nao-existe"), false);
  assert.equal(isCommand("help"), false);
});

test("EDT-85: wantsHelp reconhece --help e -h em qualquer posição", () => {
  assert.equal(wantsHelp(["--help"]), true);
  assert.equal(wantsHelp(["-h"]), true);
  assert.equal(wantsHelp(["init", "pasta", "--help"]), true);
  assert.equal(wantsHelp(["frames", "-h", "v.mp4"]), true);
  assert.equal(wantsHelp(["init", "pasta"]), false);
  assert.equal(wantsHelp([]), false);
});

test("EDT-85: --help e -h em todo subcomando mostram a ajuda, saem com 0 e não escrevem nada", { timeout: 300_000 }, async (t) => {
  const cwd = await tempDir(t, "ff-help-");
  const home = await tempDir(t, "ff-help-home-");
  // Cada subcomando do registro, nu e com um alvo posicional (o caso que antes sobrescrevia o comando), mais as ações citadas na ajuda.
  const shapes: string[][] = [];
  for (const name of COMMANDS) shapes.push([name], [name, "alvo"]);
  for (const action of actionsInHelp()) shapes.push(action);
  shapes.push([]); // sem comando algum
  assert.ok(shapes.length >= COMMANDS.length * 2, "a descoberta de subcomandos não pode ficar vazia");

  const jobs = shapes.flatMap((shape) => (["--help", "-h"] as const).map((flag) => [...shape, flag]));
  const before = await snapshot(cwd);
  const failures: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < jobs.length; index = next++) {
      const args = jobs[index] as string[];
      const label = `frankframes ${args.join(" ")}`;
      const result = await runCli(args, cwd, home);
      if (result.status !== 0) failures.push(`${label}: exit ${result.status} (${result.stderr.trim().split("\n")[0] ?? ""})`);
      else if (!result.stdout.includes("uso:") || !result.stdout.includes("frankframes lint")) failures.push(`${label}: stdout sem a ajuda`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  assert.deepEqual(failures, [], `ajuda falhou em:\n${failures.join("\n")}`);
  assert.deepEqual(await snapshot(cwd), before, "a ajuda alterou o diretório de trabalho");
  assert.deepEqual(await readdir(home), [], "a ajuda escreveu no FRANKFRAMES_HOME");
});

test("EDT-85: init --help não cria pasta nem arquivo, mesmo com destino", { timeout: 60_000 }, async (t) => {
  const cwd = await tempDir(t, "ff-help-init-");
  const home = await tempDir(t, "ff-help-init-home-");
  for (const args of [["init", "--help"], ["init", "-h"], ["init", "novo", "--help"], ["init", "-h", "novo"]]) {
    const result = await runCli(args, cwd, home);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, /frankframes init \[diretório\]/);
    assert.deepEqual(await readdir(cwd), [], `${args.join(" ")} criou algo no diretório`);
  }
});

test("EDT-85: comando desconhecido sem --help continua falhando com exit 2", { timeout: 60_000 }, async (t) => {
  const cwd = await tempDir(t, "ff-help-unknown-");
  const home = await tempDir(t, "ff-help-unknown-home-");
  const result = await runCli(["nao-existe"], cwd, home);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /comando desconhecido: nao-existe/);
});
