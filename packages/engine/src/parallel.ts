// FrankFrames — proprietário. Ver LICENSE na raiz.
import { availableParallelism, freemem } from "node:os";
import { openSession } from "./capture.ts";
import type { Session, SessionOptions, SessionTimeouts } from "./capture.ts";
import { withCleanupFailures } from "./failures.ts";
import type { ServerFailure } from "./server.ts";
import type { GpuMode, Viewport } from "./args.ts";

export interface ParallelCaptureOptions {
  url: string;
  viewport: Viewport;
  gpu: GpuMode;
  fps: { num: number; den: number };
  /** Pode vir em qualquer ordem e com repetidos. */
  frames: number[];
  /** Número de sessões simultâneas. */
  workers?: number;
  /** Frames por lote da fila (padrão `DEFAULT_BATCH_SIZE`). */
  batchSize?: number;
  transparent?: boolean;
  /** Consulta a página depois do seek. Em captura esparsa, false repete a última camada. */
  shouldCapture?: (frame: number, session: Session) => Promise<boolean>;
  /** Chamado no worker logo após cada captura, antes do próximo frame. Pode esperar (backpressure). */
  onFrame?: (frame: number, png: Buffer) => void | Promise<void>;
  /** Limites de espera de cada sessão (veja `SessionTimeouts`). */
  timeouts?: SessionTimeouts;
  /** Falhas do servidor da página (`StaticServer.failures`): entram na mensagem quando uma sessão falha. */
  serverFailures?: () => ServerFailure[];
  /** Abertura de cada sessão. Só existe para o teste atrasar ou derrubar uma abertura sem depender do relógio. */
  open?: (options: SessionOptions) => Promise<Session>;
}

/** Frames por lote da fila. Pequeno o bastante para o encode acompanhar a captura; grande o bastante para amortizar o seek. */
export const DEFAULT_BATCH_SIZE = 8;

/**
 * Deduplica, ordena e fatia em lotes contíguos de até `size` frames. Os workers pegam os lotes em ordem,
 * então os frames chegam ao encoder quase na ordem do vídeo e a reordenação precisa de pouco buffer.
 */
export function splitIntoBatches(frames: number[], size: number = DEFAULT_BATCH_SIZE): number[][] {
  const ordered = [...new Set(frames)].sort((a, b) => a - b);
  const step = Math.max(1, Math.floor(size));
  const batches: number[][] = [];
  for (let offset = 0; offset < ordered.length; offset += step) batches.push(ordered.slice(offset, offset + step));
  return batches;
}

/** Memória livre que o padrão conta por browser. */
const BYTES_PER_WORKER = 768 * 1024 * 1024;
/** Memória livre que o padrão deixa de fora, para o FFmpeg e o encode. */
const ENCODE_RESERVE_BYTES = 1024 * 1024 * 1024;

export interface WorkerPlan {
  workers: number;
  /** Quem decidiu o número: `cpu` (metade dos núcleos, teto 8) ou `memory` (a livre). */
  limitedBy: "cpu" | "memory";
  /** Presente quando a memória livre não comporta nem 1 worker mais a reserva. */
  warning?: string;
  /** Linha de log: quantos workers, por qual limite e com que medida. */
  summary: string;
}

/**
 * Workers padrão: metade dos núcleos, no máximo 8, e nunca mais do que a memória LIVRE comporta (768 MB por browser,
 * fora 1 GiB para o FFmpeg e o encode); nunca menos que 1. A memória total não serve: com os programas do usuário
 * abertos, 8 browsers numa máquina de 16 GB a esgotavam e o seek estourava o prazo (EDT-91). Medido: 6 workers cortam
 * quase metade do tempo de um render de 3 s em relação a 2.
 */
export function planWorkers(cpus = availableParallelism(), freeBytes = freemem()): WorkerPlan {
  const byCpu = Math.min(8, Math.max(1, Math.floor(cpus / 2)));
  const byMemory = Math.floor((freeBytes - ENCODE_RESERVE_BYTES) / BYTES_PER_WORKER);
  const workers = Math.max(1, Math.min(byCpu, byMemory));
  const limitedBy = byMemory < byCpu ? "memory" : "cpu";
  const freeMb = Math.floor(freeBytes / (1024 * 1024));
  return {
    workers,
    limitedBy,
    ...(byMemory < 1 ? { warning: `memória livre baixa (${freeMb} MB): render com 1 worker; feche programas se o seek estourar o prazo` } : {}),
    summary: `${workers} worker(s) de captura, limite de ${limitedBy === "cpu" ? "cpu" : "memória"} (${cpus} CPUs, ${freeMb} MB livres)`,
  };
}

/** Só o número de `planWorkers`. */
export function defaultWorkerCount(cpus = availableParallelism(), freeBytes = freemem()): number {
  return planWorkers(cpus, freeBytes).workers;
}

/** Quantos frames fora de ordem o `orderedFeeder` segura para esse número de workers e tamanho de lote. */
export function reorderWindow(workers: number, batchSize: number = DEFAULT_BATCH_SIZE): number {
  return Math.max(2 * batchSize, Math.max(1, Math.floor(workers)) * batchSize);
}

export interface OrderedFeeder<T> {
  /**
   * Entrega o item do índice `index` (0 a total-1, em qualquer ordem). Resolve quando o item entrou no buffer;
   * antes disso espera enquanto `index` estiver `maxBuffered` ou mais à frente do próximo a sair (backpressure).
   * Rejeita depois de qualquer falha, com repetido ou fora da faixa.
   */
  add(index: number, data: T): Promise<void>;
  /** Espera todos os `total` itens saírem em ordem. Rejeita se faltou algum (nenhum worker vai entregá-lo) ou se houve falha. */
  finish(): Promise<void>;
  /** Derruba o feeder: quem espera em `add`/`finish` recebe o erro e nada mais é empurrado. */
  fail(error: Error): void;
}

/**
 * Reordena itens que chegam fora de ordem e os empurra, um por vez e em ordem, para `push` (o pipe do FFmpeg).
 * O buffer é limitado: um worker que se adiantou mais que `maxBuffered` posições espera. Sem deadlock enquanto os
 * lotes forem pegos em ordem, porque o worker que carrega o próximo item a sair nunca fica bloqueado.
 */
export function orderedFeeder<T>(
  push: (index: number, data: T) => Promise<void>,
  total: number,
  options: { maxBuffered: number },
): OrderedFeeder<T> {
  const maxBuffered = Math.max(1, Math.floor(options.maxBuffered));
  const buffer = new Map<number, T>();
  let next = 0;
  let failure: Error | undefined;
  let pumping = false;
  let waiters: Array<() => void> = [];

  const wake = (): void => {
    const pending = waiters;
    waiters = [];
    for (const resume of pending) resume();
  };
  const sleep = (): Promise<void> => new Promise<void>((resume) => waiters.push(resume));

  const fail = (error: Error): void => {
    if (failure !== undefined) return;
    failure = error;
    buffer.clear();
    wake();
  };

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (failure === undefined && buffer.has(next)) {
        const data = buffer.get(next) as T;
        buffer.delete(next);
        // `next` só avança depois do push: o item em voo continua contando na janela.
        await push(next, data);
        next += 1;
        wake();
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      pumping = false;
    }
    wake();
  }

  return {
    async add(index, data) {
      if (!Number.isInteger(index) || index < 0 || index >= total) {
        throw new RangeError(`frame ${index} fora da faixa 0..${total - 1}`);
      }
      while (failure === undefined && index >= next + maxBuffered) await sleep();
      if (failure !== undefined) throw failure;
      if (index < next || buffer.has(index)) throw new Error(`frame ${index} entregue duas vezes`);
      buffer.set(index, data);
      void pump();
    },
    async finish() {
      while (failure === undefined && next < total) {
        if (!pumping && !buffer.has(next)) throw new Error(`faltou o frame ${next} de ${total}: nenhum worker o entregou`);
        await sleep();
      }
      if (failure !== undefined) throw failure;
    },
    fail,
  };
}

/**
 * Fecha cada sessão assim que a abertura dela termina, inclusive a que ainda está em andamento, e devolve as falhas
 * de fechamento. Abertura que rejeitou não deixa sessão (`openSession` já fechou o Chrome) e o erro dela foi para o worker.
 */
async function closeOpenings(openings: Array<Promise<Session>>): Promise<unknown[]> {
  const closes = await Promise.allSettled(
    openings.map(async (opening) => {
      const [opened] = await Promise.allSettled([opening]);
      if (opened.status === "fulfilled") await opened.value.close();
    }),
  );
  return closes.flatMap((close) => (close.status === "rejected" ? [close.reason as unknown] : []));
}

/**
 * Fila dinâmica: cada worker abre uma sessão própria e pega o próximo lote livre, em ordem, até a fila acabar.
 * Na primeira falha ninguém pega lote novo, e a função fecha cada sessão (a que ainda está abrindo, assim que abrir)
 * antes de rejeitar. Ela espera aberturas e fechamentos, que têm prazo, mas não os workers: um deles pode estar parado
 * em `onFrame`, esperando backpressure que só o consumidor desfaz.
 */
export async function captureFramesInParallel(options: ParallelCaptureOptions): Promise<Map<number, string>> {
  const hashes = new Map<number, string>();
  const workers = options.workers ?? defaultWorkerCount();
  const batches = splitIntoBatches(options.frames, options.batchSize ?? DEFAULT_BATCH_SIZE);
  if (batches.length === 0) return hashes;

  /** Uma por worker, registrada antes do primeiro `await` dele: o fechamento alcança também a que não terminou. */
  const openings: Array<Promise<Session>> = [];
  let nextBatch = 0;
  let failed = false;
  let firstFailure: unknown;
  let reportFailure: () => void = () => undefined;
  const failedFirst = new Promise<void>((resolve) => {
    reportFailure = resolve;
  });

  const worker = async (): Promise<void> => {
    const opening = (options.open ?? openSession)({
      url: options.url,
      viewport: options.viewport,
      gpu: options.gpu,
      ...(options.transparent !== undefined ? { transparent: options.transparent } : {}),
      ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
      ...(options.serverFailures !== undefined ? { serverFailures: options.serverFailures } : {}),
    });
    openings.push(opening);
    const session = await opening;

    while (!failed && nextBatch < batches.length) {
      const batch = batches[nextBatch] as number[];
      nextBatch += 1;
      for (const frame of batch) {
        if (failed) return;
        await session.seekFrame(frame, options.fps);
        if (options.shouldCapture !== undefined && !(await options.shouldCapture(frame, session))) continue;
        const { png, sha256 } = await session.capture();
        hashes.set(frame, sha256);
        await options.onFrame?.(frame, png);
      }
    }

    const errors = session.pageErrors();
    if (errors.length > 0) throw new Error(errors[0]);
  };

  const count = Math.min(Math.max(1, Math.floor(workers)), batches.length);
  const running = Array.from({ length: count }, () =>
    // Nenhum worker rejeita para fora: a primeira falha fica em `firstFailure` e o fechamento abaixo sempre roda.
    worker().catch((error: unknown) => {
      if (failed) return;
      failed = true;
      firstFailure = error;
      reportFailure();
    }),
  );
  // Ou todos terminam, ou a primeira falha encerra a espera (os demais podem estar presos no backpressure).
  await Promise.race([Promise.all(running), failedFirst]);
  const closeFailures = await closeOpenings(openings);
  if (failed) throw withCleanupFailures(firstFailure, closeFailures);
  if (closeFailures.length > 0) {
    const reasons = closeFailures.map((reason) => (reason instanceof Error ? reason.message : String(reason))).join("; ");
    throw new AggregateError(closeFailures, `captura completa, mas fechar o Chrome falhou: ${reasons}`);
  }
  return hashes;
}
