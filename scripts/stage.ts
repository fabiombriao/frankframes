// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Executa uma etapa do gate com prazo. Estourou: mostra o fim do log da etapa e mata a árvore de
 * processos inteira (o runner de testes e o Chrome que ele abriu), em vez de esperar para sempre.
 */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";

export interface RunOptions {
  file: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Prazo da etapa, em ms. */
  timeoutMs: number;
  /** Também grava a saída neste arquivo (o log completo, para consulta depois). */
  logFile?: string;
  /** Repassa a saída ao terminal (padrão: sim). */
  echo?: boolean;
  /** Quanto esperar a saída do processo depois de matá-lo. */
  killWaitMs?: number;
}

export interface RunResult {
  /** Código de saída; 124 quando o prazo estourou e 127 se o processo nem abriu. */
  code: number;
  timedOut: boolean;
  /** Fim da saída da etapa (stdout e stderr juntos). */
  tail: string;
}

/** Quanto da saída fica guardado para o relatório de timeout. */
const TAIL_CHARS = 6_000;

/** Mata o processo e todos os descendentes. No Windows `taskkill /T`; no POSIX, o grupo do processo. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
    // 128 = processo não existe mais: já terminou, nada a matar.
    if (result.status !== 0 && result.status !== 128) {
      throw new Error(`taskkill falhou (exit ${result.status}) ao encerrar o PID ${pid}: ${result.stderr.trim()}`);
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function runCommand(options: RunOptions): Promise<RunResult> {
  const { file, args, cwd, env, timeoutMs, logFile, echo = true, killWaitMs = 10_000 } = options;
  const sink = logFile === undefined ? undefined : createWriteStream(logFile);
  let tail = "";
  const take = (chunk: Buffer, stream: NodeJS.WriteStream): void => {
    if (echo) stream.write(chunk);
    sink?.write(chunk);
    tail = (tail + chunk.toString("utf8")).slice(-TAIL_CHARS);
  };

  const finished = Promise.withResolvers<number>();
  const child = spawn(file, args, {
    cwd,
    ...(env !== undefined ? { env } : {}),
    stdio: ["inherit", "pipe", "pipe"],
    // Grupo próprio no POSIX para poder matar a árvore; no Windows `detached` abriria outra janela.
    detached: process.platform !== "win32",
  });
  child.stdout?.on("data", (chunk: Buffer) => take(chunk, process.stdout));
  child.stderr?.on("data", (chunk: Buffer) => take(chunk, process.stderr));
  child.on("error", () => finished.resolve(127));
  child.on("exit", (value) => finished.resolve(value ?? 1));

  let timedOut = false;
  let killWait: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
    // Se nem a morte forçada fizer o processo sair, a etapa ainda assim termina.
    killWait = setTimeout(() => finished.resolve(124), killWaitMs);
  }, timeoutMs);

  const code = await finished.promise;
  clearTimeout(timer);
  if (killWait !== undefined) clearTimeout(killWait);
  if (sink !== undefined) await new Promise<void>((resolveSink) => sink.end(() => resolveSink()));
  return { code: timedOut ? 124 : code, timedOut, tail };
}
