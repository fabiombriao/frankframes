// FrankFrames — proprietário. Ver LICENSE na raiz.
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cleanupWarning, removeOrWarn, removeTree } from "@frankframes/engine";
import { RenderError, inspectFrames, renderComposition, resolveFfmpeg } from "@frankframes/producer";
import type { FramesReport, RenderOptions, RenderResult } from "@frankframes/producer";
import { buildContextDir, buildPrompt, checkGeneratedHtml, validateRequest, writeRepairFiles } from "./generate-context.ts";
import type { OutputFormat, ProjectInput } from "./generate-context.ts";
import type { GenerationAgent } from "./generate-codex.ts";
import { GenerateError } from "./generate-errors.ts";
import type { GenerateDiagnostic } from "./generate-errors.ts";
import { lintReport } from "./lint-report.ts";

export interface AttemptRecord {
  n: number;
  ms: number;
  ok: boolean;
  diagnostics: GenerateDiagnostic[];
}

export interface GenerateReport {
  ok: true;
  request: string;
  format: { width: number; height: number; fps: number };
  agent: { name: string; version: string };
  attempts: AttemptRecord[];
  entry: string;
  render: { outPath: string; frames: number; durationSeconds: number } | null;
  frames: Array<{ t: number; uniform: boolean; meanLuma: number; png: string }>;
  /** Avisos que não impediram a entrega (ex.: frame chapado que persistiu). */
  warnings: GenerateDiagnostic[];
  /** Pasta de contexto, só com `--keep-context`. */
  contextDir?: string;
  /** URL do Studio, preenchida pelo comando depois de subir o servidor. */
  studio?: string;
}

export type GenerateEvent =
  | { kind: "check"; agent: string; version: string }
  | { kind: "attempt-start"; n: number; total: number; repair: boolean }
  | { kind: "attempt-end"; n: number; ms: number; ok: boolean; diagnostics: GenerateDiagnostic[] }
  | { kind: "render"; n: number };

export interface GenerateOptions {
  request: string;
  outDir: string;
  format: OutputFormat;
  durationSeconds?: number;
  attempts: number;
  timeoutMs: number;
  render: boolean;
  project?: ProjectInput;
  force: boolean;
  keepContext: boolean;
  agent: GenerationAgent;
  renderImpl?: (options: RenderOptions) => Promise<RenderResult>;
  /** Confere os frames do rascunho; o padrão usa o FFmpeg resolvido (`inspectFrames`). */
  inspectImpl?: (input: string, outDir: string, at: string) => Promise<FramesReport>;
  onEvent?: (event: GenerateEvent) => void;
  signal?: AbortSignal;
}

const FRAME_INSTANTS = "10%,50%,90%";

interface AgentReply {
  html: string;
  blocks: string[];
  notes: string;
}

/** Lê a resposta do agente; qualquer desvio do schema vira diagnóstico `E_CODEX_OUTPUT` (conta como tentativa). */
function parseReply(raw: string): { reply: AgentReply } | { diagnostic: GenerateDiagnostic } {
  const bad = (message: string): { diagnostic: GenerateDiagnostic } => ({
    diagnostic: { code: "E_CODEX_OUTPUT", severity: "error", message, hint: 'devolva só o JSON {"html","blocks","notes"}, sem texto fora dele' },
  });
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return bad(`a resposta não é JSON: ${(error as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("a resposta não é um objeto JSON");
  const record = value as Record<string, unknown>;
  if (typeof record["html"] !== "string" || record["html"].trim() === "") return bad('o campo "html" falta ou está vazio');
  if (!Array.isArray(record["blocks"]) || record["blocks"].some((slug) => typeof slug !== "string")) return bad('o campo "blocks" precisa ser lista de textos');
  if (typeof record["notes"] !== "string") return bad('o campo "notes" precisa ser texto');
  return { reply: { html: record["html"], blocks: record["blocks"] as string[], notes: record["notes"] } };
}

const errors = (diagnostics: GenerateDiagnostic[]): GenerateDiagnostic[] => diagnostics.filter((d) => d.severity === "error");

function fromRenderError(error: RenderError): GenerateDiagnostic[] {
  const found: GenerateDiagnostic[] = error.diagnostics.map((d) => ({
    code: d.code,
    severity: d.severity,
    message: d.message,
    ...(d.hint !== undefined ? { hint: d.hint } : {}),
    ...(d.clipId !== undefined ? { clipId: d.clipId } : {}),
  }));
  found.push({ code: error.code, severity: "error", message: `o render falhou no estágio ${error.stage}: ${error.message}` });
  return found;
}

/** Grava `<out>/generate.json` (sucesso e falha usam o mesmo arquivo). */
export async function writeReport(outDir: string, report: unknown): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "generate.json"), `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * Pedido → HTML conferido → rascunho. Conversa só com `GenerationAgent`: o Codex de verdade ou um falso.
 * Cada tentativa é uma chamada nova; o reparo manda o HTML anterior e os diagnósticos pela pasta de contexto.
 */
export async function runGenerate(options: GenerateOptions): Promise<GenerateReport> {
  const request = validateRequest(options.request);
  const outDir = resolve(options.outDir);
  const entry = join(outDir, "index.html");
  const draft = join(outDir, "draft.mp4");
  if (existsSync(entry) && !options.force) {
    throw new GenerateError("E_GEN_OUT_EXISTS", `${entry} já existe`, "use --force para sobrescrever ou escolha outra pasta com -o");
  }
  const emit = options.onEvent ?? (() => {});
  const renderImpl = options.renderImpl ?? renderComposition;
  const inspectImpl =
    options.inspectImpl ??
    (async (input: string, outDir: string, at: string): Promise<FramesReport> => {
      const pair = await resolveFfmpeg();
      return inspectFrames({ ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe, input, at, outDir });
    });

  // Falha cedo e sem escrever nada: Codex ausente ou fora da conta ChatGPT.
  const { version } = await options.agent.check();
  emit({ kind: "check", agent: options.agent.name, version });

  const workDir = join(outDir, ".generate");
  await mkdir(workDir, { recursive: true });
  const context = await buildContextDir(options.project !== undefined ? { project: options.project } : {});
  const attempts: AttemptRecord[] = [];
  const formatInfo = { width: options.format.width, height: options.format.height, fps: options.format.fps };
  let wroteEntry = false;
  let contextReleased = false;
  // Apaga a pasta de contexto (criada por nós: sem force). Devolve a falha para quem decide virar aviso.
  const releaseContext = async (): Promise<Error | undefined> => {
    contextReleased = true;
    return options.keepContext ? undefined : await removeTree(context.dir);
  };

  const exhausted = async (failure: GenerateError): Promise<never> => {
    // Sem entrega: não deixa `index.html`/`draft.mp4` de uma tentativa que não passou.
    // force: index.html e draft.mp4 podem não existir (a tentativa pode ter falhado antes de gravar/renderizar); ENOENT é esperado.
    if (wroteEntry) {
      await rm(entry, { force: true });
      await rm(draft, { force: true });
    }
    await writeReport(outDir, { ok: false, request, format: formatInfo, agent: { name: options.agent.name, version }, attempts, code: failure.code, message: failure.message, hint: failure.hint });
    throw failure;
  };

  try {
    let repair: { previous?: string; diagnostics: GenerateDiagnostic[] } | undefined;
    let blankRepaired = false;

    for (let n = 1; n <= options.attempts; n++) {
      const started = performance.now();
      emit({ kind: "attempt-start", n, total: options.attempts, repair: repair !== undefined });
      await writeRepairFiles(context.dir, repair);
      const prompt = buildPrompt({
        request,
        format: options.format,
        ...(options.durationSeconds !== undefined ? { durationSeconds: options.durationSeconds } : {}),
        hasProject: options.project !== undefined,
        materials: context.materials,
        ...(repair !== undefined ? { repair: { ...(repair.previous !== undefined ? { previousHtml: repair.previous } : {}), diagnostics: repair.diagnostics } } : {}),
      });

      let diagnostics: GenerateDiagnostic[] = [];
      let html: string | undefined;
      let raw: string | undefined;
      try {
        raw = await options.agent.run({
          prompt,
          contextDir: context.dir,
          schemaPath: context.schemaPath,
          timeoutMs: options.timeoutMs,
          logPath: join(workDir, `attempt-${n}.log`),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
      } catch (error) {
        // Só a resposta ilegível é tentada de novo; falha do processo e tempo esgotado sobem como estão.
        if (!(error instanceof GenerateError && error.code === "E_CODEX_OUTPUT")) {
          await writeReport(outDir, { ok: false, request, format: formatInfo, agent: { name: options.agent.name, version }, attempts, code: error instanceof GenerateError ? error.code : "E_CODEX_FAILED", message: (error as Error).message });
          throw error;
        }
        diagnostics = [{ code: "E_CODEX_OUTPUT", severity: "error", message: error.message, hint: error.hint }];
      }

      if (raw !== undefined) {
        const parsed = parseReply(raw);
        if ("diagnostic" in parsed) diagnostics = [parsed.diagnostic];
        else html = parsed.reply.html;
      }

      let rendered: { result: RenderResult; report: FramesReport } | undefined;
      if (html !== undefined) {
        await writeFile(join(workDir, `attempt-${n}.html`), html);
        diagnostics = [...lintReport(html, join(workDir, `attempt-${n}.html`)).diagnostics, ...checkGeneratedHtml(html, options.format, options.durationSeconds)].map(
          (d): GenerateDiagnostic => ({
            code: d.code,
            severity: d.severity,
            message: d.message,
            ...(d.hint !== undefined ? { hint: d.hint } : {}),
            ...(d.clipId !== undefined ? { clipId: d.clipId } : {}),
          }),
        );
        if (errors(diagnostics).length === 0) {
          await writeFile(entry, html);
          wroteEntry = true;
          if (options.render) {
            emit({ kind: "render", n });
            try {
              const result = await renderImpl({ entry, outPath: draft, preset: "draft", ...(options.signal !== undefined ? { signal: options.signal } : {}) });
              const report = await inspectImpl(result.outPath, join(workDir, `frames-${n}`), FRAME_INSTANTS);
              rendered = { result, report };
            } catch (error) {
              if (!(error instanceof RenderError) || error.code === "E_CANCELED") throw error;
              diagnostics = [...diagnostics, ...fromRenderError(error)];
            }
          }
        }
      }

      // Frame chapado vale um reparo; se persistir, entrega com aviso.
      const blank = rendered?.report.frames.filter((f) => f.uniform) ?? [];
      const blankDiagnostics: GenerateDiagnostic[] = blank.map((f) => ({
        code: "W_GEN_FRAME_BLANK",
        severity: "warning",
        message: `o frame em ${f.t} s está chapado (nada na tela)`,
        hint: "confira se a cena tem clip ativo nesse instante, com contraste contra o fundo; clip que termina cedo deixa a cena vazia",
      }));
      const clean = html !== undefined && errors(diagnostics).length === 0;
      const delivered = clean && (rendered !== undefined || !options.render);
      const wantsBlankRepair = delivered && blankDiagnostics.length > 0 && !blankRepaired && n < options.attempts;
      const ms = Math.round(performance.now() - started);

      if (wantsBlankRepair) {
        blankRepaired = true;
        diagnostics = [...diagnostics, ...blankDiagnostics];
        attempts.push({ n, ms, ok: false, diagnostics });
        emit({ kind: "attempt-end", n, ms, ok: false, diagnostics });
        repair = { previous: html!, diagnostics };
        continue;
      }

      if (delivered) {
        // A pasta de contexto sai antes de gravar o relatório: se não sair, o aviso entra em `warnings` (e em generate.json).
        const leftover = await releaseContext();
        const cleanup: GenerateDiagnostic[] = leftover === undefined ? [] : [{ code: "W_GEN_CLEANUP", severity: "warning", message: cleanupWarning(context.dir, leftover), hint: "apague a pasta à mão" }];
        diagnostics = [...diagnostics, ...blankDiagnostics];
        attempts.push({ n, ms, ok: true, diagnostics });
        emit({ kind: "attempt-end", n, ms, ok: true, diagnostics });
        const report: GenerateReport = {
          ok: true,
          request,
          format: formatInfo,
          agent: { name: options.agent.name, version },
          attempts,
          entry,
          render: rendered !== undefined ? { outPath: rendered.result.outPath, frames: rendered.result.frames, durationSeconds: rendered.result.durationSeconds } : null,
          frames: rendered?.report.frames.map((f) => ({ t: f.t, uniform: f.uniform, meanLuma: f.meanLuma, png: f.png })) ?? [],
          warnings: [...blankDiagnostics, ...cleanup],
          ...(options.keepContext ? { contextDir: context.dir } : {}),
        };
        await writeReport(outDir, report);
        return report;
      }

      attempts.push({ n, ms, ok: false, diagnostics });
      emit({ kind: "attempt-end", n, ms, ok: false, diagnostics });
      // Sem HTML aproveitável o reparo parte do último HTML que existiu, se houver; os diagnósticos vão sempre.
      const previous = html ?? repair?.previous;
      repair = { ...(previous !== undefined ? { previous } : {}), diagnostics };
    }

    const last = attempts.at(-1);
    return await exhausted(
      new GenerateError(
        "E_GEN_EXHAUSTED",
        `${options.attempts} tentativa(s) sem um vídeo válido; último diagnóstico: ${last?.diagnostics[0]?.code ?? "?"} — ${last?.diagnostics[0]?.message ?? ""}`,
        `veja ${join(workDir, `attempt-${options.attempts}.html`)} e os diagnósticos em ${join(outDir, "generate.json")}; corrija com \`frankframes lint\` ou rode de novo com --attempts`,
        attempts,
      ),
    );
  } finally {
    // Falha/esgotamento: a remoção que falhar vai para o stderr e o erro original sobe intacto.
    if (!contextReleased && !options.keepContext) await removeOrWarn(context.dir);
  }
}
