// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Gate Linux (EDT-13): roda o gate do projeto num contêiner Linux descartável, a partir do Windows.
 *
 *   node scripts/linux/gate.ts                       # build da imagem + npm ci + setup + doctor + scripts/ci.ts
 *   node scripts/linux/gate.ts --no-build            # reaproveita a imagem frankframes-linux-gate
 *   node scripts/linux/gate.ts --keep                # não remove o contêiner; imprime o nome
 *   node scripts/linux/gate.ts --skip-setup          # pula `frankframes setup` (assets já vêm de outro lugar)
 *   node scripts/linux/gate.ts --skip-install        # pula `npm ci` (só para testar o próprio gate.ts)
 *   node scripts/linux/gate.ts --only "node scripts/ci.ts --fast"
 *                                                    # no lugar de doctor + ci roda só este comando
 *                                                    # (a cópia, o npm ci e o setup continuam: o contêiner nasce vazio)
 *   node scripts/linux/gate.ts --goldens             # depois do gate, conta goldens idênticos/PSNR/falhas (out/linux/goldens-compare.json)
 *   node scripts/linux/gate.ts --default-seccomp     # mantém o seccomp padrão do Docker (o sandbox do Chrome não sobe)
 *
 * O checkout entra no contêiner por bind mount SOMENTE LEITURA em /src e é copiado para /work com `tar`,
 * sem node_modules, vendor/{ffmpeg,browsers,cache}, out, .git nem .env. O repositório nunca é montado com escrita; o único
 * diretório gravado no host é out/linux/ (ci-report.json e ci-suite.log).
 * Sem shell no host: todo processo sai por `spawn` com argumentos em array.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]+$/, "");
const IMAGE = "frankframes-linux-gate";
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** Prazos por etapa, em ms. Estourar um prazo reprova a etapa (exit 124) e mata a árvore dentro do contêiner. */
const TIMEOUTS = {
  docker: 1 * MINUTE,
  build: 20 * MINUTE,
  start: 2 * MINUTE,
  copiar: 5 * MINUTE,
  "npm ci": 15 * MINUTE,
  setup: 30 * MINUTE,
  doctor: 3 * MINUTE,
  gate: 45 * MINUTE,
  goldens: 20 * MINUTE,
  relatórios: 2 * MINUTE,
  limpeza: 2 * MINUTE,
} as const;

/** Margem para o `timeout` do contêiner agir antes do cronômetro do host (que é só a rede de segurança). */
const HOST_GRACE_MS = 60 * SECOND;

/** Arquivos devolvidos ao host, relativos a /work/out. */
const REPORT_FILES = ["ci-report.json", "ci-suite.log"] as const;
/** Existe quando o gate roda com --goldens (ou quando o --only chama scripts/compare-goldens.ts). */
const GOLDENS_REPORT = "goldens-compare.json";

class GateError extends Error {
  readonly code: string;
  readonly hint: string;
  constructor(code: string, message: string, hint: string) {
    super(`${code}: ${message} (${hint})`);
    this.name = "GateError";
    this.code = code;
    this.hint = hint;
  }
}

interface Options {
  noBuild: boolean;
  keep: boolean;
  skipSetup: boolean;
  skipInstall: boolean;
  defaultSeccomp: boolean;
  goldens: boolean;
  only: string | undefined;
}

function parseOptions(argv: string[]): Options {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        "no-build": { type: "boolean", default: false },
        keep: { type: "boolean", default: false },
        "skip-setup": { type: "boolean", default: false },
        "skip-install": { type: "boolean", default: false },
        "default-seccomp": { type: "boolean", default: false },
        goldens: { type: "boolean", default: false },
        only: { type: "string" },
      },
    });
  } catch (error) {
    throw new GateError("E_GATE_USAGE", (error as Error).message, "flags: --no-build --keep --skip-setup --skip-install --default-seccomp --goldens --only <comando>");
  }
  const only = parsed.values.only;
  if (only !== undefined && only.trim() === "") {
    throw new GateError("E_GATE_USAGE", "--only recebeu comando vazio", 'ex.: --only "node scripts/ci.ts --fast"');
  }
  return {
    noBuild: parsed.values["no-build"] === true,
    keep: parsed.values.keep === true,
    skipSetup: parsed.values["skip-setup"] === true,
    skipInstall: parsed.values["skip-install"] === true,
    defaultSeccomp: parsed.values["default-seccomp"] === true,
    goldens: parsed.values.goldens === true,
    only,
  };
}

interface RunResult {
  code: number;
  timedOut: boolean;
  stdout: string;
}

interface RunOptions {
  /** Repassa stdout/stderr ao terminal em tempo real. */
  live: boolean;
  timeoutMs: number;
}

/** Roda `docker` com argumentos em array. Código 127 = o executável nem abriu; 124 = prazo do host estourou. */
function docker(args: string[], options: RunOptions): Promise<RunResult> {
  const done = Promise.withResolvers<RunResult>();
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let timedOut = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (options.live) process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    // O stderr do docker entra no texto devolvido para as mensagens de erro, e vai ao vivo se pedido.
    stdout += chunk.toString("utf8");
    if (options.live) process.stderr.write(chunk);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);
  child.on("error", (error) => {
    clearTimeout(timer);
    process.stderr.write(`falha ao abrir o docker: ${error.message}\n`);
    done.resolve({ code: 127, timedOut: false, stdout });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    done.resolve({ code: timedOut ? 124 : (code ?? 1), timedOut, stdout });
  });
  return done.promise;
}

/** Etapa de apoio com saída capturada; qualquer código != 0 vira erro com o texto do docker. */
async function dockerOrThrow(step: string, args: string[], timeoutMs: number, hint: string): Promise<string> {
  const result = await docker(args, { live: false, timeoutMs });
  if (result.timedOut) throw new GateError("E_GATE_TIMEOUT", `${step}: prazo de ${Math.round(timeoutMs / SECOND)} s esgotado`, hint);
  if (result.code !== 0) throw new GateError("E_GATE_DOCKER", `${step}: docker saiu com ${result.code}: ${result.stdout.trim()}`, hint);
  return result.stdout;
}

interface StepResult {
  name: string;
  code: number;
  ms: number;
}

/**
 * Executa um comando dentro do contêiner, com saída ao vivo. O prazo é do `timeout` do coreutils
 * dentro do contêiner (mata a árvore inteira); o cronômetro do host só cobre um docker travado.
 */
async function execStep(container: string, name: string, command: string[], timeoutMs: number): Promise<StepResult> {
  process.stdout.write(`\n▶ ${name}  [${command.join(" ")}]\n`);
  const started = Date.now();
  const seconds = Math.ceil(timeoutMs / SECOND);
  const result = await docker(
    ["exec", "--workdir", "/work", container, "timeout", "--kill-after=15", `${seconds}s`, ...command],
    { live: true, timeoutMs: timeoutMs + HOST_GRACE_MS },
  );
  let code = result.code;
  if (code === 124 || code === 137) {
    process.stderr.write(`\n✖ ${name}: prazo de ${seconds} s esgotado; árvore encerrada dentro do contêiner\n`);
    code = 124;
  }
  return { name, code, ms: Date.now() - started };
}

async function checkDocker(): Promise<void> {
  const out = await dockerOrThrow("docker version", ["version", "--format", "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"], TIMEOUTS.docker, "abra o Docker Desktop e espere o daemon subir");
  process.stdout.write(`docker (servidor): ${out.trim()}\n`);
}

async function buildImage(): Promise<void> {
  process.stdout.write(`\n▶ build da imagem ${IMAGE}\n`);
  const result = await docker(["build", "-t", IMAGE, "-f", join(ROOT, "scripts", "linux", "Dockerfile"), join(ROOT, "scripts", "linux")], {
    live: true,
    timeoutMs: TIMEOUTS.build,
  });
  if (result.timedOut) throw new GateError("E_GATE_TIMEOUT", "build da imagem esgotou o prazo", "rode de novo; se persistir, confira a rede do Docker");
  if (result.code !== 0) throw new GateError("E_GATE_BUILD", `docker build saiu com ${result.code}`, "veja a saída acima");
}

/** Sobe o contêiner ocioso com o checkout em /src, somente leitura. */
async function startContainer(name: string, options: Options): Promise<void> {
  // A sintaxe --mount separa por vírgula: um caminho com vírgula quebraria o bind mount em silêncio.
  if (ROOT.includes(",")) throw new GateError("E_GATE_PATH", `o caminho do checkout tem vírgula: ${ROOT}`, "mova o repositório para um caminho sem vírgula");
  // --init: o PID 1 (`sleep infinity`) não colhe filhos órfãos; sem ele todo processo morto pelo gate vira zumbi e `kill(pid, 0)` ainda o acha.
  const args = ["run", "-d", "--init", "--name", name];
  // O seccomp padrão do Docker bloqueia os user namespaces que o sandbox do Chrome usa ("No usable sandbox!").
  if (!options.defaultSeccomp) args.push("--security-opt", "seccomp=unconfined");
  args.push("--mount", `type=bind,source=${ROOT},target=/src,readonly`, IMAGE, "sleep", "infinity");
  await dockerOrThrow("subir o contêiner", args, TIMEOUTS.start, `rode sem --no-build se a imagem ${IMAGE} não existe`);
  process.stdout.write(`contêiner: ${name}\n`);
}

/**
 * Copia /src -> /work sem node_modules (em qualquer nível), vendor/ffmpeg, vendor/browsers, vendor/cache, out, .git e
 * .env*. O `tar` do contêiner lê o bind mount somente leitura; nenhum binário do Windows é reaproveitado (só as
 * fontes OFL, que são dados). `vendor/` existe para o `assetHome()` do projeto escolher /work/vendor (e não ~/.frankframes).
 */
async function copyCheckout(container: string): Promise<StepResult> {
  const script = [
    "set -euo pipefail",
    // vendor/fonts vai junto: os mesmos bytes das fontes nos dois lados (e nenhum download de fonte no contêiner).
    "tar -C /src --exclude='node_modules' --exclude='./vendor/ffmpeg' --exclude='./vendor/browsers' --exclude='./vendor/cache' --exclude='./out' --exclude='./.git' --exclude='./.env' --exclude='./.env.*' -cf - . | tar -C /work -xf -",
    "mkdir -p /work/vendor /work/out",
  ].join("\n");
  return execStep(container, "copiar checkout (/src → /work)", ["bash", "-c", script], TIMEOUTS.copiar);
}

/** Existe o arquivo no contêiner? `test -f`: 0 = sim, 1 = não; qualquer outro código é falha do docker. */
async function containerHasFile(container: string, path: string): Promise<boolean> {
  const result = await docker(["exec", container, "test", "-f", path], { live: false, timeoutMs: TIMEOUTS.relatórios });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new GateError("E_GATE_DOCKER", `test -f ${path} saiu com ${result.code}: ${result.stdout.trim()}`, "o contêiner ainda está de pé? (docker ps -a)");
}

/** Devolve ci-report.json e ci-suite.log para out/linux/ no host, o único diretório gravável. */
async function fetchReports(container: string, options: Options): Promise<string[]> {
  const target = join(ROOT, "out", "linux");
  await mkdir(target, { recursive: true });
  const copied: string[] = [];
  for (const file of [...REPORT_FILES, GOLDENS_REPORT]) {
    if (!(await containerHasFile(container, `/work/out/${file}`))) {
      if (file === GOLDENS_REPORT && !options.goldens) continue;
      process.stderr.write(`aviso: ${file} não existe no contêiner (a etapa que o gera não rodou ou foi pulada)\n`);
      continue;
    }
    await dockerOrThrow(`copiar ${file}`, ["cp", `${container}:/work/out/${file}`, join(target, file)], TIMEOUTS.relatórios, "confira se out/linux/ é gravável");
    copied.push(join(target, file));
  }
  return copied;
}

async function removeContainer(container: string): Promise<void> {
  await dockerOrThrow("remover o contêiner", ["rm", "-f", container], TIMEOUTS.limpeza, `remova à mão: docker rm -f ${container}`);
}

/** Etapas do gate dentro do contêiner, na ordem. Cada uma só roda se a anterior passou. */
function plannedSteps(options: Options): Array<{ name: string; command: string[]; timeoutMs: number }> {
  const steps: Array<{ name: string; command: string[]; timeoutMs: number }> = [];
  if (!options.skipInstall) steps.push({ name: "npm ci", command: ["npm", "ci"], timeoutMs: TIMEOUTS["npm ci"] });
  if (!options.skipSetup) {
    steps.push({ name: "setup (fontes, FFmpeg, browser)", command: ["node", "packages/cli/src/cli.ts", "setup"], timeoutMs: TIMEOUTS.setup });
  }
  if (options.only !== undefined) {
    // `bash -c` roda dentro do contêiner; no host nada passa por shell.
    steps.push({ name: `--only`, command: ["bash", "-c", options.only], timeoutMs: TIMEOUTS.gate });
  } else {
    steps.push({ name: "doctor", command: ["node", "packages/cli/src/cli.ts", "doctor"], timeoutMs: TIMEOUTS.doctor });
    steps.push({ name: "gate (scripts/ci.ts)", command: ["node", "scripts/ci.ts"], timeoutMs: TIMEOUTS.gate });
  }
  // Medição do EDT-13: conta idênticos/PSNR/falhas dos goldens (não regenera nada); o relatório volta para out/linux/.
  if (options.goldens) {
    steps.push({ name: "goldens (scripts/compare-goldens.ts)", command: ["node", "scripts/compare-goldens.ts"], timeoutMs: TIMEOUTS.goldens });
  }
  return steps;
}

let interrupted = false;
process.on("SIGINT", () => {
  // O docker exec local recebe o mesmo Ctrl+C e termina; o laço para e o `finally` remove o contêiner.
  interrupted = true;
});

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  await checkDocker();
  if (!options.noBuild) await buildImage();

  const container = `frankframes-gate-${Date.now()}`;
  await startContainer(container, options);

  const results: StepResult[] = [];
  let exitCode = 0;
  let failure: unknown;
  try {
    const copied = await copyCheckout(container);
    results.push(copied);
    exitCode = copied.code;
    if (exitCode === 0) {
      for (const step of plannedSteps(options)) {
        if (interrupted) {
          exitCode = 130;
          break;
        }
        const result = await execStep(container, step.name, step.command, step.timeoutMs);
        results.push(result);
        if (result.code !== 0) {
          exitCode = result.code;
          process.stderr.write(`\nparando em "${step.name}" (exit ${result.code})\n`);
          break;
        }
      }
    }
  } catch (error) {
    failure = error;
    exitCode = 1;
  }

  // Relatórios e limpeza rodam sempre; o erro de cada um é impresso e vira exit != 0, sem esconder o código da etapa.
  const problems: string[] = [];
  let reports: string[] = [];
  try {
    reports = await fetchReports(container, options);
  } catch (error) {
    problems.push(`relatórios: ${(error as Error).message}`);
  }
  if (options.keep) {
    process.stdout.write(`\ncontêiner mantido: ${container}\n  entrar: docker exec -it ${container} bash\n  remover: docker rm -f ${container}\n`);
  } else {
    try {
      await removeContainer(container);
    } catch (error) {
      problems.push(`limpeza: ${(error as Error).message}`);
    }
  }

  process.stdout.write("\n");
  for (const item of results) {
    process.stdout.write(`${item.code === 0 ? "ok   " : "FALHA"} ${String(item.ms).padStart(8)} ms  ${item.name}${item.code === 0 ? "" : ` — exit ${item.code}`}\n`);
  }
  for (const file of reports) process.stdout.write(`relatório: ${file}\n`);
  if (failure !== undefined) process.stderr.write(`\n${(failure as Error).message}\n`);
  for (const problem of problems) process.stderr.write(`\n✖ ${problem}\n`);
  if (exitCode === 0 && problems.length > 0) exitCode = 1;
  return exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = error instanceof GateError && error.code === "E_GATE_USAGE" ? 2 : 1;
}
