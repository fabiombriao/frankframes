// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../../../scripts/stage.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const CWD = process.cwd();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test("etapa que termina no prazo devolve o código de saída, o fim da saída e o log", async (t) => {
  const dir = await tempDir(t, "ff-stage-");
  const logFile = join(dir, "etapa.log");
  const result = await runCommand({
    file: process.execPath,
    args: ["-e", "console.log('linha de saída'); console.error('linha de erro'); process.exit(3)"],
    cwd: CWD,
    timeoutMs: 30_000,
    logFile,
    echo: false,
  });
  assert.equal(result.code, 3);
  assert.equal(result.timedOut, false);
  assert.match(result.tail, /linha de saída/);
  assert.match(result.tail, /linha de erro/);
  assert.match(await readFile(logFile, "utf8"), /linha de saída/);
});

test("etapa que passa do prazo é morta com os processos filhos e devolve o fim da saída", { timeout: 60_000 }, async () => {
  // O pai abre um neto que dorme muito, avisa o PID dele e também dorme: só matar a árvore resolve.
  const parent = `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    console.log("neto=" + grandchild.pid);
    setInterval(() => {}, 1000);
  `;
  const started = Date.now();
  const result = await runCommand({
    file: process.execPath,
    args: ["-e", parent],
    cwd: CWD,
    timeoutMs: 2_000,
    echo: false,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
  assert.ok(Date.now() - started < 30_000, "o prazo precisa valer, não esperar o processo terminar sozinho");
  const grandchildPid = Number(/neto=(\d+)/.exec(result.tail)?.[1]);
  assert.ok(Number.isInteger(grandchildPid), `a saída do pai deveria trazer o PID do neto: ${result.tail}`);

  // A morte do neto é assíncrona no sistema operacional: espera curta e limitada.
  const deadline = Date.now() + 10_000;
  while (alive(grandchildPid) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(alive(grandchildPid), false, "o neto continuou vivo depois do prazo");
});
