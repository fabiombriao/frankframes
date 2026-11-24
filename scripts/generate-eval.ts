// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Aceite do `frankframes generate`: roda os pedidos de `skills/frankframes-generate/evals/pedidos.json` no Codex REAL
 * (conta ChatGPT do titular) e confere cada resultado. Nunca roda no gate: sem `--real` sai com 2.
 *
 *   node scripts/generate-eval.ts --real [--only <id>]
 *
 * Grava `out/generate-eval/<id>/` e `out/generate-eval/report.json`. Com `--only`, o relatório mantém os outros
 * pedidos como estavam e o código de saída vale só para os que rodaram agora. Nenhuma edição manual: o `index.html`
 * entregue tem de ser byte a byte o da última tentativa.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveFfmpeg } from "@frankframes/producer";
import { codexAgent } from "../packages/cli/src/generate-codex.ts";
import { GenerateError } from "../packages/cli/src/generate-errors.ts";
import { outputFormat } from "../packages/cli/src/generate-context.ts";
import type { FormatName } from "../packages/cli/src/generate-context.ts";
import { runGenerate } from "../packages/cli/src/generate.ts";
import type { AttemptRecord, GenerateReport } from "../packages/cli/src/generate.ts";
import { lintReport } from "../packages/cli/src/lint-report.ts";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PEDIDOS = join(ROOT, "skills", "frankframes-generate", "evals", "pedidos.json");
const OUT = join(ROOT, "out", "generate-eval");
const DURATION_TOLERANCE_SECONDS = 0.5;
const ATTEMPTS = 3;
const TIMEOUT_MS = 600_000;

export const NEEDS_REAL = "este script chama o Codex real; passe --real";

export interface Pedido {
  id: string;
  pedido: string;
  format: FormatName;
  durationSeconds: number;
}

export interface EvalInput {
  expected: { width: number; height: number; fps: number; durationSeconds: number };
  /** `runGenerate` terminou sem erro. */
  generateOk: boolean;
  /** `index.html` entregue é idêntico ao da última tentativa (ninguém editou à mão). */
  entryMatchesLastAttempt: boolean;
  mp4: { exists: boolean; width?: number; height?: number; durationSeconds?: number };
  /** Duração que o lint tira do HTML (autoral ou derivada); `null` se não resolveu. */
  lintDurationSeconds: number | null;
  /** Frames de 10%, 50% e 90% do MP4. */
  frames: Array<{ t: number; uniform: boolean }>;
}

export interface EvalCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface EvalVerdict {
  pass: boolean;
  checks: EvalCheck[];
}

/** Critério de aceite de um pedido. Puro: recebe as medidas e diz o que passou e o que não. */
export function evaluateCriteria(input: EvalInput): EvalVerdict {
  const { expected, mp4 } = input;
  const frameSeconds = 1 / expected.fps;
  const checks: EvalCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  add("generate", input.generateOk, input.generateOk ? "ok" : "o generate falhou");
  add("mp4", mp4.exists, mp4.exists ? "existe" : "draft.mp4 ausente");

  const mp4Duration = mp4.durationSeconds;
  if (input.lintDurationSeconds === null) add("duracao-lint", false, "o lint não resolveu a duração do HTML");
  else if (mp4Duration === undefined) add("duracao-lint", false, "sem duração do MP4 para comparar");
  else {
    const diff = Math.abs(mp4Duration - input.lintDurationSeconds);
    add("duracao-lint", diff <= frameSeconds + 1e-9, `ffprobe ${mp4Duration.toFixed(3)} s, lint ${input.lintDurationSeconds} s (tolerância 1 frame)`);
  }

  const sizeOk = mp4.width === expected.width && mp4.height === expected.height;
  add("formato", sizeOk, `${mp4.width ?? "?"}x${mp4.height ?? "?"}, esperado ${expected.width}x${expected.height}`);

  if (mp4Duration === undefined) add("duracao-pedida", false, "sem duração do MP4");
  else {
    const diff = Math.abs(mp4Duration - expected.durationSeconds);
    add("duracao-pedida", diff <= DURATION_TOLERANCE_SECONDS + 1e-9, `${mp4Duration.toFixed(3)} s, pedido ${expected.durationSeconds} s (± ${DURATION_TOLERANCE_SECONDS} s)`);
  }

  const uniform = input.frames.filter((f) => f.uniform).map((f) => f.t);
  add("frames", input.frames.length === 3 && uniform.length === 0, input.frames.length !== 3 ? `${input.frames.length} frames conferidos, esperado 3` : uniform.length > 0 ? `frame chapado em ${uniform.join(", ")} s` : "3 frames com conteúdo");

  add("sem-edicao-manual", input.entryMatchesLastAttempt, input.entryMatchesLastAttempt ? "index.html = última tentativa" : "index.html difere da última tentativa");

  return { pass: checks.every((c) => c.ok), checks };
}

export interface PedidoResult {
  id: string;
  pedido: string;
  format: FormatName;
  durationSeconds: number;
  pass: boolean;
  /** Código `E_*` quando o `runGenerate` falhou. */
  error?: { code: string; message: string };
  attempts: AttemptRecord[];
  totalMs: number;
  checks: EvalCheck[];
  outDir: string;
}

interface Probe {
  width: number;
  height: number;
  durationSeconds: number;
}

async function probeVideo(ffprobe: string, file: string): Promise<Probe> {
  const { stdout } = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file], { encoding: "utf8" });
  const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
  const stream = parsed.streams?.[0];
  const duration = Number(parsed.format?.duration);
  if (stream?.width === undefined || stream.height === undefined || !Number.isFinite(duration)) throw new Error(`ffprobe sem largura, altura ou duração em ${file}`);
  return { width: stream.width, height: stream.height, durationSeconds: duration };
}

async function evaluatePedido(pedido: Pedido): Promise<PedidoResult> {
  const outDir = join(OUT, pedido.id);
  const format = outputFormat(pedido.format);
  const started = Date.now();
  let report: GenerateReport | undefined;
  let error: PedidoResult["error"];
  let attempts: AttemptRecord[] = [];
  process.stderr.write(`\n== ${pedido.id}: ${pedido.pedido}\n`);
  try {
    report = await runGenerate({
      request: pedido.pedido,
      outDir,
      format,
      durationSeconds: pedido.durationSeconds,
      attempts: ATTEMPTS,
      timeoutMs: TIMEOUT_MS,
      render: true,
      force: true,
      keepContext: false,
      agent: codexAgent(),
      onEvent: (event) => {
        if (event.kind === "attempt-start") process.stderr.write(`  tentativa ${event.n}/${event.total}${event.repair ? " (correção)" : ""}…\n`);
        if (event.kind === "attempt-end") process.stderr.write(`  tentativa ${event.n}: ${(event.ms / 1000).toFixed(1)} s · ${event.ok ? "ok" : `reprovada (${event.diagnostics.map((d) => d.code).join(", ")})`}\n`);
      },
    });
    attempts = report.attempts;
  } catch (caught) {
    if (caught instanceof GenerateError) {
      error = { code: caught.code, message: caught.message };
      attempts = (caught.attempts as AttemptRecord[] | undefined) ?? [];
    } else {
      error = { code: "E_EVAL_UNEXPECTED", message: (caught as Error).message };
    }
  }

  const mp4Path = join(outDir, "draft.mp4");
  const entry = join(outDir, "index.html");
  const pair = await resolveFfmpeg();
  const mp4Exists = existsSync(mp4Path);
  const mp4 = mp4Exists ? await probeVideo(pair.ffprobe, mp4Path) : undefined;

  let lintDuration: number | null = null;
  let entryMatches = false;
  if (existsSync(entry)) {
    const html = await readFile(entry, "utf8");
    const duration = lintReport(html, entry).duration;
    lintDuration = duration.kind === "authored" || duration.kind === "derived" ? duration.seconds : null;
    const last = join(outDir, ".generate", `attempt-${attempts.length}.html`);
    entryMatches = existsSync(last) && (await readFile(last, "utf8")) === html;
  }

  const verdict = evaluateCriteria({
    expected: { width: format.width, height: format.height, fps: format.fps, durationSeconds: pedido.durationSeconds },
    generateOk: report !== undefined,
    entryMatchesLastAttempt: entryMatches,
    mp4: { exists: mp4Exists, ...(mp4 ?? {}) },
    lintDurationSeconds: lintDuration,
    frames: (report?.frames ?? []).map((f) => ({ t: f.t, uniform: f.uniform })),
  });
  const result: PedidoResult = {
    id: pedido.id,
    pedido: pedido.pedido,
    format: pedido.format,
    durationSeconds: pedido.durationSeconds,
    pass: verdict.pass,
    ...(error !== undefined ? { error } : {}),
    attempts,
    totalMs: Date.now() - started,
    checks: verdict.checks,
    outDir,
  };
  process.stderr.write(`  ${result.pass ? "PASSOU" : "FALHOU"} · ${(result.totalMs / 1000).toFixed(1)} s${error !== undefined ? ` · ${error.code}` : ""}\n`);
  for (const check of verdict.checks.filter((c) => !c.ok)) process.stderr.write(`    ✗ ${check.name}: ${check.detail}\n`);
  return result;
}

export interface EvalReport {
  codex: string;
  at: string;
  results: PedidoResult[];
}

/** Lê o relatório anterior para que `--only` atualize só o pedido que rodou. */
async function loadPreviousResults(file: string): Promise<PedidoResult[]> {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<EvalReport>;
  return Array.isArray(parsed.results) ? parsed.results : [];
}

export async function main(argv: string[]): Promise<number> {
  if (!argv.includes("--real")) {
    process.stderr.write(`${NEEDS_REAL}\n`);
    return 2;
  }
  const onlyIndex = argv.indexOf("--only");
  const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : undefined;
  if (onlyIndex >= 0 && (only === undefined || only.startsWith("--"))) {
    process.stderr.write("--only precisa de um id de pedido\n");
    return 2;
  }
  const pedidos = JSON.parse(await readFile(PEDIDOS, "utf8")) as Pedido[];
  const selected = only === undefined ? pedidos : pedidos.filter((p) => p.id === only);
  if (selected.length === 0) {
    process.stderr.write(`nenhum pedido com id "${only}"; ids: ${pedidos.map((p) => p.id).join(", ")}\n`);
    return 2;
  }

  const version = (await codexAgent().check()).version;
  await mkdir(OUT, { recursive: true });
  const results: PedidoResult[] = [];
  for (const pedido of selected) results.push(await evaluatePedido(pedido));

  const reportFile = resolve(OUT, "report.json");
  const kept = (await loadPreviousResults(reportFile)).filter((r) => !results.some((n) => n.id === r.id));
  const merged = [...kept, ...results].sort((a, b) => pedidos.findIndex((p) => p.id === a.id) - pedidos.findIndex((p) => p.id === b.id));
  const report: EvalReport = { codex: version, at: new Date().toISOString(), results: merged };
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);

  const passed = results.filter((r) => r.pass).length;
  process.stderr.write(`\nplacar: ${passed}/${results.length} · ${version} · ${reportFile}\n`);
  return passed === results.length ? 0 : 1;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("generate-eval.ts")) {
  process.exitCode = await main(process.argv.slice(2));
}
