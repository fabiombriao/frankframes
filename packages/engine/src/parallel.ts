// FrankFrames — proprietário. Ver LICENSE na raiz.
import { availableParallelism } from "node:os";
import { openSession } from "./capture.ts";
import type { Session } from "./capture.ts";
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
  /** Chamado no worker logo após cada captura, antes do próximo frame. */
  onFrame?: (frame: number, png: Buffer) => void | Promise<void>;
}

/**
 * Deduplica, ordena e divide em blocos contíguos equilibrados.
 * A diferença de tamanho entre blocos é no máximo 1 frame.
 */
export function splitIntoChunks(frames: number[], workers: number): number[][] {
  const ordered = [...new Set(frames)].sort((a, b) => a - b);
  if (ordered.length === 0) return [];

  const count = Math.min(Math.max(1, Math.floor(workers)), ordered.length);
  const base = Math.floor(ordered.length / count);
  const remainder = ordered.length % count;

  const chunks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < count; i += 1) {
    const size = base + (i < remainder ? 1 : 0);
    chunks.push(ordered.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}

/**
 * Cada bloco roda numa sessão própria. O `finally` fecha todas as sessões,
 * inclusive quando um bloco falha ou a página reporta erro.
 */
export async function captureFramesInParallel(options: ParallelCaptureOptions): Promise<Map<number, string>> {
  const hashes = new Map<number, string>();
  // Default: metade dos núcleos, no máximo 4 e no mínimo 1.
  const workers = options.workers ?? Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)));
  const chunks = splitIntoChunks(options.frames, workers);
  if (chunks.length === 0) return hashes;

  const sessions: Session[] = [];
  try {
    const settled = await Promise.allSettled(
      chunks.map(async (chunk) => {
        const session = await openSession({
          url: options.url,
          viewport: options.viewport,
          gpu: options.gpu,
        });
        sessions.push(session);

        for (const frame of chunk) {
          await session.seekFrame(frame, options.fps);
          const { png, sha256 } = await session.capture();
          hashes.set(frame, sha256);
          await options.onFrame?.(frame, png);
        }

        const errors = session.pageErrors();
        if (errors.length > 0) throw new Error(errors[0]);
      }),
    );

    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) {
      throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
    }

    return hashes;
  } finally {
    await Promise.allSettled(sessions.map((session) => session.close()));
  }
}
