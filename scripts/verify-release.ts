// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Verifica o tarball do release instalando-o de verdade (EDT-65).
 *
 *   node scripts/verify-release.ts out/release/frankframes-cli-<versão>.tgz
 *
 * Instala o tgz com `npm install --prefix <tmp>` (rede só para o registro npm: `parse5`, `puppeteer-core`
 * e transitivas) e, com `FRANKFRAMES_HOME=<repo>/vendor`, roda o bin instalado: `--version`, `doctor`,
 * `init`, `lint --json`, `blocks list`, `studio`, `render --preset draft` de 1 s e ffprobe do MP4.
 * No Windows chama também o shim `frankframes.cmd` via `cmd /c` com argumentos fixos.
 * Cada etapa falha alto e imprime o comando que falhou.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCommand } from "./build-release.ts";
import { killTree, runCommand } from "./stage.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MINUTE = 60_000;

/** Prazos por etapa (ms): estourou, a etapa reprova e a árvore de processos é encerrada. */
const TIMEOUTS = { install: 10 * MINUTE, quick: 2 * MINUTE, doctor: 3 * MINUTE, render: 10 * MINUTE, studio: 2 * MINUTE } as const;

/** Composição de 1 s a 30 fps: 30 frames, um clip de texto. */
const ONE_SECOND_COMPOSITION = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { margin: 0; background: #0b0b0f; color: #fff; font: 64px monospace; }
      .clip { position: absolute; left: 80px; top: 120px; }
    </style>
  </head>
  <body>
    <div data-composition-id="verify-release" data-root="true" data-width="1280" data-height="720" data-fps="30" data-duration="1">
      <div data-clip-id="title" data-start="0" data-duration="1" class="clip">release ok</div>
    </div>
  </body>
</html>
`;

/** Erro de verificação com código estável e dica acionável. */
export class VerifyError extends Error {
  readonly code: string;
  readonly hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.name = "VerifyError";
    this.code = code;
    this.hint = hint;
  }
}

/** Mostra o comando como o usuário o digitaria (aspas só onde há espaço). */
function display(file: string, args: string[]): string {
  return [file, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

interface Ran {
  stdout: string;
}

/** Roda uma etapa: exige exit 0 e, se houver `check`, que a saída passe nele. Falha imprimindo o comando. */
async function step(
  name: string,
  file: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; check?: (output: string) => string | null },
): Promise<Ran> {
  const command = display(file, args);
  process.stdout.write(`▶ ${name}\n  $ ${command}\n`);
  const started = Date.now();
  const run = await runCommand({ file, args, cwd: options.cwd, ...(options.env === undefined ? {} : { env: options.env }), timeoutMs: options.timeoutMs, echo: false });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (run.timedOut) {
    throw new VerifyError("E_VERIFY_TIMEOUT", `${name}: prazo de ${options.timeoutMs / 1000} s esgotado\n  comando: ${command}\n${run.tail}`, "rode o comando acima à mão para ver onde trava");
  }
  if (run.code !== 0) {
    throw new VerifyError("E_VERIFY_STEP", `${name}: saiu com ${run.code}\n  comando: ${command}\n${run.tail}`, "rode o comando acima à mão; o tarball foi instalado em um diretório temporário mantido para inspeção");
  }
  const problem = options.check?.(run.tail) ?? null;
  if (problem !== null) {
    throw new VerifyError("E_VERIFY_OUTPUT", `${name}: ${problem}\n  comando: ${command}\n${run.tail}`, "compare a saída acima com o esperado");
  }
  process.stdout.write(`  ok (${seconds} s)\n`);
  return { stdout: run.tail };
}

/** `blocks list` imprime uma linha "slug  duração  nome — resumo" por bloco; a saída guardada é só o fim dela. */
function blocksListed(output: string): string | null {
  const lines = output.split("\n").filter((line) => /^\S+\s+[\d.]+s\s/.test(line));
  return lines.length >= 10 ? null : `blocks list devolveu ${lines.length} blocos reconhecíveis (catalog/blocks ausente do tarball?)`;
}

/** Sobe o Studio do bin instalado, consulta a API e o encerra. */
async function verifyStudio(node: string, cli: string, entry: string, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const command = display(node, [cli, "studio", entry]);
  process.stdout.write(`▶ studio\n  $ ${command}\n`);
  const child = spawn(node, [cli, "studio", entry], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let output = "";
  const url = Promise.withResolvers<string>();
  const onData = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-4000);
    const match = /studio (http:\/\/\S+)/.exec(output);
    if (match !== null) url.resolve(match[1]!);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (error) => url.reject(error));
  child.on("exit", (code) => url.reject(new Error(`studio saiu com ${code} antes de abrir o servidor`)));
  const timer = setTimeout(() => url.reject(new Error(`studio não respondeu em ${TIMEOUTS.studio / 1000} s`)), TIMEOUTS.studio);
  try {
    const base = (await url.promise).replace(/\/$/, "");
    const fetchOk = async (path: string): Promise<Response> => {
      const response = await fetch(`${base}${path}`);
      if (!response.ok) throw new Error(`GET ${path} respondeu HTTP ${response.status}`);
      return response;
    };
    const home = await (await fetchOk("/")).text();
    if (!/<html/i.test(home)) throw new Error("GET / não devolveu HTML do Studio (estáticos de packages/cli/src/studio ausentes?)");
    const blocks = (await (await fetchOk("/api/blocks")).json()) as unknown;
    if (!Array.isArray(blocks) || blocks.length < 10) throw new Error(`GET /api/blocks devolveu ${Array.isArray(blocks) ? blocks.length : "não-lista"} blocos (catálogo ausente?)`);
    const presets = (await (await fetchOk("/api/motion/presets")).json()) as Record<string, Array<{ name?: string }>>;
    const first = Object.values(presets).flat().find((preset) => typeof preset.name === "string")?.name;
    if (first === undefined) throw new Error("GET /api/motion/presets sem nenhum preset");
    const thumb = await fetchOk(`/__ff_motion/${first}.gif`);
    if (thumb.headers.get("content-type") !== "image/gif") throw new Error(`miniatura de ${first} não é GIF (catalog/motion/thumbs ausente?)`);
  } catch (error) {
    throw new VerifyError("E_VERIFY_STUDIO", `studio: ${(error as Error).message}\n  comando: ${command}\n${output}`, "rode o comando acima à mão e abra o endereço impresso");
  } finally {
    clearTimeout(timer);
    child.removeAllListeners("exit");
    killTree(child);
  }
  process.stdout.write("  ok\n");
}

function expectedVersion(): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, "packages", "cli", "package.json"), "utf8")) as { version?: string };
  if (manifest.version === undefined) throw new VerifyError("E_VERIFY_VERSION", "packages/cli/package.json sem version", "defina a versão do pacote cli");
  return manifest.version;
}

export async function verifyRelease(tarballArg: string): Promise<void> {
  const tarball = resolve(tarballArg);
  const version = expectedVersion();
  if (!existsSync(tarball)) {
    throw new VerifyError("E_VERIFY_TARBALL", `tarball não encontrado: ${tarball}`, "rode `node scripts/build-release.ts` antes");
  }
  if (basename(tarball) !== `frankframes-cli-${version}.tgz`) {
    throw new VerifyError("E_VERIFY_TARBALL", `o tarball ${basename(tarball)} não é frankframes-cli-${version}.tgz`, "gere de novo com `node scripts/build-release.ts`");
  }
  const vendor = join(ROOT, "vendor");
  const ffprobe = join(vendor, "ffmpeg", "bin", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  if (!existsSync(ffprobe)) {
    throw new VerifyError("E_VERIFY_ASSETS", `ffprobe ausente em ${ffprobe}`, "rode `node scripts/vendor-ffmpeg.ts` (e `node scripts/fetch-fonts.ts`) no repositório");
  }

  const temp = await mkdtemp(join(tmpdir(), "ff-verify-release-"));
  const prefix = join(temp, "prefix");
  const work = join(temp, "work");
  await mkdir(prefix, { recursive: true });
  await mkdir(work, { recursive: true });
  await writeFile(join(prefix, "package.json"), '{"name":"ff-verify-release","private":true}\n');
  process.stdout.write(`diretório temporário: ${temp}\n`);

  // Ambiente limpo de qualquer instalação anterior: o único asset externo é o vendor do repositório.
  const env: NodeJS.ProcessEnv = { ...process.env, FRANKFRAMES_HOME: vendor };
  const node = process.execPath;

  const install = npmCommand(["install", "--prefix", prefix, tarball, "--no-audit", "--no-fund", "--loglevel=error"]);
  await step("instalar tarball", install.file, install.args, { cwd: work, env, timeoutMs: TIMEOUTS.install });

  const packageDir = join(prefix, "node_modules", "@frankframes", "cli");
  const cli = join(packageDir, "packages", "cli", "src", "cli.js");
  if (!existsSync(cli)) {
    throw new VerifyError("E_VERIFY_INSTALL", `${cli} não existe depois do install`, "confira `bin` e `files` no package.json do estágio");
  }
  const sameVersion = (output: string): string | null => (output.trim() === version ? null : `esperava a versão ${version}, saiu "${output.trim()}"`);

  await step("--version", node, [cli, "--version"], { cwd: work, env, timeoutMs: TIMEOUTS.quick, check: sameVersion });

  // O shim que o npm instala em .bin é o que o usuário chama. No Windows é .cmd; roda de dentro de .bin
  // para o caminho do shim não passar por aspas do cmd.
  const binDir = join(prefix, "node_modules", ".bin");
  if (process.platform === "win32") {
    if (!existsSync(join(binDir, "frankframes.cmd"))) {
      throw new VerifyError("E_VERIFY_INSTALL", `${join(binDir, "frankframes.cmd")} não existe`, "confira `bin` no package.json do estágio");
    }
    // `.\` explícito: o cmd não procura o .cmd no diretório atual por conta própria.
    const shim = ".\\frankframes.cmd";
    await step(`shim ${shim} --version`, "cmd", ["/c", shim, "--version"], { cwd: binDir, env, timeoutMs: TIMEOUTS.quick, check: sameVersion });
    await step(`shim ${shim} blocks list`, "cmd", ["/c", shim, "blocks", "list"], {
      cwd: binDir,
      env,
      timeoutMs: TIMEOUTS.quick,
      check: blocksListed,
    });
  } else {
    await step("shim frankframes --version", join(binDir, "frankframes"), ["--version"], { cwd: work, env, timeoutMs: TIMEOUTS.quick, check: sameVersion });
  }

  await step("doctor", node, [cli, "doctor"], { cwd: work, env, timeoutMs: TIMEOUTS.doctor });

  const project = join(work, "projeto");
  await step("init", node, [cli, "init", project], {
    cwd: work,
    env,
    timeoutMs: TIMEOUTS.quick,
    check: () => (existsSync(join(project, "index.html")) ? null : "init não criou index.html"),
  });
  await step("lint --json", node, [cli, "lint", join(project, "index.html"), "--json"], {
    cwd: work,
    env,
    timeoutMs: TIMEOUTS.quick,
    check: (output) => {
      try {
        return (JSON.parse(output) as { ok?: boolean }).ok === true ? null : "lint --json com ok diferente de true";
      } catch {
        return "saída do lint --json não é JSON";
      }
    },
  });
  await step("blocks list", node, [cli, "blocks", "list"], {
    cwd: work,
    env,
    timeoutMs: TIMEOUTS.quick,
    check: blocksListed,
  });

  await verifyStudio(node, cli, join(project, "index.html"), env, work);

  const composition = join(work, "um-segundo.html");
  const video = join(work, "um-segundo.mp4");
  await writeFile(composition, ONE_SECOND_COMPOSITION);
  await step("render --preset draft --workers 2 (1 s)", node, [cli, "render", composition, "-o", video, "--preset", "draft", "--workers", "2"], {
    cwd: work,
    env,
    timeoutMs: TIMEOUTS.render,
  });
  // Só ENOENT significa "não gerou"; qualquer outro erro de stat sobe com a mensagem original.
  let size: { size: number } | null;
  try {
    size = await stat(video);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new VerifyError("E_VERIFY_RENDER", `não consegui ler ${video}: ${(error as Error).message}`, "rode o comando do render à mão");
    }
    size = null;
  }
  if (size === null || size.size === 0) {
    throw new VerifyError("E_VERIFY_RENDER", `render não gerou ${video}`, "rode o comando do render à mão");
  }
  await step("ffprobe do MP4", ffprobe, ["-v", "error", "-show_entries", "stream=codec_name,nb_frames", "-of", "default=nw=1", video], {
    cwd: work,
    env,
    timeoutMs: TIMEOUTS.quick,
    check: (output) => (/codec_name=av1/.test(output) && /nb_frames=30\b/.test(output) ? null : `esperava av1 e 30 frames, saiu ${output.replace(/\s+/g, " ").trim()}`),
  });

  await rm(temp, { recursive: true, force: true });
  process.stdout.write(`\nok · ${basename(tarball)} instala e roda (--version ${version}, doctor, init, lint, blocks, studio, render, ffprobe)\n`);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 1 || args[0]!.startsWith("-")) {
      throw new VerifyError("E_VERIFY_USAGE", "uso incorreto", "node scripts/verify-release.ts out/release/frankframes-cli-<versão>.tgz");
    }
    await verifyRelease(args[0]!);
  } catch (error) {
    if (error instanceof VerifyError) {
      process.stderr.write(`\n✖ ${error.code}: ${error.message}\n  dica: ${error.hint}\n`);
    } else {
      process.stderr.write(`\n✖ E_VERIFY_UNEXPECTED: ${(error as Error).stack ?? String(error)}\n`);
    }
    process.exitCode = 1;
  }
}
