// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BatchError, RenderError, assertBatchEntries, parseBatchFile, runBatch, workersPerJob } from "../src/index.ts";
import type { BatchJob, RenderOptions, RenderResult } from "../src/index.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

function job(id: string, extra: Partial<BatchJob> = {}): BatchJob {
  return { id, entry: `/x/${id}.html`, out: `/x/${id}.mp4`, ...extra };
}

function fakeResult(options: RenderOptions): RenderResult {
  return {
    outPath: options.outPath ?? "",
    frames: 15,
    durationSeconds: 0.5,
    codec: "av1",
    preset: "draft",
    hasAudio: false,
    warnings: [],
    hashes: new Map(),
    workDir: "",
  };
}

function throwsBatch(text: string): BatchError {
  try {
    parseBatchFile(text, resolve("/base"));
  } catch (error) {
    assert.ok(error instanceof BatchError, String(error));
    assert.equal(error.code, "E_BATCH_INVALID");
    return error;
  }
  throw new assert.AssertionError({ message: "esperava E_BATCH_INVALID" });
}

const VALID = {
  version: 1,
  concurrency: 2,
  defaults: { preset: "standard", codec: "av1", loudness: true },
  jobs: [
    { id: "cliente-a", entry: "promo/index.html", out: "out/cliente-a.mp4", vars: { titulo: "Oferta A" }, preset: "draft" },
    { id: "cliente-b", entry: "promo/index.html", out: "out/cliente-b.mp4" },
  ],
};

test("a fila segue depois de uma falha e o relatório traz succeeded, failed e error.code", async () => {
  const called: string[] = [];
  const report = await runBatch({
    jobs: [job("a"), job("b"), job("c")],
    render: async (options) => {
      called.push(options.entry);
      if (options.entry.endsWith("b.html")) throw new RenderError("E_CONTRACT", "compile", "contrato inválido em /x/b.html");
      return fakeResult(options);
    },
  });
  assert.deepEqual(called, ["/x/a.html", "/x/b.html", "/x/c.html"], "o job 3 roda mesmo com o 2 falhando");
  assert.equal(report.ok, false);
  assert.equal(report.total, 3);
  assert.equal(report.succeeded, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.jobs[0]!.ok, true);
  assert.equal(report.jobs[0]!.frames, 15);
  assert.equal(report.jobs[1]!.ok, false);
  assert.equal(report.jobs[1]!.error?.code, "E_CONTRACT");
  assert.equal(report.jobs[1]!.error?.stage, "compile");
  assert.ok(!report.jobs[1]!.error?.message.includes("/x/b.html"), "o relatório não vaza caminho absoluto");
  assert.equal(report.jobs[2]!.ok, true);
});

test("com concurrency 2 o pico de jobs simultâneos é exatamente 2", async () => {
  let running = 0;
  let peak = 0;
  const report = await runBatch({
    jobs: [job("a"), job("b"), job("c"), job("d"), job("e")],
    concurrency: 2,
    render: async (options) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((done) => setTimeout(done, 25));
      running -= 1;
      return fakeResult(options);
    },
  });
  assert.equal(peak, 2);
  assert.equal(report.succeeded, 5);
});

test("workers por job: 1 job de cada vez usa o padrão do render; N>1 divide o padrão da máquina", async () => {
  assert.equal(workersPerJob(1, 8), undefined);
  assert.equal(workersPerJob(2, 8), 4);
  assert.equal(workersPerJob(3, 8), 2);
  assert.equal(workersPerJob(4, 2), 1, "nunca abaixo de 1");

  const seen: Array<number | undefined> = [];
  await runBatch({
    jobs: [job("a"), job("b")],
    concurrency: 2,
    workers: 3,
    render: async (options) => {
      seen.push(options.workers);
      return fakeResult(options);
    },
  });
  assert.deepEqual(seen, [3, 3], "--workers explícito vale por job");
});

test("cancelar para de tirar jobs: o que rodava termina com E_CANCELED e o resto entra como cancelado", async () => {
  const controller = new AbortController();
  let started = 0;
  const report = await runBatch({
    jobs: [job("a"), job("b"), job("c")],
    concurrency: 1,
    signal: controller.signal,
    render: async (options) => {
      started += 1;
      controller.abort();
      // O render real converte o abort em E_CANCELED; o fake faz o mesmo.
      if (options.signal?.aborted === true) throw new RenderError("E_CANCELED", "capture", "render cancelado");
      return fakeResult(options);
    },
  });
  assert.equal(started, 1, "depois do cancelamento nenhum job novo começa");
  assert.equal(report.failed, 3);
  assert.deepEqual(
    report.jobs.map((item) => item.error?.code),
    ["E_CANCELED", "E_CANCELED", "E_CANCELED"],
  );
  assert.equal(report.jobs[0]!.error?.stage, "capture", "o job em andamento mantém o estágio em que parou");
  assert.match(report.jobs[1]!.error?.message ?? "", /antes de o job começar/);
});

test("um render que lança RenderError E_CANCELED aparece como E_CANCELED", async () => {
  const report = await runBatch({
    jobs: [job("a")],
    render: async () => {
      throw new RenderError("E_CANCELED", "capture", "render cancelado");
    },
  });
  assert.equal(report.jobs[0]!.error?.code, "E_CANCELED");
});

test("onJob e onProgress chegam com o id do job", async () => {
  const finished: string[] = [];
  const progress: string[] = [];
  await runBatch({
    jobs: [job("a"), job("b")],
    render: async (options) => {
      options.onProgress?.("capture", 50);
      return fakeResult(options);
    },
    onJob: (report) => finished.push(report.id),
    onProgress: (id, stage, percent) => progress.push(`${id}:${stage}:${percent}`),
  });
  assert.deepEqual(finished, ["a", "b"]);
  assert.deepEqual(progress, ["a:capture:50", "b:capture:50"]);
});

test("formato inválido vira E_BATCH_INVALID antes do render (contador = 0)", async () => {
  let renders = 0;
  const attempt = (spec: unknown): BatchError => {
    const error = throwsBatch(JSON.stringify(spec));
    assert.equal(renders, 0);
    return error;
  };
  const withJobs = (jobs: unknown[]): unknown => ({ version: 1, jobs });

  const duplicateOut = attempt(withJobs([{ id: "a", entry: "a.html", out: "x.mp4" }, { id: "b", entry: "b.html", out: "x.mp4" }]));
  assert.match(duplicateOut.message, /jobs\[1\]\.out/);
  assert.match(duplicateOut.message, /jobs\[0\]/);

  const badId = attempt(withJobs([{ id: "Cliente A", entry: "a.html", out: "a.mp4" }]));
  assert.match(badId.message, /jobs\[0\]\.id/);
  attempt(withJobs([{ id: "-a", entry: "a.html", out: "a.mp4" }]));
  const duplicateId = attempt(withJobs([{ id: "a", entry: "a.html", out: "a.mp4" }, { id: "a", entry: "b.html", out: "b.mp4" }]));
  assert.match(duplicateId.message, /jobs\[1\]\.id/);

  attempt({ version: 2, jobs: [] });
  attempt({ version: 1, jobs: [] });
  attempt({ version: 1, jobs: [{ id: "a", entry: "a.html", out: "a.mp4" }], extra: 1 });
  attempt({ version: 1, concurrency: 0, jobs: [{ id: "a", entry: "a.html", out: "a.mp4" }] });
  attempt(withJobs([{ id: "a", entry: "a.html", out: "a.mp4", preset: "ultra" }]));
  attempt(withJobs([{ id: "a", entry: "a.html", out: "a.mp4", vars: { titulo: 3 } }]));
  attempt(withJobs([{ id: "a", entry: "a.html", out: "a.mp4", vars: { "chave ruim": "x" } }]));
  attempt(withJobs([{ id: "a", entry: "a.html", out: "a.webm" }]));
  attempt(withJobs([{ id: "a", entry: "a.html", out: "a.mp4", extra: true }]));
  assert.match(throwsBatch("{não é json").message, /JSON inválido/);

  // O contador só prova algo se o render for realmente alcançável depois de um lote válido.
  const spec = parseBatchFile(JSON.stringify(withJobs([{ id: "a", entry: "a.html", out: "a.mp4" }])), resolve("/base"));
  await runBatch({
    jobs: spec.jobs,
    render: async (options) => {
      renders += 1;
      return fakeResult(options);
    },
  });
  assert.equal(renders, 1);
});

test("lote válido: caminhos relativos ao arquivo do lote, defaults e override por job", () => {
  const base = resolve("/base");
  const spec = parseBatchFile(JSON.stringify(VALID), base);
  assert.equal(spec.concurrency, 2);
  assert.equal(spec.jobs.length, 2);
  const [a, b] = spec.jobs as [BatchJob, BatchJob];
  assert.equal(a.entry, resolve(base, "promo/index.html"));
  assert.equal(a.out, resolve(base, "out/cliente-a.mp4"));
  assert.deepEqual(a.vars, { titulo: "Oferta A" });
  assert.equal(a.preset, "draft", "o job sobrescreve o default");
  assert.equal(b.preset, "standard", "sem preset no job vale o default");
  assert.equal(b.codec, "av1");
  assert.equal(b.vars, undefined);
});

test("loudness false nos defaults vale para os jobs, e o job pode voltar ao padrão com true", () => {
  const spec = parseBatchFile(
    JSON.stringify({
      version: 1,
      defaults: { loudness: false },
      jobs: [
        { id: "a", entry: "a.html", out: "a.mp4" },
        { id: "b", entry: "b.html", out: "b.mp4", loudness: true },
      ],
    }),
    resolve("/base"),
  );
  assert.equal(spec.jobs[0]!.loudness, false);
  assert.equal(spec.jobs[1]!.loudness, undefined);
});

test("assertBatchEntries aponta o job cujo HTML não existe", async (t) => {
  const dir = await tempDir(t, "ff-batch-");
  await mkdir(join(dir, "ok"), { recursive: true });
  await writeFile(join(dir, "ok", "index.html"), "<div></div>");
  assertBatchEntries([job("a", { entry: join(dir, "ok", "index.html") })]);
  assert.throws(
    () => assertBatchEntries([job("a", { entry: join(dir, "ok", "index.html") }), job("b", { entry: join(dir, "falta.html") })]),
    (error: unknown) => error instanceof BatchError && error.code === "E_BATCH_INVALID" && /jobs\[1\]\.entry/.test(error.message),
  );
});

test("concurrency inválido em runBatch é E_BATCH_INVALID", async () => {
  await assert.rejects(runBatch({ jobs: [job("a")], concurrency: 0 }), (error: unknown) => error instanceof BatchError);
});
