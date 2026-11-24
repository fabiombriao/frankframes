// FrankFrames — proprietário. Ver LICENSE na raiz.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { orderedFeeder } from "@frankframes/engine";

/** O FFmpeg alimentado por pipe caiu, saiu antes da hora ou não subiu. A mensagem traz o fim da stderr dele. */
export class PipeEncodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PipeEncodeError";
  }
}

/** Fim da stderr guardado para a mensagem de erro: o suficiente para ver a causa, sem crescer sem limite. */
const STDERR_TAIL_BYTES = 8 * 1024;

export interface PipeEncoder {
  readonly pid: number | undefined;
  /** Primeira falha do FFmpeg (com a stderr), se houve. Cancelamento aparece como `AbortError`. */
  readonly failure: Error | undefined;
  /** Escreve um PNG inteiro e espera o pipe esvaziar (backpressure). Lança a falha do FFmpeg se ele já caiu. */
  write(png: Buffer): Promise<void>;
  /** Fecha a entrada e espera o FFmpeg terminar de codificar; lança se ele falhou. */
  end(): Promise<void>;
  /** Mata o FFmpeg, se ainda vive, e espera ele sair (o arquivo de saída fica livre). Nunca lança. */
  kill(): Promise<void>;
}

export interface PipeEncoderOptions {
  ffmpeg: string;
  args: string[];
  /** Aborta: o FFmpeg é morto e `failure` vira `AbortError`. */
  signal?: AbortSignal;
  /** Chamado uma vez, na primeira falha, para acordar quem espera o pipe (captura e fila ordenada). */
  onFailure?: (error: Error) => void;
  /** Para testes: recebe o pid assim que o processo sobe. */
  onSpawn?: (pid: number) => void;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return code !== null ? `código ${code}` : `sinal ${signal ?? "desconhecido"}`;
}

/**
 * Sobe o FFmpeg lendo PNGs de `pipe:0`. `kill()` e a saída do processo Node (Ctrl+C não roda `finally`)
 * encerram o FFmpeg: ele nunca fica órfão escrevendo num diretório que já foi apagado.
 */
export function startPipeEncoder(options: PipeEncoderOptions): PipeEncoder {
  const child = spawn(options.ffmpeg, options.args, {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (child.pid !== undefined) options.onSpawn?.(child.pid);

  let stderrTail = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });

  let failure: Error | undefined;
  let closed = false;
  let expectedKill = false;
  let ending = false;
  let stdinBroken = false;
  const fail = (error: Error): void => {
    if (failure !== undefined) return;
    failure = error;
    options.onFailure?.(error);
  };

  const closedPromise = new Promise<void>((resolve) => {
    const finish = (): void => {
      if (closed) return;
      closed = true;
      process.removeListener("exit", killSync);
      resolve();
    };
    child.once("close", (code, signal) => {
      if (!expectedKill && failure === undefined) {
        const tail = stderrTail.trim();
        if (code !== 0) {
          fail(new PipeEncodeError(`o FFmpeg terminou com ${describeExit(code, signal)} durante o encode${tail === "" ? "" : `: ${tail}`}`));
        } else if (!ending) {
          fail(new PipeEncodeError("o FFmpeg terminou antes de receber todos os frames"));
        }
      }
      finish();
    });
    child.once("error", (error) => {
      // Falha de partida (ENOENT) e abort chegam aqui; um processo que nunca subiu não emite `close`.
      if (!expectedKill) fail(error.name === "AbortError" ? error : new PipeEncodeError(`não foi possível iniciar o FFmpeg: ${error.message}`, { cause: error }));
      if (child.pid === undefined) finish();
    });
  });

  // `kill()` não lança quando o processo já saiu (devolve false): nada a tratar aqui.
  function killSync(): void {
    child.kill();
  }
  // Antes dos outros handlers de saída: o diretório de trabalho só pode ser apagado com o FFmpeg já morto.
  process.prependOnceListener("exit", killSync);

  // Escrever num FFmpeg que caiu gera EPIPE no stdin: sem ouvinte seria exceção não tratada. A causa real é
  // a saída do processo (com a stderr), que o `close` registra.
  child.stdin!.on("error", () => {
    stdinBroken = true;
  });

  const throwFailure = (): never => {
    throw failure ?? new PipeEncodeError("o FFmpeg fechou o pipe de entrada");
  };

  return {
    get pid() {
      return child.pid;
    },
    get failure() {
      return failure;
    },
    async write(png) {
      if (failure !== undefined) throw failure;
      if (closed || stdinBroken) {
        await closedPromise;
        return throwFailure();
      }
      const stdin = child.stdin!;
      if (stdin.write(png)) return;
      // Buffer interno cheio: espera esvaziar (backpressure), ou o FFmpeg cair, ou o pipe quebrar.
      // O erro do pipe (EPIPE) já foi anotado em `stdinBroken` pelo ouvinte acima: a falha de verdade é lançada logo abaixo.
      await Promise.race([once(stdin, "drain"), closedPromise]).catch(() => undefined);
      if (failure !== undefined) throw failure;
      if (closed || stdinBroken) {
        await closedPromise;
        return throwFailure();
      }
    },
    async end() {
      ending = true;
      if (failure !== undefined) throw failure;
      if (!closed && !stdinBroken) child.stdin!.end();
      await closedPromise;
      if (failure !== undefined) throw failure;
    },
    async kill() {
      if (!closed) {
        expectedKill = true;
        child.stdin!.destroy();
        child.kill();
      }
      await closedPromise;
    },
  };
}

export interface EncodeWhileCapturingOptions<T> {
  ffmpeg: string;
  args: string[];
  /** Quantos frames o FFmpeg espera, numerados de 0 a `total - 1`. */
  total: number;
  /** Frames em espera para reordenar antes de o worker adiantado esperar. */
  maxBuffered: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
  /** Roda a captura e chama `deliver` com cada PNG assim que fica pronto, em qualquer ordem. */
  capture: (deliver: (frame: number, png: Buffer) => Promise<void>) => Promise<T>;
}

export interface EncodeRun<T> {
  captured: T;
  /** Resolve quando o FFmpeg termina (a cauda depois do último frame); rejeita com a falha dele. */
  encoded: Promise<void>;
  /** Encerra o FFmpeg se ainda roda. Chamar em todo caminho de saída antes de apagar o diretório de trabalho. */
  kill: () => Promise<void>;
}

/**
 * Codifica enquanto captura: os PNGs entram no FFmpeg na ordem dos frames (`orderedFeeder`), sem passar por disco.
 * Falha alto nos dois sentidos: o FFmpeg cair derruba a captura com a stderr dele; a captura falhar (ou o
 * cancelamento) mata o FFmpeg. Quando a captura termina a entrada já está fechada e `encoded` é só a cauda.
 */
export async function encodeWhileCapturing<T>(options: EncodeWhileCapturingOptions<T>): Promise<EncodeRun<T>> {
  let feeder: ReturnType<typeof orderedFeeder<Buffer>> | undefined;
  const encoder = startPipeEncoder({
    ffmpeg: options.ffmpeg,
    args: options.args,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onSpawn !== undefined ? { onSpawn: options.onSpawn } : {}),
    onFailure: (error) => feeder?.fail(error),
  });
  feeder = orderedFeeder<Buffer>((_frame, png) => encoder.write(png), options.total, { maxBuffered: options.maxBuffered });
  // Falha antes de o `feeder` existir (processo que não sobe): o `failure` já está guardado e o primeiro `add` o lança.
  if (encoder.failure !== undefined) feeder.fail(encoder.failure);

  let captured: T;
  try {
    captured = await options.capture((frame, png) => feeder!.add(frame, png));
    await feeder.finish();
  } catch (error) {
    await encoder.kill();
    throw encoder.failure ?? error;
  }

  const encoded = encoder.end();
  // Quem chama só espera `encoded` depois do áudio: sem este ouvinte, uma falha nesse intervalo seria "não tratada".
  encoded.catch(() => undefined);
  return { captured, encoded, kill: () => encoder.kill() };
}
