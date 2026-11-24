// FrankFrames — proprietário. Ver LICENSE na raiz.
import { existsSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { CODECS, PRESETS, containerFor } from "@frankframes/encode";
import type { Preset, VideoCodec } from "@frankframes/encode";
import { defaultWorkerCount } from "@frankframes/engine";
import type { ErrorPayload } from "./errors.ts";
import { toErrorPayload } from "./errors.ts";
import { RenderError, renderComposition } from "./render.ts";
import type { RenderOptions, RenderResult, RenderStage } from "./render.ts";
import { VARIABLE_KEY } from "./variables.ts";

/** Lote malformado: sai antes de começar qualquer render. A mensagem já traz o campo e o índice do job. */
export class BatchError extends Error {
  readonly code = "E_BATCH_INVALID";
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(`${message} (${hint})`);
    this.name = "BatchError";
    this.hint = hint;
  }
}

export type GpuChoice = "auto" | "software" | "hardware";
const GPU_CHOICES: GpuChoice[] = ["auto", "software", "hardware"];
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Opções de render que o lote aceita por padrão (`defaults`) e por job. */
export interface BatchRenderChoices {
  preset?: Preset;
  codec?: VideoCodec;
  gpu?: GpuChoice;
  /** `false` entrega o mix sem normalizar para −14 LUFS. */
  loudness?: false;
}

/** Job já resolvido: caminhos absolutos e `defaults` aplicados. */
export interface BatchJob extends BatchRenderChoices {
  id: string;
  entry: string;
  out: string;
  vars?: Record<string, string>;
}

export interface BatchSpec {
  concurrency?: number;
  jobs: BatchJob[];
}

function invalidField(where: string, problem: string, hint: string): BatchError {
  return new BatchError(`${where}: ${problem}`, hint);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(where: string, value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalidField(where, `campo desconhecido "${key}"`, `campos aceitos: ${allowed.join(", ")}`);
    }
  }
}

/** `preset`, `codec`, `gpu` e `loudness`, nos `defaults` e em cada job. */
function parseChoices(where: string, value: Record<string, unknown>): BatchRenderChoices {
  const choices: BatchRenderChoices = {};
  if (value.preset !== undefined) {
    if (typeof value.preset !== "string" || !Object.hasOwn(PRESETS, value.preset)) {
      throw invalidField(`${where}.preset`, `valor inválido`, `use ${Object.keys(PRESETS).join(", ")}`);
    }
    choices.preset = value.preset as Preset;
  }
  if (value.codec !== undefined) {
    if (typeof value.codec !== "string" || !CODECS.includes(value.codec as VideoCodec)) {
      throw invalidField(`${where}.codec`, `valor inválido`, `use ${CODECS.join(", ")}`);
    }
    choices.codec = value.codec as VideoCodec;
  }
  if (value.gpu !== undefined) {
    if (typeof value.gpu !== "string" || !GPU_CHOICES.includes(value.gpu as GpuChoice)) {
      throw invalidField(`${where}.gpu`, `valor inválido`, `use ${GPU_CHOICES.join(", ")}`);
    }
    choices.gpu = value.gpu as GpuChoice;
  }
  if (value.loudness !== undefined) {
    if (typeof value.loudness !== "boolean") {
      throw invalidField(`${where}.loudness`, `precisa ser true ou false`, "false entrega o mix sem normalizar");
    }
    if (!value.loudness) choices.loudness = false;
  }
  return choices;
}

function parseConcurrency(where: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalidField(where, "precisa ser um inteiro maior ou igual a 1", "ex.: 2");
  }
  return value;
}

/** Chave de comparação de caminho: o Windows não diferencia maiúsculas. */
function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

const JOB_KEYS = ["id", "entry", "out", "vars", "preset", "codec", "gpu", "loudness"];

/**
 * Lê o arquivo de lote (§ docs/batch.md) e valida tudo antes de qualquer render: formato, `id` e `out` únicos,
 * contêiner coerente com o codec, `vars` texto→texto. Caminhos relativos valem a partir de `baseDir`
 * (a pasta do arquivo do lote). Erro vira `BatchError` com o campo e o índice do job.
 */
export function parseBatchFile(text: string, baseDir: string): BatchSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new BatchError(`JSON inválido: ${(error as Error).message}`, "confira vírgulas e aspas do arquivo do lote");
  }
  if (!isRecord(raw)) throw new BatchError("o lote precisa ser um objeto JSON", 'comece com {"version": 1, "jobs": [...]}');
  rejectUnknownKeys("lote", raw, ["version", "concurrency", "defaults", "jobs"]);
  if (raw.version !== 1) throw invalidField("version", "precisa ser 1", 'escreva "version": 1');
  const concurrency = raw.concurrency === undefined ? undefined : parseConcurrency("concurrency", raw.concurrency);

  let defaults: BatchRenderChoices = {};
  if (raw.defaults !== undefined) {
    if (!isRecord(raw.defaults)) throw invalidField("defaults", "precisa ser um objeto", "ex.: {\"preset\": \"draft\"}");
    rejectUnknownKeys("defaults", raw.defaults, ["preset", "codec", "gpu", "loudness"]);
    defaults = parseChoices("defaults", raw.defaults);
  }

  if (!Array.isArray(raw.jobs) || raw.jobs.length === 0) {
    throw invalidField("jobs", "precisa ser uma lista com pelo menos um job", "cada job tem id, entry e out");
  }

  const ids = new Map<string, number>();
  const outs = new Map<string, number>();
  const jobs: BatchJob[] = raw.jobs.map((item: unknown, index: number): BatchJob => {
    const where = `jobs[${index}]`;
    if (!isRecord(item)) throw invalidField(where, "precisa ser um objeto", "cada job tem id, entry e out");
    rejectUnknownKeys(where, item, JOB_KEYS);

    const { id, entry, out } = item;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      throw invalidField(`${where}.id`, `"${String(id)}" não é um id válido`, "use letras minúsculas, dígitos e hífen, começando por letra ou dígito");
    }
    const sameId = ids.get(id);
    if (sameId !== undefined) throw invalidField(`${where}.id`, `"${id}" repete jobs[${sameId}]`, "cada job precisa de um id único");
    ids.set(id, index);
    if (typeof entry !== "string" || entry === "") throw invalidField(`${where}.entry`, "precisa ser o caminho de um HTML", "caminho relativo ao arquivo do lote");
    if (typeof out !== "string" || out === "") throw invalidField(`${where}.out`, "precisa ser o caminho do vídeo de saída", "caminho relativo ao arquivo do lote");

    const choices = { ...defaults, ...parseChoices(where, item) };
    // `loudness` só existe como `false`: um job que escreve `true` volta ao padrão, mesmo se `defaults` desligou.
    if (item.loudness === true) delete choices.loudness;
    const codec = choices.codec ?? "av1";
    const outPath = isAbsolute(out) ? resolve(out) : resolve(baseDir, out);
    const expected = `.${containerFor(codec)}`;
    if (extname(outPath).toLowerCase() !== expected) {
      throw invalidField(`${where}.out`, `a extensão de "${out}" não combina com o codec ${codec}`, `use ${expected}`);
    }
    const sameOut = outs.get(pathKey(outPath));
    if (sameOut !== undefined) throw invalidField(`${where}.out`, `"${out}" repete jobs[${sameOut}]`, "cada job precisa de uma saída própria");
    outs.set(pathKey(outPath), index);

    let vars: Record<string, string> | undefined;
    if (item.vars !== undefined) {
      if (!isRecord(item.vars)) throw invalidField(`${where}.vars`, "precisa ser um objeto texto→texto", 'ex.: {"titulo": "Oferta A"}');
      vars = {};
      for (const [key, value] of Object.entries(item.vars)) {
        if (!VARIABLE_KEY.test(key)) {
          throw invalidField(`${where}.vars`, `"${key}" não é um nome de variável`, "use letras, dígitos, _ e -, começando por letra ou _");
        }
        if (typeof value !== "string") {
          throw invalidField(`${where}.vars.${key}`, "o valor precisa ser texto", "escreva o número ou o booleano entre aspas");
        }
        vars[key] = value;
      }
    }

    return {
      id,
      entry: isAbsolute(entry) ? resolve(entry) : resolve(baseDir, entry),
      out: outPath,
      ...(vars !== undefined ? { vars } : {}),
      ...choices,
    };
  });

  return { ...(concurrency !== undefined ? { concurrency } : {}), jobs };
}

/** Falha antes de renderizar se algum HTML de entrada não existe: erro de caminho não pode esperar a fila. */
export function assertBatchEntries(jobs: BatchJob[]): void {
  jobs.forEach((job, index) => {
    if (!existsSync(job.entry)) {
      throw invalidField(`jobs[${index}].entry`, `"${job.entry}" não existe`, "confira o caminho (relativo ao arquivo do lote)");
    }
  });
}

/** Workers de cada render quando vários rodam juntos: divide o padrão da máquina, nunca abaixo de 1. */
export function workersPerJob(concurrency: number, machineDefault: number = defaultWorkerCount()): number | undefined {
  return concurrency > 1 ? Math.max(1, Math.floor(machineDefault / concurrency)) : undefined;
}

export interface BatchJobReport {
  id: string;
  entry: string;
  out: string;
  ok: boolean;
  elapsedMs: number;
  frames?: number;
  durationSeconds?: number;
  warnings?: string[];
  error?: ErrorPayload;
}

export interface BatchReport {
  ok: boolean;
  total: number;
  succeeded: number;
  failed: number;
  elapsedMs: number;
  jobs: BatchJobReport[];
}

export interface RunBatchOptions {
  jobs: BatchJob[];
  /** Jobs ao mesmo tempo; padrão 1. */
  concurrency?: number;
  /** Workers por render. Sem isso: o padrão do render com `concurrency` 1, ou a divisão do padrão da máquina. */
  workers?: number;
  /** Cancela o lote: para de tirar jobs e propaga o sinal para os renders em andamento. */
  signal?: AbortSignal;
  /** Opções iguais para todos os jobs (binários do FFmpeg). */
  common?: Pick<RenderOptions, "ffmpeg" | "ffprobe">;
  /** Troca o render; existe para o teste não precisar de Chrome. */
  render?: (options: RenderOptions) => Promise<RenderResult>;
  onProgress?: (jobId: string, stage: RenderStage, percent: number, message?: string) => void;
  /** Chamado quando cada job termina (ok, falha ou cancelado). */
  onJob?: (report: BatchJobReport) => void;
}

function canceledError(): ErrorPayload {
  return toErrorPayload(new RenderError("E_CANCELED", "compile", "lote cancelado antes de o job começar"));
}

/**
 * Fila com limite: nunca lança por job. Uma falha vira `ok: false` com o `error` de `render --json` e a fila
 * continua. Jobs que não começaram por causa do cancelamento entram no relatório como `E_CANCELED`.
 */
export async function runBatch(options: RunBatchOptions): Promise<BatchReport> {
  const { jobs, signal } = options;
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new BatchError(`concurrency inválido: ${concurrency}`, "use um inteiro maior ou igual a 1");
  }
  const render = options.render ?? renderComposition;
  const workers = options.workers ?? workersPerJob(Math.min(concurrency, jobs.length));
  const started = Date.now();
  const reports: Array<BatchJobReport | undefined> = jobs.map(() => undefined);

  const runOne = async (job: BatchJob): Promise<BatchJobReport> => {
    const jobStarted = Date.now();
    try {
      const result = await render({
        entry: job.entry,
        outPath: job.out,
        ...(options.common ?? {}),
        ...(job.vars !== undefined ? { vars: job.vars } : {}),
        ...(job.preset !== undefined ? { preset: job.preset } : {}),
        ...(job.codec !== undefined ? { codec: job.codec } : {}),
        ...(job.gpu !== undefined ? { gpu: job.gpu } : {}),
        ...(job.loudness === false ? { loudness: false as const } : {}),
        ...(workers !== undefined ? { workers } : {}),
        ...(signal !== undefined ? { signal } : {}),
        ...(options.onProgress !== undefined
          ? { onProgress: (stage: RenderStage, percent: number, message?: string) => options.onProgress!(job.id, stage, percent, message) }
          : {}),
      });
      return {
        id: job.id,
        entry: job.entry,
        out: job.out,
        ok: true,
        elapsedMs: Date.now() - jobStarted,
        frames: result.frames,
        durationSeconds: result.durationSeconds,
        warnings: result.warnings,
      };
    } catch (error) {
      return { id: job.id, entry: job.entry, out: job.out, ok: false, elapsedMs: Date.now() - jobStarted, error: toErrorPayload(error) };
    }
  };

  let next = 0;
  const lane = async (): Promise<void> => {
    while (signal?.aborted !== true) {
      const index = next++;
      if (index >= jobs.length) return;
      const report = await runOne(jobs[index]!);
      reports[index] = report;
      options.onJob?.(report);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, lane));

  const finished = jobs.map((job, index): BatchJobReport => {
    const report = reports[index];
    if (report !== undefined) return report;
    const skipped: BatchJobReport = { id: job.id, entry: job.entry, out: job.out, ok: false, elapsedMs: 0, error: canceledError() };
    options.onJob?.(skipped);
    return skipped;
  });
  const succeeded = finished.filter((report) => report.ok).length;
  return {
    ok: succeeded === finished.length,
    total: finished.length,
    succeeded,
    failed: finished.length - succeeded,
    elapsedMs: Date.now() - started,
    jobs: finished,
  };
}
