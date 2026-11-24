// FrankFrames — proprietário. Ver LICENSE na raiz.
import { availableParallelism, totalmem } from "node:os";
import { openSession } from "./capture.ts";
import type { Session, SessionTimeouts } from "./capture.ts";
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
  /** Chamado no worker logo após cada captura, antes do próximo frame. Pode esperar (backpressure). */
  onFrame?: (frame: number, png: Buffer) => void | Promise<void>;
  /** Limites de espera de cada sessão (veja `SessionTimeouts`). */
  timeouts?: SessionTimeouts;
  /** Falhas do servidor da página (`StaticServer.failures`): entram na mensagem quando uma sessão falha. */
  serverFailures?: () => ServerFailure[];
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

/**
 * Workers padrão: metade dos núcleos, no máximo 8, e nunca mais do que a memória
 * comporta (768 MB por browser). Medido: 6 workers cortam quase metade do tempo
 * de um render de 3 s em relação a 2.
 */
export function defaultWorkerCount(cpus = availableParallelism(), memoryBytes = totalmem()): number {
  const byCpu = Math.max(1, Math.floor(cpus / 2));
  const byMemory = Math.max(1, Math.floor(memoryBytes / (768 * 1024 * 1024)));
  return Math.max(2, Math.min(8, byCpu, byMemory));
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
 * Fila dinâmica: cada worker abre uma sessão própria e pega o próximo lote livre, em ordem, até a fila acabar.
 * Na primeira falha ninguém pega lote novo e a função rejeita sem esperar os demais (um worker pode estar parado
 * em `onFrame`, esperando backpressure que só o consumidor desfaz). O `finally` fecha todas as sessões.
 */
export async function captureFramesInParallel(options: ParallelCaptureOptions): Promise<Map<number, string>> {
  const hashes = new Map<number, string>();
  const workers = options.workers ?? defaultWorkerCount();
  const batches = splitIntoBatches(options.frames, options.batchSize ?? DEFAULT_BATCH_SIZE);
  if (batches.length === 0) return hashes;

  const sessions: Session[] = [];
  let nextBatch = 0;
  let failed = false;
  let firstFailure: unknown;
  let reportFailure: () => void = () => undefined;
  const failedFirst = new Promise<void>((resolve) => {
    reportFailure = resolve;
  });

  const worker = async (): Promise<void> => {
    const session = await openSession({
      url: options.url,
      viewport: options.viewport,
      gpu: options.gpu,
      ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
      ...(options.serverFailures !== undefined ? { serverFailures: options.serverFailures } : {}),
    });
    sessions.push(session);

    while (!failed && nextBatch < batches.length) {
      const batch = batches[nextBatch] as number[];
      nextBatch += 1;
      for (const frame of batch) {
        if (failed) return;
        await session.seekFrame(frame, options.fps);
        const { png, sha256 } = await session.capture();
        hashes.set(frame, sha256);
        await options.onFrame?.(frame, png);
      }
    }

    const errors = session.pageErrors();
    if (errors.length > 0) throw new Error(errors[0]);
  };

  try {
    const count = Math.min(Math.max(1, Math.floor(workers)), batches.length);
    const running = Array.from({ length: count }, () =>
      worker().catch((error: unknown) => {
        if (failed) return;
        failed = true;
        firstFailure = error;
        reportFailure();
      }),
    );
    // Ou todos terminam, ou a primeira falha encerra a espera (os demais podem estar presos no backpressure).
    await Promise.race([Promise.all(running), failedFirst]);
    if (failed) throw firstFailure instanceof Error ? firstFailure : new Error(String(firstFailure));
    return hashes;
  } finally {
    await Promise.allSettled(sessions.map((session) => session.close()));
  }
}
