// FrankFrames — proprietário. Ver LICENSE na raiz.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { loadComposition } from "@frankframes/contract";
import { EncodePolicyError, containerFor } from "@frankframes/encode";
import type { Preset, VideoCodec } from "@frankframes/encode";
import { renderComposition, resolveFfmpeg, toErrorPayload } from "@frankframes/producer";
import type { ErrorPayload, FfmpegPair, RenderOptions, RenderResult, RenderStage } from "@frankframes/producer";
import { defaultOutput, guardEncoder } from "./render-guard.ts";

export const EXPORT_PRESETS: readonly Preset[] = ["draft", "standard", "high"];
const ALL_CODECS: readonly VideoCodec[] = ["av1", "vp9", "h264"];

export type ExportStatus = "running" | "done" | "failed" | "canceled";

/** Estado do export que vai para o navegador (`GET /api/export` e `event: export`). */
export interface ExportJob {
  id: string;
  status: ExportStatus;
  stage: RenderStage | null;
  percent: number;
  message: string | null;
  /** Caminho absoluto do arquivo final. */
  output: string;
  preset: Preset;
  codec: VideoCodec;
  warnings: string[];
  /** Só em `failed`: o mesmo payload de `render --json` (caminhos já sanitizados). */
  error: ErrorPayload | null;
  /** Só em `done`. */
  result: { frames: number; durationSeconds: number; hasAudio: boolean } | null;
}

/** Erro com status HTTP e código estável; o servidor o converte em resposta. */
export class ExportError extends Error {
  readonly status: number;
  readonly code: string;
  readonly diagnostics?: unknown;

  constructor(status: number, code: string, message: string, diagnostics?: unknown) {
    super(message);
    this.name = "ExportError";
    this.status = status;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface ExportRequest {
  preset?: unknown;
  codec?: unknown;
  output?: unknown;
  overwrite?: unknown;
}

export interface ExportDefaults {
  /** Relativo à pasta da entrada quando cai dentro dela; senão absoluto. */
  output: string;
  codecs: VideoCodec[];
  presets: Preset[];
}

export interface ExporterOptions {
  entry: string;
  /** Padrão: o pipeline real. Injetável para testar sem Chrome nem FFmpeg. */
  render?: (options: RenderOptions) => Promise<RenderResult>;
  /** Padrão: abre o gerenciador de arquivos do sistema com o arquivo selecionado. */
  reveal?: (file: string) => Promise<void>;
  /** Padrão: a guarda de licença que o `frankframes render` usa. */
  guard?: (options: { pair: FfmpegPair; codec: VideoCodec; onWarning?: (warning: string) => void }) => Promise<void>;
  resolveFfmpeg?: () => Promise<FfmpegPair>;
  onEvent?: (job: ExportJob) => void;
}

export interface Exporter {
  job: () => ExportJob | null;
  defaults: () => ExportDefaults;
  start: (request: ExportRequest) => Promise<{ id: string; output: string }>;
  /** Aborta o export em andamento e espera a limpeza (FFmpeg, Chrome, temporários). */
  cancel: () => Promise<void>;
  reveal: () => Promise<void>;
  /** Resolve quando não há export rodando. */
  idle: () => Promise<void>;
  /** Aborta o export em andamento (fechar o Studio). */
  close: () => Promise<void>;
}

/**
 * Mostra o arquivo no gerenciador do sistema. `spawn` com argumentos em array e sem shell: o caminho vem do
 * usuário. O `explorer.exe /select` sai com código 1 mesmo quando funciona, então no Windows o código de
 * saída não diz nada; só a falha de lançar (ENOENT) é erro.
 */
export async function openFolder(file: string): Promise<void> {
  const [command, args]: [string, string[]] =
    process.platform === "win32"
      ? ["explorer.exe", ["/select,", file]]
      : process.platform === "darwin"
        ? ["open", ["-R", file]]
        : ["xdg-open", [dirname(file)]];
  const done = Promise.withResolvers<void>();
  const child = spawn(command, args, { stdio: "ignore", shell: false });
  child.once("error", (error) => {
    done.reject(new ExportError(500, "E_REVEAL_FAILED", `não foi possível abrir a pasta (${command}): ${error.message}`));
  });
  if (process.platform === "win32") child.once("spawn", () => done.resolve());
  else
    child.once("close", (code) => {
      if (code === 0) done.resolve();
      else done.reject(new ExportError(500, "E_REVEAL_FAILED", `${command} saiu com código ${String(code)}`));
    });
  await done.promise;
}

function fail(code: string, message: string, diagnostics?: unknown): never {
  throw new ExportError(400, code, message, diagnostics);
}

export function createExporter(options: ExporterOptions): Exporter {
  const entry = resolve(options.entry);
  const entryDir = dirname(entry);
  const render = options.render ?? renderComposition;
  const reveal = options.reveal ?? openFolder;
  const guard = options.guard ?? guardEncoder;
  const ffmpegPair = options.resolveFfmpeg ?? resolveFfmpeg;
  const emit = options.onEvent ?? (() => {});

  let current: ExportJob | null = null;
  let controller: AbortController | undefined;
  let finished: Promise<void> = Promise.resolve();

  const publish = (patch: Partial<ExportJob>): void => {
    if (current === null) return;
    current = { ...current, ...patch };
    emit(current);
  };

  const codecs = (): VideoCodec[] => ALL_CODECS.filter((codec) => codec !== "h264" || process.env.FRANKFRAMES_ALLOW_H264 === "1");

  const defaults = (): ExportDefaults => {
    const absolute = defaultOutput(entry, "av1");
    const inside = relative(entryDir, absolute);
    return {
      output: inside.startsWith("..") || isAbsolute(inside) ? absolute : inside,
      codecs: codecs(),
      presets: [...EXPORT_PRESETS],
    };
  };

  /** `start` valida com várias esperas; a reserva impede que dois pedidos simultâneos passem juntos. */
  let reserved = false;

  const start = async (request: ExportRequest): Promise<{ id: string; output: string }> => {
    if (reserved || current?.status === "running") throw new ExportError(409, "E_EXPORT_BUSY", "já existe um export em andamento");
    reserved = true;
    try {
      return await begin(request);
    } finally {
      reserved = false;
    }
  };

  const begin = async (request: ExportRequest): Promise<{ id: string; output: string }> => {
    const preset = request.preset;
    if (typeof preset !== "string" || !EXPORT_PRESETS.includes(preset as Preset)) {
      fail("E_BODY_INVALID", `"preset" precisa ser ${EXPORT_PRESETS.join(", ")}`);
    }
    const codec = request.codec ?? "av1";
    if (typeof codec !== "string" || !ALL_CODECS.includes(codec as VideoCodec)) {
      fail("E_BODY_INVALID", `"codec" precisa ser ${ALL_CODECS.join(", ")}`);
    }
    if (request.overwrite !== undefined && typeof request.overwrite !== "boolean") {
      fail("E_BODY_INVALID", '"overwrite" precisa ser booleano');
    }
    const container = containerFor(codec as VideoCodec);
    const requested = request.output;
    if (typeof requested !== "string" || requested.trim() === "") {
      fail("E_EXPORT_OUTPUT_INVALID", 'informe o destino do arquivo em "output" (use .mp4 para av1/h264, .webm para vp9)');
    }
    const output = isAbsolute(requested.trim()) ? resolve(requested.trim()) : resolve(entryDir, requested.trim());
    if (extname(output).toLowerCase() !== `.${container}`) {
      fail("E_EXPORT_OUTPUT_INVALID", `o destino de ${codec} precisa terminar em .${container} (use .mp4 para av1/h264, .webm para vp9)`);
    }
    if (output === entry) fail("E_EXPORT_OUTPUT_INVALID", "o destino não pode ser o próprio arquivo da composição");

    // O que está em disco agora: edição pendente no navegador não conta (o botão já bloqueia isso).
    const source = await readFile(entry, "utf8");
    const composition = loadComposition(source);
    if (!composition.ok) {
      throw new ExportError(
        400,
        "E_CONTRACT_INVALID",
        "o contrato da composição está inválido; corrija antes de exportar",
        composition.diagnostics,
      );
    }

    const pair = await ffmpegPair();
    // Avisos do FFmpeg e da licença que o CLI imprime no stderr aparecem aqui no job.
    const startWarnings: string[] = [...pair.warnings];
    try {
      await guard({ pair, codec: codec as VideoCodec, onWarning: (warning) => startWarnings.push(`licença: ${warning}`) });
    } catch (error) {
      if (error instanceof EncodePolicyError) throw new ExportError(400, error.code, error.message);
      throw error;
    }

    const existing = await stat(output).then(
      (info) => info,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (existing !== undefined && !existing.isFile()) fail("E_EXPORT_OUTPUT_INVALID", `${basename(output)} existe e não é um arquivo`);
    if (existing !== undefined && request.overwrite !== true) {
      throw new ExportError(409, "E_EXPORT_EXISTS", `${basename(output)} já existe`);
    }

    const abort = new AbortController();
    controller = abort;
    const id = randomUUID();
    current = {
      id,
      status: "running",
      stage: null,
      percent: 0,
      message: null,
      output,
      preset: preset as Preset,
      codec: codec as VideoCodec,
      warnings: startWarnings,
      error: null,
      result: null,
    };
    emit(current);

    finished = (async () => {
      try {
        const result = await render({
          entry,
          outPath: output,
          ffmpeg: pair.ffmpeg,
          ffprobe: pair.ffprobe,
          codec: codec as VideoCodec,
          preset: preset as Preset,
          signal: abort.signal,
          onProgress: (stage, percent, message) => {
            if (current?.id !== id) return;
            publish({ stage, percent, message: message ?? null });
          },
        });
        publish({
          status: "done",
          stage: "assemble",
          percent: 100,
          message: null,
          warnings: [...startWarnings, ...result.warnings],
          result: { frames: result.frames, durationSeconds: result.durationSeconds, hasAudio: result.hasAudio },
        });
      } catch (error) {
        // O pipeline converte qualquer falha posterior ao abort em E_CANCELED; aqui basta o sinal.
        if (abort.signal.aborted) publish({ status: "canceled", message: "export cancelado" });
        else publish({ status: "failed", error: toErrorPayload(error) });
      }
    })();
    return { id, output };
  };

  const cancel = async (): Promise<void> => {
    if (current?.status !== "running" || controller === undefined) {
      throw new ExportError(409, "E_EXPORT_IDLE", "não há export em andamento");
    }
    controller.abort();
    await finished;
  };

  const revealOutput = async (): Promise<void> => {
    if (current?.status !== "done") throw new ExportError(409, "E_EXPORT_NOT_DONE", "o export ainda não terminou");
    await reveal(current.output);
  };

  return {
    job: () => current,
    defaults,
    start,
    cancel,
    reveal: revealOutput,
    idle: () => finished,
    close: async () => {
      if (current?.status === "running") controller?.abort();
      await finished;
    },
  };
}
