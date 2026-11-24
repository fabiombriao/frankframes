// FrankFrames — proprietário. Ver LICENSE na raiz.
import { spawn } from "node:child_process";
import { accessSync, constants, createWriteStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { GenerateError } from "./generate-errors.ts";

/** Como executar o Codex: comando e argumentos que vêm antes dos do próprio Codex. Nunca passa por shell. */
export interface ResolvedCodex {
  command: string;
  args: string[];
}

export interface ResolveCodexOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Injetável nos testes; o padrão olha o disco (no POSIX, exige permissão de execução). */
  pathExists?: (file: string) => boolean;
}

const INSTALL_HINT = "instale o Codex CLI (`npm i -g @openai/codex`) e rode `codex login`, ou aponte FRANKFRAMES_CODEX para o executável";
const REINSTALL_HINT = "reinstale: `npm i -g @openai/codex`";
const AUTH_HINT = "rode `codex login` e entre com a conta ChatGPT; o FrankFrames não usa chave de API";
const SCRIPT_EXT = /\.(?:js|mjs|cjs|ts)$/i;

function defaultPathExists(platform: NodeJS.Platform): (file: string) => boolean {
  return (file) => {
    if (!existsSync(file)) return false;
    if (platform === "win32") return true;
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      // Existe mas não executa: para o chamador é o mesmo que ausente (o motivo vai na mensagem de quem recusa).
      return false;
    }
  };
}

/** `PATH` com qualquer capitalização (`Path` no Windows). */
function pathVariable(env: NodeJS.ProcessEnv): string {
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") return env[key] ?? "";
  return "";
}

/**
 * Localiza o Codex sem shell. `FRANKFRAMES_CODEX` manda sozinho (sem cair no PATH). No Windows o npm instala
 * `codex.cmd`, que não é executável direto sem shell: roda o `codex.js` que ele chama, com o node ao lado ou o nosso.
 */
export function resolveCodex(options: ResolveCodexOptions): ResolvedCodex {
  const { env, platform } = options;
  const p = platform === "win32" ? path.win32 : path.posix;
  const exists = options.pathExists ?? defaultPathExists(platform);

  const fromCmd = (cmd: string): ResolvedCodex => {
    const dir = p.dirname(cmd);
    const script = p.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!exists(script)) {
      throw new GenerateError("E_CODEX_MISSING", `achei ${cmd}, mas não ${script}`, REINSTALL_HINT);
    }
    const sibling = p.join(dir, "node.exe");
    return { command: exists(sibling) ? sibling : process.execPath, args: [script] };
  };

  const fromFile = (file: string): ResolvedCodex => {
    if (SCRIPT_EXT.test(file)) return { command: process.execPath, args: [file] };
    if (platform === "win32" && /\.cmd$/i.test(file)) return fromCmd(file);
    return { command: file, args: [] };
  };

  const forced = env["FRANKFRAMES_CODEX"];
  if (forced !== undefined && forced !== "") {
    if (!exists(forced)) {
      throw new GenerateError("E_CODEX_MISSING", `FRANKFRAMES_CODEX aponta para um arquivo que não existe: ${forced}`, INSTALL_HINT);
    }
    return fromFile(forced);
  }

  const names = platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
  for (const dir of pathVariable(env).split(p.delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      const candidate = p.join(dir, name);
      // `codex.ps1` e o `codex` sem extensão do npm no Windows não rodam sem shell: ficam de fora de `names`.
      if (exists(candidate)) return fromFile(candidate);
    }
  }
  throw new GenerateError("E_CODEX_MISSING", "não encontrei o Codex CLI no PATH", INSTALL_HINT);
}

const BLOCKED_ENV_NAMES = new Set(["OPENAI_API_KEY", "CODEX_API_KEY", "GROQ_API_KEY"]);
const BLOCKED_ENV_SUFFIXES = ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD"];
const BLOCKED_ENV_PARTS = ["SECRET", "PASSWORD", "CREDENTIAL"];
/** O Codex e o Node precisam destes para achar a própria autenticação e o sistema; passam mesmo que o padrão os pegasse. */
const KEPT_ENV_NAMES = new Set(["PATH", "PATHEXT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "CODEX_HOME"]);

/**
 * Ambiente do filho: o do processo menos segredo e a configuração do próprio FrankFrames.
 * Sai (comparando em maiúsculas): chaves de API conhecidas, `FRANKFRAMES_*`, nomes que terminam em
 * `_KEY`/`_TOKEN`/`_SECRET`/`_PASSWORD` ou que contêm `SECRET`/`PASSWORD`/`CREDENTIAL`. A conta é a do ChatGPT.
 */
export function sanitizedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (!KEPT_ENV_NAMES.has(upper)) {
      if (BLOCKED_ENV_NAMES.has(upper) || upper.startsWith("FRANKFRAMES_")) continue;
      if (BLOCKED_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix)) || BLOCKED_ENV_PARTS.some((part) => upper.includes(part))) continue;
    }
    clean[key] = value;
  }
  return clean;
}

interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  stdinError: string | undefined;
}

interface CaptureOptions {
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  logPath?: string;
  signal?: AbortSignal;
  cwd?: string;
}

const OUTPUT_CAP = 64 * 1024;

/** Mata o processo e todos os descendentes: `taskkill /T` no Windows, grupo de processos no resto. */
async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const done = Promise.withResolvers<void>();
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", (error) => done.reject(new Error(`taskkill falhou: ${error.message}`)));
    killer.on("close", () => done.resolve());
    await done.promise;
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    // ESRCH: o grupo já acabou. Qualquer outro erro é real.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Roda um comando com stdin opcional, tempo limite, log em disco e morte da árvore inteira. */
function capture(resolved: ResolvedCodex, args: string[], options: CaptureOptions): Promise<CaptureResult> {
  const settled = Promise.withResolvers<CaptureResult>();
  const child = spawn(resolved.command, [...resolved.args, ...args], {
    env: options.env,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    shell: false,
  });
  const log = options.logPath !== undefined ? createWriteStream(options.logPath, { flags: "a" }) : undefined;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let aborted = false;
  let stdinError: string | undefined;
  let done = false;

  const keep = (current: string, chunk: Buffer): string => {
    const next = current + chunk.toString("utf8");
    return next.length > OUTPUT_CAP ? next.slice(next.length - OUTPUT_CAP) : next;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = keep(stdout, chunk);
    log?.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = keep(stderr, chunk);
    log?.write(chunk);
  });
  // O filho pode sair antes de ler o prompt inteiro (EPIPE): guarda o motivo para a mensagem de falha.
  child.stdin.on("error", (error) => {
    stdinError = error.message;
  });

  const finish = (code: number | null): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    const result: CaptureResult = { code, stdout, stderr, timedOut, aborted, stdinError };
    if (log === undefined) settled.resolve(result);
    else log.end(() => settled.resolve(result));
  };

  const stop = (): void => {
    if (child.pid === undefined) return;
    killTree(child.pid).then(
      () => {
        // Depois de matar a árvore não esperamos pelos pipes (um neto órfão poderia segurá-los abertos).
        child.stdout.destroy();
        child.stderr.destroy();
      },
      (error: Error) => {
        done = true;
        clearTimeout(timer);
        settled.reject(error);
      },
    );
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    stop();
  };
  if (options.signal?.aborted === true) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  child.on("error", (error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    log?.end();
    settled.reject(new GenerateError("E_CODEX_FAILED", `não consegui executar ${resolved.command}: ${error.message}`, INSTALL_HINT));
  });
  child.on("exit", (code) => {
    if (timedOut || aborted) finish(code);
  });
  child.on("close", (code) => finish(code));

  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();
  return settled.promise;
}

/** Versão do Codex (`codex-cli 0.170.0`), que vai para o relatório. */
export async function codexVersion(resolved: ResolvedCodex, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await capture(resolved, ["--version"], { env: sanitizedEnv(env), timeoutMs: 30_000 });
  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code !== 0 || text === "") {
    throw new GenerateError("E_CODEX_MISSING", `\`codex --version\` falhou (código ${result.code}): ${text.slice(-300)}`, REINSTALL_HINT);
  }
  return text.split(/\r?\n/)[0]!.trim();
}

/**
 * Exige login com a conta ChatGPT. O Codex 0.170 escreve o estado no stderr, então lemos os dois fluxos;
 * qualquer outra resposta (deslogado, chave de API) é recusada.
 */
export async function checkCodexAuth(resolved: ResolvedCodex, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await capture(resolved, ["login", "status"], { env: sanitizedEnv(env), timeoutMs: 30_000 });
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.code === 0 && text.includes("Logged in using ChatGPT")) return;
  const state = /api key/i.test(text) ? "o Codex está logado com chave de API" : "o Codex não está logado com a conta ChatGPT";
  throw new GenerateError("E_CODEX_AUTH", `${state} (\`codex login status\`: ${text.trim().slice(-200) || `código ${result.code}`})`, AUTH_HINT);
}

export interface CodexExecInput {
  prompt: string;
  contextDir: string;
  schemaPath: string;
  /** Onde o Codex grava a última mensagem (`-o`). */
  lastMessagePath: string;
  timeoutMs: number;
  logPath: string;
  model?: string;
  signal?: AbortSignal;
}

/** Argumentos do `codex exec`: somente leitura, sem sessão em disco, sem config do usuário, prompt pelo stdin (`-`). */
export function codexExecArgs(input: CodexExecInput): string[] {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "--ignore-user-config",
    "--color",
    "never",
    "-C",
    input.contextDir,
    "--output-schema",
    input.schemaPath,
    "-o",
    input.lastMessagePath,
    ...(input.model !== undefined ? ["-m", input.model] : []),
    "-",
  ];
}

/** Uma chamada nova ao Codex (sem `resume`). Devolve a última mensagem do agente. */
export async function runCodexExec(resolved: ResolvedCodex, env: NodeJS.ProcessEnv, input: CodexExecInput): Promise<string> {
  const result = await capture(resolved, codexExecArgs(input), {
    env: sanitizedEnv(env),
    input: input.prompt,
    timeoutMs: input.timeoutMs,
    logPath: input.logPath,
    cwd: input.contextDir,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  if (result.aborted) throw new GenerateError("E_CODEX_FAILED", "interrompido pelo usuário", `o log parcial está em ${input.logPath}`);
  if (result.timedOut) {
    throw new GenerateError("E_CODEX_TIMEOUT", `o Codex passou de ${Math.round(input.timeoutMs / 1000)} s sem terminar`, `aumente --timeout (log em ${input.logPath})`);
  }
  if (result.code !== 0) {
    const tail = result.stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
    const why = result.stdinError !== undefined ? ` (stdin: ${result.stdinError})` : "";
    throw new GenerateError("E_CODEX_FAILED", `o Codex saiu com código ${result.code}${why}: ${tail}`, `veja o log em ${input.logPath}`);
  }
  try {
    return await readFile(input.lastMessagePath, "utf8");
  } catch (error) {
    throw new GenerateError("E_CODEX_OUTPUT", `o Codex terminou sem gravar a resposta: ${(error as Error).message}`, `veja o log em ${input.logPath}`);
  }
}

/** Contrato entre o `runGenerate` e quem produz o HTML: o Codex de verdade ou um agente falso nos testes. */
export interface GenerationAgent {
  readonly name: string;
  /** Falha com `E_CODEX_MISSING` ou `E_CODEX_AUTH` antes de qualquer escrita. */
  check(): Promise<{ version: string }>;
  run(input: { prompt: string; contextDir: string; schemaPath: string; timeoutMs: number; logPath: string; signal?: AbortSignal }): Promise<string>;
}

export interface CodexAgentOptions {
  model?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Agente que chama o Codex CLI logado na conta ChatGPT do titular. */
export function codexAgent(options: CodexAgentOptions = {}): GenerationAgent {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  let resolved: ResolvedCodex | undefined;
  const locate = (): ResolvedCodex => (resolved ??= resolveCodex({ env, platform }));
  return {
    name: "codex",
    async check() {
      const found = locate();
      const version = await codexVersion(found, env);
      await checkCodexAuth(found, env);
      return { version };
    },
    run(input) {
      return runCodexExec(locate(), env, {
        prompt: input.prompt,
        contextDir: input.contextDir,
        schemaPath: input.schemaPath,
        // Ao lado do log (`attempt-N.log` → `attempt-N.last.json`), fora do contexto que o Codex enxerga.
        lastMessagePath: input.logPath.replace(/\.log$/, ".last.json"),
        timeoutMs: input.timeoutMs,
        logPath: input.logPath,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    },
  };
}
