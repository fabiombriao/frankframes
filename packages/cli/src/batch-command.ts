// FrankFrames — proprietário. Ver LICENSE na raiz.
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Preset, VideoCodec } from "@frankframes/encode";
import { setHostOwnsSignals } from "@frankframes/engine";
import { BatchError, RenderError, assertBatchEntries, parseBatchFile, resolveFfmpeg, runBatch, toErrorPayload } from "@frankframes/producer";
import type { BatchJob, BatchReport } from "@frankframes/producer";
import { defaultOutput, guardEncoder } from "./render-guard.ts";

/** O que o `frankframes render` entrega ao lote: entradas soltas ou um arquivo de lote, mais as opções de render. */
export interface BatchCommandOptions {
  files: string[];
  batchFile?: string;
  out?: string;
  codec: VideoCodec;
  preset: Preset;
  gpu?: "auto" | "software" | "hardware";
  workers?: number;
  concurrency?: number;
  noLoudness: boolean;
  json: boolean;
}

export const BATCH_REPORT_NAME = "batch-report.json";

/** Segundos com vírgula decimal, como o resto da saída em português. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

/** `Promo A.html` vira `promo-a`: o id do relatório quando o lote vem de entradas soltas. */
function idFromFile(file: string, taken: Map<string, number>, position: number): string {
  const stem = basename(file, extname(file)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const base = stem === "" ? `job-${position + 1}` : stem;
  const seen = taken.get(base) ?? 0;
  taken.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen + 1}`;
}

/** Entradas soltas viram o mesmo lote do arquivo: um só validador (`id`, `out` único, contêiner) para os dois caminhos. */
function jobsFromFiles(options: BatchCommandOptions, outDir: string): BatchJob[] {
  const taken = new Map<string, number>();
  const defaults: Record<string, unknown> = {
    preset: options.preset,
    codec: options.codec,
    ...(options.gpu !== undefined ? { gpu: options.gpu } : {}),
    ...(options.noLoudness ? { loudness: false } : {}),
  };
  const raw = {
    version: 1,
    defaults,
    jobs: options.files.map((file, index) => ({
      id: idFromFile(file, taken, index),
      entry: resolve(file),
      out: defaultOutput(file, options.codec, outDir),
    })),
  };
  return parseBatchFile(JSON.stringify(raw), process.cwd()).jobs;
}

/** `-o` com várias entradas é uma pasta; um nome de arquivo aqui é erro de uso, não algo a adivinhar. */
function resolveOutDir(out: string | undefined): string {
  if (out === undefined) return resolve("out");
  const dir = resolve(out);
  if (existsSync(dir) ? !statSync(dir).isDirectory() : extname(dir) !== "") {
    throw new BatchError(`-o "${out}" não é uma pasta`, "com várias entradas, -o é a pasta de saída (ex.: -o out/lote/)");
  }
  return dir;
}

async function loadBatchFile(batchFile: string): Promise<{ jobs: BatchJob[]; concurrency?: number; reportDir: string }> {
  const path = resolve(batchFile);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BatchError(`arquivo de lote "${batchFile}" não existe`, "confira o caminho");
    throw error;
  }
  const spec = parseBatchFile(text, dirname(path));
  return { jobs: spec.jobs, ...(spec.concurrency !== undefined ? { concurrency: spec.concurrency } : {}), reportDir: dirname(path) };
}

function printSummary(report: BatchReport, reportPath: string): void {
  for (const job of report.jobs) {
    if (job.ok) {
      process.stdout.write(`ok    ${job.id} · ${job.out} · ${job.frames} frames · ${seconds(job.elapsedMs)}\n`);
    } else {
      process.stdout.write(`erro  ${job.id} · ${job.error?.code}${job.error?.stage ? ` (${job.error.stage})` : ""}: ${job.error?.message}\n`);
    }
  }
  process.stdout.write(`${report.succeeded}/${report.total} ok · ${seconds(report.elapsedMs)} · relatório em ${reportPath}\n`);
}

/**
 * `frankframes render a.html b.html -o pasta/` e `frankframes render --batch lote.json`. Devolve o código de saída:
 * 0 se todos os jobs renderizaram, 1 se algum falhou ou o lote era inválido. Falha de um job não para a fila.
 */
export async function runBatchCommand(options: BatchCommandOptions): Promise<number> {
  try {
    let jobs: BatchJob[];
    let reportDir: string;
    let concurrency = options.concurrency;
    if (options.batchFile !== undefined) {
      const loaded = await loadBatchFile(options.batchFile);
      jobs = loaded.jobs;
      reportDir = loaded.reportDir;
      concurrency ??= loaded.concurrency;
    } else {
      const outDir = resolveOutDir(options.out);
      jobs = jobsFromFiles(options, outDir);
      reportDir = outDir;
    }
    assertBatchEntries(jobs);

    const pair = await resolveFfmpeg();
    for (const warning of pair.warnings) process.stderr.write(`aviso: ${warning}\n`);
    // O guarda olha o FFmpeg e o codec: uma vez por codec distinto, com cada aviso de licença impresso uma vez só.
    const warned = new Set<string>();
    for (const codec of new Set(jobs.map((job) => job.codec ?? "av1"))) {
      await guardEncoder({
        pair,
        codec,
        onWarning: (warning) => {
          if (warned.has(warning)) return;
          warned.add(warning);
          process.stderr.write(`aviso licença: ${warning}\n`);
        },
      });
    }

    // Ctrl+C: o 1º para de tirar jobs e cancela os que rodam (limpam pelo caminho de cancelamento do render);
    // o 2º sai na hora, e o handler de saída de cada render apaga o que sobrou.
    // O Puppeteer sairia com 130 no 1º SIGINT, antes de o lote cancelar e gravar o relatório: os sinais são nossos.
    setHostOwnsSignals(true);
    const controller = new AbortController();
    let signals = 0;
    const onSignal = (): void => {
      signals += 1;
      if (signals > 1) process.exit(130);
      process.stderr.write("cancelando o lote… (Ctrl+C de novo sai na hora)\n");
      controller.abort();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const lastStage = new Map<string, string>();
    let report: BatchReport;
    try {
      report = await runBatch({
        jobs,
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(options.workers !== undefined ? { workers: options.workers } : {}),
        signal: controller.signal,
        common: { ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe },
        onProgress: (jobId, stage) => {
          if (options.json || lastStage.get(jobId) === stage) return;
          lastStage.set(jobId, stage);
          process.stderr.write(`[${jobId}] ${stage}\n`);
        },
        onJob: (job) => {
          if (options.json) return;
          process.stderr.write(`[${job.id}] ${job.ok ? `pronto em ${seconds(job.elapsedMs)}` : `falhou: ${job.error?.code}`}\n`);
        },
      });
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      setHostOwnsSignals(false);
    }

    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, BATCH_REPORT_NAME);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printSummary(report, reportPath);
    return report.ok ? 0 : 1;
  } catch (error) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(toErrorPayload(error), null, 2)}\n`);
    } else if (error instanceof BatchError) {
      process.stderr.write(`erro ${error.code}: ${error.message}\n`);
    } else if (error instanceof RenderError) {
      process.stderr.write(`erro ${error.code} no estágio ${error.stage}: ${error.message}\n`);
    } else {
      process.stderr.write(`erro: ${(error as Error).message}\n`);
    }
    return 1;
  }
}
