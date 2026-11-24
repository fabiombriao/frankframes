// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Gate local de integração — o CI deste projeto.
 *
 *   node scripts/ci.ts            # typecheck + testes + doctor + render de fumaça
 *   node scripts/ci.ts --fast     # só typecheck e testes rápidos (pré-push)
 *   node scripts/ci.ts --release  # inclui build do tarball, avisos de terceiros e instalação real do tgz
 *
 * Sem serviço externo, sem container: roda na máquina que já tem os assets.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./stage.ts";
import { guardTempLeaks } from "./test-support/temp-leaks.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fast = process.argv.includes("--fast");
const release = process.argv.includes("--release");

const FAST_TESTS = [
  "packages/contract/test/contract.test.ts",
  "packages/contract/test/motion.test.ts",
  "packages/encode/test/policy.test.ts",
  "packages/transcribe/test/openai.test.ts",
  "packages/transcribe/test/resolve.test.ts",
  "packages/catalog/test/catalog.test.ts",
  "packages/catalog/test/motion-thumbs.test.ts",
  "packages/producer/test/compile.test.ts",
  "packages/producer/test/motion-compile.test.ts",
  "packages/producer/test/plan.test.ts",
  "packages/producer/test/audio.test.ts",
  "packages/producer/test/keyframes-edit.test.ts",
  "packages/producer/test/preview-audio.test.ts",
  "packages/cli/test/timeline-math.test.ts",
  "packages/cli/test/studio-composition.test.ts",
  "packages/cli/test/studio-export.test.ts",
  "packages/cli/test/studio-inspector.test.ts",
  "packages/cli/test/studio-player-fit.test.ts",
  "packages/cli/test/temp-leaks.test.ts",
  "packages/engine/test/clock.test.ts",
  "packages/engine/test/motion-runtime.test.ts",
  "packages/engine/test/preview-logic.test.ts",
];

interface StageResult {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

function commandLine(command: string, args: string[]): { file: string; args: string[]; shell: boolean } {
  // No Windows, npm/npx só existem como .cmd: spawn direto falha com EINVAL.
  if (process.platform === "win32" && (command === "npm" || command === "npx")) {
    return { file: "cmd", args: ["/c", command, ...args], shell: false };
  }
  return { file: command, args, shell: false };
}

/** Prazos por etapa, em ms. Estourar um deles reprova a etapa e mata a árvore de processos dela. */
const MINUTE = 60_000;
const TIMEOUTS = {
  política: 1 * MINUTE,
  typecheck: 5 * MINUTE,
  "testes rápidos": 5 * MINUTE,
  "suíte completa": 25 * MINUTE,
  doctor: 3 * MINUTE,
  "render de fumaça": 10 * MINUTE,
  "build release": 5 * MINUTE,
  avisos: 2 * MINUTE,
  "instalar tarball": 15 * MINUTE,
} as const;

async function stage(
  name: string,
  command: string,
  args: string[],
  timeoutMs: number,
  logFile?: string,
): Promise<StageResult> {
  const started = Date.now();
  const { file, args: spawnArgs } = commandLine(command, args);
  process.stdout.write(`\n▶ ${name}\n`);

  const run = await runCommand({
    file,
    args: spawnArgs,
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: "1" },
    timeoutMs,
    ...(logFile === undefined ? {} : { logFile: join(ROOT, logFile) }),
  });

  if (run.timedOut) {
    const seconds = Math.round(timeoutMs / 1000);
    process.stderr.write(
      `\n✖ ${name}: prazo de ${seconds} s esgotado; árvore de processos encerrada. Fim da saída da etapa:\n${run.tail}\n`,
    );
    return { name, ok: false, ms: Date.now() - started, detail: `prazo de ${seconds} s esgotado${logFile === undefined ? "" : ` (log completo em ${logFile})`}` };
  }
  return { name, ok: run.code === 0, ms: Date.now() - started, ...(run.code === 0 ? {} : { detail: `exit ${run.code}` }) };
}

async function ffprobeSummary(): Promise<StageResult> {
  const started = Date.now();
  const ffprobe = join(ROOT, "vendor", "ffmpeg", "bin", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  if (!existsSync(ffprobe)) {
    return { name: "verificar MP4", ok: false, ms: 0, detail: `ffprobe ausente em ${ffprobe}` };
  }
  const probed = Promise.withResolvers<{ code: number; text: string }>();
  const child = spawn(ffprobe, ["-v", "error", "-show_entries", "stream=codec_name,nb_frames", "-of", "default=nw=1", join(ROOT, "out", "ci.mp4")]);
  let text = "";
  child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
  child.on("error", () => probed.resolve({ code: 127, text: "" }));
  child.on("exit", (code) => probed.resolve({ code: code ?? 1, text }));
  const output = await probed.promise;
  const ok = output.code === 0 && /codec_name=av1/.test(output.text) && /nb_frames=90/.test(output.text);
  return {
    name: "verificar MP4",
    ok,
    ms: Date.now() - started,
    ...(ok ? { detail: "av1, 90 frames" } : { detail: output.text.replace(/\n/g, " ").slice(0, 160) }),
  };
}

const stages: StageResult[] = [];
await mkdir(join(ROOT, "out"), { recursive: true });

stages.push(await stage("política", process.execPath, ["scripts/check-policy.ts"], TIMEOUTS.política));
if (!stages.at(-1)?.ok) {
  process.stderr.write("\nparando na política\n");
  process.exit(1);
}

stages.push(await stage("typecheck", "npx", ["tsc", "--noEmit"], TIMEOUTS.typecheck));
if (!stages.at(-1)?.ok) {
  process.stderr.write("\nparando no typecheck\n");
  process.exit(1);
}

// EDT-82: etapas que rodam testes não podem deixar `ff-*` novo em os.tmpdir() (os antigos são tolerados).
stages.push(await guardTempLeaks("testes rápidos", () => stage("testes rápidos", process.execPath, ["--test", ...FAST_TESTS], TIMEOUTS["testes rápidos"])));

if (!fast) {
  const full = await guardTempLeaks("suíte completa", () =>
    stage("suíte completa", process.execPath, ["--test", "--test-concurrency=1", "packages/*/test/*.test.ts"], TIMEOUTS["suíte completa"], "out/ci-suite.log"),
  );
  stages.push(full);
  if (full.ok) {
    stages.push(await stage("doctor", process.execPath, ["packages/cli/src/cli.ts", "doctor"], TIMEOUTS.doctor));
    stages.push(await stage("render de fumaça", process.execPath, ["packages/cli/src/cli.ts", "render", "examples/hello.html", "-o", "out/ci.mp4", "--preset", "draft", "--workers", "2"], TIMEOUTS["render de fumaça"]));
    if (stages.at(-1)?.ok) stages.push(await ffprobeSummary());
  }
}

if (release) {
  // Tarball único @frankframes/cli (EDT-65): build compilado, avisos de terceiros e instalação de verdade.
  const cliManifest = JSON.parse(readFileSync(join(ROOT, "packages", "cli", "package.json"), "utf8")) as { version: string };
  const tarball = `out/release/frankframes-cli-${cliManifest.version}.tgz`;
  const built = await stage("build release", process.execPath, ["scripts/build-release.ts"], TIMEOUTS["build release"]);
  stages.push(built);
  stages.push(await stage("avisos", process.execPath, ["scripts/third-party.ts", "--check"], TIMEOUTS.avisos));
  // Sem tarball não há o que instalar: a etapa seguinte só roda se o build passou.
  if (built.ok) stages.push(await stage("instalar tarball", process.execPath, ["scripts/verify-release.ts", tarball], TIMEOUTS["instalar tarball"]));
}

const failed = stages.filter((item) => !item.ok);
const total = stages.reduce((sum, item) => sum + item.ms, 0);

process.stdout.write("\n");
for (const item of stages) {
  const status = item.ok ? "ok  " : "FALHA";
  process.stdout.write(`${status} ${String(item.ms).padStart(6)} ms  ${item.name}${item.detail ? ` — ${item.detail}` : ""}\n`);
}
process.stdout.write(`\ntotal ${(total / 1000).toFixed(1)}s · ${stages.length - failed.length}/${stages.length} etapas\n`);

await writeFile(
  join(ROOT, "out", "ci-report.json"),
  `${JSON.stringify({ ok: failed.length === 0, fast, release, totalMs: total, stages }, null, 2)}\n`,
);

process.exit(failed.length === 0 ? 0 : 1);
