// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { checkPinnedBrowser } from "@frankframes/engine";
import { resolveFfmpeg } from "@frankframes/producer";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], cwd?: string): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { encoding: "utf8", ...(cwd !== undefined ? { cwd } : {}), timeout: 600_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code !== "number") throw error;
    return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const TEMPLATE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#0b0b0f;color:#fff}
  #stage{position:relative;width:320px;height:180px;font-family:"FF Inter"}
  .title{position:absolute;left:20px;top:60px;font-size:28px;font-weight:700}
</style></head><body>
<div id="stage" data-composition-id="lote" data-root="true" data-width="320" data-height="180" data-fps="30" data-duration="0.5">
  <div class="title" data-var="titulo">Autoral</div>
  <div class="title" style="top:110px;font-size:18px" data-var="sub">Subtítulo autoral</div>
</div></body></html>`;

async function workspace(t: TestContext): Promise<string> {
  const dir = await tempDir(t, "ff-batch-cli-");
  await writeFile(join(dir, "promo.html"), TEMPLATE);
  return dir;
}

test("erros de uso e de formato saem antes de qualquer render (sem Chrome nem FFmpeg)", { timeout: 120_000 }, async (t) => {
  const dir = await workspace(t);

  const notDir = await cli(["render", join(dir, "promo.html"), join(dir, "promo.html"), "-o", join(dir, "saida.mp4"), "--json"]);
  assert.equal(notDir.code, 1);
  assert.equal(JSON.parse(notDir.stdout).code, "E_BATCH_INVALID");
  assert.deepEqual(await readdir(dir), ["promo.html"], "nada foi criado");

  const single = await cli(["render", join(dir, "promo.html"), "--concurrency", "2"]);
  assert.equal(single.code, 2);
  assert.match(single.stderr, /só vale em lote/);

  const zero = await cli(["render", "a.html", "b.html", "--concurrency", "0"]);
  assert.equal(zero.code, 2);

  await writeFile(join(dir, "ruim.json"), JSON.stringify({ version: 1, jobs: [{ id: "A B", entry: "promo.html", out: "a.mp4" }] }));
  const invalid = await cli(["render", "--batch", join(dir, "ruim.json"), "--json"]);
  assert.equal(invalid.code, 1);
  const payload = JSON.parse(invalid.stdout);
  assert.equal(payload.code, "E_BATCH_INVALID");
  assert.match(payload.message, /jobs\[0\]\.id/);

  const mixed = await cli(["render", "--batch", join(dir, "ruim.json"), "--preset", "draft"]);
  assert.equal(mixed.code, 2);
  assert.match(mixed.stderr, /--preset/);

  const missing = await cli(["render", "--batch", join(dir, "nao-existe.json")]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /E_BATCH_INVALID/);
});

test("lote de 2 jobs com data-var: um falta variável, sai 1, gera 1 MP4 e batch-report.json", { timeout: 600_000 }, async (t) => {
  let ffmpegOk = true;
  try {
    await resolveFfmpeg();
  } catch {
    ffmpegOk = false;
  }
  if (!ffmpegOk) return t.skip("ffmpeg não encontrado");
  const pin = await checkPinnedBrowser();
  if (!pin.present || !pin.matches) return t.skip("shell de browser pinado ausente");

  const dir = await workspace(t);
  await mkdir(join(dir, "out"), { recursive: true });
  await writeFile(
    join(dir, "lote.json"),
    JSON.stringify({
      version: 1,
      defaults: { preset: "draft", gpu: "software" },
      jobs: [
        { id: "cliente-a", entry: "promo.html", out: "out/cliente-a.mp4", vars: { titulo: "Oferta A", sub: "Só hoje" } },
        { id: "cliente-b", entry: "promo.html", out: "out/cliente-b.mp4", vars: { titulo: "Oferta B" } },
      ],
    }),
  );

  const outcome = await cli(["render", "--batch", join(dir, "lote.json"), "--workers", "1"]);
  assert.equal(outcome.code, 1, `${outcome.stdout}\n${outcome.stderr}`);
  assert.match(outcome.stdout, /1\/2 ok/);

  const report = JSON.parse(await readFile(join(dir, "batch-report.json"), "utf8"));
  assert.equal(report.ok, false);
  assert.equal(report.total, 2);
  assert.equal(report.succeeded, 1);
  assert.equal(report.failed, 1);
  const [a, b] = report.jobs;
  assert.equal(a.id, "cliente-a");
  assert.equal(a.ok, true);
  assert.equal(a.frames, 15);
  assert.equal(b.id, "cliente-b");
  assert.equal(b.ok, false);
  assert.equal(b.error.code, "E_VAR_MISSING");

  assert.ok((await stat(join(dir, "out", "cliente-a.mp4"))).size > 0, "o job que passou gerou o MP4");
  assert.deepEqual((await readdir(join(dir, "out"))).sort(), ["cliente-a.mp4"], "o job com erro não deixa arquivo nem .partial");
});

test("várias entradas com -o <pasta>: um MP4 por entrada e relatório na pasta", { timeout: 600_000 }, async (t) => {
  let ffmpegOk = true;
  try {
    await resolveFfmpeg();
  } catch {
    ffmpegOk = false;
  }
  if (!ffmpegOk) return t.skip("ffmpeg não encontrado");
  const pin = await checkPinnedBrowser();
  if (!pin.present || !pin.matches) return t.skip("shell de browser pinado ausente");

  const dir = await workspace(t);
  await writeFile(join(dir, "outro.html"), TEMPLATE);
  const outDir = join(dir, "saida");
  const outcome = await cli(["render", join(dir, "promo.html"), join(dir, "outro.html"), "-o", outDir, "--preset", "draft", "--workers", "1", "--json"]);
  // Sem `vars`, o `data-var` mantém o texto autoral: os dois jobs passam.
  assert.equal(outcome.code, 0, `${outcome.stdout}\n${outcome.stderr}`);
  const report = JSON.parse(outcome.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.succeeded, 2);
  assert.deepEqual((await readdir(outDir)).sort(), ["batch-report.json", "outro.mp4", "promo.mp4"]);
});
