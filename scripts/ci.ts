// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Gate local de integração — o CI deste projeto.
 *
 *   node scripts/ci.ts            # typecheck + testes + doctor + render de fumaça
 *   node scripts/ci.ts --fast     # só typecheck e testes rápidos (pré-push)
 *   node scripts/ci.ts --release  # inclui `npm pack --dry-run` de todos os pacotes
 *
 * Sem serviço externo, sem container: roda na máquina que já tem os assets.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fast = process.argv.includes("--fast");
const release = process.argv.includes("--release");

const FAST_TESTS = [
  "packages/contract/test/contract.test.ts",
  "packages/encode/test/policy.test.ts",
  "packages/transcribe/test/openai.test.ts",
  "packages/transcribe/test/resolve.test.ts",
  "packages/catalog/test/catalog.test.ts",
  "packages/producer/test/compile.test.ts",
  "packages/producer/test/plan.test.ts",
  "packages/producer/test/audio.test.ts",
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

async function stage(name: string, command: string, args: string[], logFile?: string): Promise<StageResult> {
  const started = Date.now();
  const { file, args: spawnArgs } = commandLine(command, args);
  process.stdout.write(`\n▶ ${name}\n`);

  const finished = Promise.withResolvers<number>();
  const sink = logFile === undefined ? undefined : createWriteStream(join(ROOT, logFile));
  const child = spawn(file, spawnArgs, {
    cwd: ROOT,
    stdio: sink === undefined ? "inherit" : ["inherit", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  if (sink !== undefined) {
    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      sink.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      sink.write(chunk);
    });
    child.on("exit", () => sink.end());
  }
  child.on("error", () => finished.resolve(127));
  child.on("exit", (value) => finished.resolve(value ?? 1));
  const code = await finished.promise;

  return { name, ok: code === 0, ms: Date.now() - started, ...(code === 0 ? {} : { detail: `exit ${code}` }) };
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

stages.push(await stage("política", process.execPath, ["scripts/check-policy.ts"]));
if (!stages.at(-1)?.ok) {
  process.stderr.write("\nparando na política\n");
  process.exit(1);
}

stages.push(await stage("typecheck", "npx", ["tsc", "--noEmit"]));
if (!stages.at(-1)?.ok) {
  process.stderr.write("\nparando no typecheck\n");
  process.exit(1);
}

stages.push(await stage("testes rápidos", process.execPath, ["--test", ...FAST_TESTS]));

if (!fast) {
  const full = await stage("suíte completa", process.execPath, ["--test", "--test-concurrency=1", "packages/*/test/*.test.ts"], "out/ci-suite.log");
  stages.push(full);
  if (full.ok) {
    stages.push(await stage("doctor", process.execPath, ["packages/cli/src/cli.ts", "doctor"]));
    stages.push(await stage("render de fumaça", process.execPath, ["packages/cli/src/cli.ts", "render", "examples/hello.html", "-o", "out/ci.mp4", "--preset", "draft", "--workers", "2"]));
    if (stages.at(-1)?.ok) stages.push(await ffprobeSummary());
  }
}

if (release) {
  for (const workspace of ["contract", "encode", "engine", "producer", "transcribe", "catalog", "cli"]) {
    stages.push(await stage(`pack ${workspace}`, "npm", ["pack", "--dry-run", "-w", `@frankframes/${workspace}`]));
  }
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
