// FrankFrames — proprietário. Ver LICENSE na raiz.
import { resolve } from "node:path";
import { codexAgent } from "./generate-codex.ts";
import type { GenerationAgent } from "./generate-codex.ts";
import { isFormatName, outputFormat } from "./generate-context.ts";
import type { FormatName } from "./generate-context.ts";
import { GenerateError } from "./generate-errors.ts";
import { runGenerate, writeReport } from "./generate.ts";
import type { GenerateEvent, GenerateOptions, GenerateReport } from "./generate.ts";
import { openBrowser } from "./open-browser.ts";
import { startStudio } from "./studio-server.ts";

const USAGE =
  'uso: frankframes generate "<pedido>" [-o <pasta>] [--format 16:9|9:16|1:1] [--duration S] [--attempts N] [--model M] [--timeout S]\n' +
  "                          [--project <pasta>] [--no-render] [--no-studio] [--force] [--keep-context] [--json]";

export const DEFAULT_ATTEMPTS = 3;
export const MAX_ATTEMPTS = 6;
export const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_DURATION_SECONDS = 600;

export interface GenerateArgs {
  request: string;
  out: string;
  format: FormatName;
  duration: number | undefined;
  attempts: number;
  model: string | undefined;
  timeoutSeconds: number;
  project: string | undefined;
  render: boolean;
  studio: boolean;
  force: boolean;
  keepContext: boolean;
  json: boolean;
}

/** `Pedido de 6 s!` → `pedido-de-6-s` (sem acento, só letras e dígitos, até 40 caracteres). */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug === "" ? "video" : slug;
}

function positiveNumber(flag: string, value: string, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max) throw new Error(`${flag} precisa ser um número entre 0 e ${max} (recebi "${value}")\n${USAGE}`);
  return number;
}

/** Parser próprio (como o do `frames`): o pedido é um argumento só, entre aspas. Lança `Error` com a linha de uso. */
export function parseGenerateArgs(argv: string[]): GenerateArgs {
  let request: string | undefined;
  let out: string | undefined;
  let format: FormatName = "16:9";
  let duration: number | undefined;
  let attempts = DEFAULT_ATTEMPTS;
  let model: string | undefined;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  let project: string | undefined;
  const flags = { render: true, studio: true, force: false, keepContext: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--no-render") flags.render = false;
    else if (arg === "--no-studio") flags.studio = false;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--keep-context") flags.keepContext = true;
    else if (arg === "--json") flags.json = true;
    else if (["-o", "--out", "--format", "--duration", "--attempts", "--model", "--timeout", "--project"].includes(arg)) {
      const value = argv[++i];
      if (value === undefined || value === "") throw new Error(`${arg} precisa de um valor\n${USAGE}`);
      if (arg === "-o" || arg === "--out") out = value;
      else if (arg === "--format") {
        if (!isFormatName(value)) throw new Error(`--format aceita 16:9, 9:16 ou 1:1 (recebi "${value}")\n${USAGE}`);
        format = value;
      } else if (arg === "--duration") duration = positiveNumber(arg, value, MAX_DURATION_SECONDS);
      else if (arg === "--attempts") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > MAX_ATTEMPTS) throw new Error(`--attempts vai de 1 a ${MAX_ATTEMPTS} (recebi "${value}")\n${USAGE}`);
        attempts = n;
      } else if (arg === "--model") model = value;
      else if (arg === "--timeout") timeoutSeconds = positiveNumber(arg, value, 3600);
      else project = value;
    } else if (arg.startsWith("-")) throw new Error(`opção desconhecida: ${arg}\n${USAGE}`);
    else if (request === undefined) request = arg;
    else throw new Error(`o pedido é um argumento só, entre aspas (recebi também "${arg}")\n${USAGE}`);
  }
  if (request === undefined) throw new Error(`falta o pedido\n${USAGE}`);
  return { request, out: out ?? `out/gerado-${slugify(request)}`, format, duration, attempts, model, timeoutSeconds, project, ...flags };
}

function describe(event: GenerateEvent): string | undefined {
  switch (event.kind) {
    case "check":
      return `${event.agent}: ${event.version}`;
    case "attempt-start":
      return `tentativa ${event.n}/${event.total}${event.repair ? " (correção)" : ""}…`;
    case "render":
      return `  render do rascunho (tentativa ${event.n})…`;
    case "attempt-end": {
      const errorCount = event.diagnostics.filter((d) => d.severity === "error").length;
      const codes = [...new Set(event.diagnostics.map((d) => d.code))].join(", ");
      return `  ${(event.ms / 1000).toFixed(1)} s · ${event.ok ? "ok" : `${errorCount} erro(s)`}${codes !== "" ? ` · ${codes}` : ""}`;
    }
  }
}

export interface GenerateCommandHooks {
  /** Agente no lugar do Codex (testes em processo). */
  agent?: GenerationAgent;
  renderImpl?: GenerateOptions["renderImpl"];
  inspectImpl?: GenerateOptions["inspectImpl"];
}

/** `frankframes generate`: pedido em texto → vídeo, via Codex CLI. Devolve o código de saída. */
export async function runGenerateCommand(argv: string[], hooks: GenerateCommandHooks = {}): Promise<number> {
  let args: GenerateArgs;
  try {
    args = parseGenerateArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  // Ctrl+C: o Codex em andamento morre com a árvore inteira (o `generate` lê o sinal pelo AbortController).
  const abort = new AbortController();
  const onInterrupt = (): void => abort.abort();
  process.once("SIGINT", onInterrupt);

  let report: GenerateReport;
  try {
    const agent = hooks.agent ?? codexAgent({ ...(args.model !== undefined ? { model: args.model } : {}) });
    const format = outputFormat(args.format);
    report = await runGenerate({
      request: args.request,
      outDir: args.out,
      format,
      ...(args.duration !== undefined ? { durationSeconds: args.duration } : {}),
      attempts: args.attempts,
      timeoutMs: Math.round(args.timeoutSeconds * 1000),
      render: args.render,
      ...(args.project !== undefined ? { project: { dir: resolve(args.project) } } : {}),
      force: args.force,
      keepContext: args.keepContext,
      agent,
      ...(hooks.renderImpl !== undefined ? { renderImpl: hooks.renderImpl } : {}),
      ...(hooks.inspectImpl !== undefined ? { inspectImpl: hooks.inspectImpl } : {}),
      onEvent: (event) => {
        const line = describe(event);
        if (line !== undefined) process.stderr.write(`${line}\n`);
      },
      signal: abort.signal,
    });
  } catch (error) {
    process.off("SIGINT", onInterrupt);
    if (error instanceof GenerateError) {
      process.stderr.write(`erro ${error.code}: ${error.message}\n  → ${error.hint}\n`);
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message, hint: error.hint, ...(error.attempts !== undefined ? { attempts: error.attempts } : {}) }, null, 2)}\n`);
      }
    } else {
      process.stderr.write(`erro: ${(error as Error).message}\n`);
    }
    return 1;
  }
  process.off("SIGINT", onInterrupt);

  const studioWanted = args.studio && report.render !== null;
  let server: Awaited<ReturnType<typeof startStudio>> | undefined;
  if (studioWanted) {
    try {
      server = await startStudio({ entry: report.entry });
    } catch (error) {
      process.stderr.write(`erro: o Studio não subiu: ${(error as Error).message}\n  → o vídeo está pronto em ${report.entry}; abra com \`frankframes studio ${report.entry}\`\n`);
      return 1;
    }
    report.studio = server.url;
    await writeReport(resolve(args.out), report);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`pronto: ${report.entry}\n`);
    if (report.render !== null) process.stdout.write(`rascunho: ${report.render.outPath} · ${report.render.durationSeconds} s · ${report.render.frames} frames\n`);
    process.stdout.write(`${report.attempts.length} tentativa(s) · relatório em ${resolve(args.out, "generate.json")}\n`);
    for (const warning of report.warnings) process.stdout.write(`aviso ${warning.code}: ${warning.message}\n`);
  }

  if (server === undefined) return 0;
  process.stdout.write(`studio ${server.url} · Ctrl+C encerra\n`);
  openBrowser(server.url);
  const stopped = Promise.withResolvers<void>();
  const stop = (): void => {
    server.close().then(stopped.resolve, stopped.reject);
  };
  process.once("SIGINT", stop);
  try {
    await stopped.promise;
  } finally {
    process.off("SIGINT", stop);
  }
  return 0;
}
