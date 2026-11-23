// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Benchmark de render ponta a ponta (EDT-62). Não muda o produto: só chama `renderComposition` e
 * carimba o tempo de cada estágio pelo `onProgress`.
 *
 *   node scripts/bench-capture.ts [--label baseline] [--presets draft,standard,high] [--gpu auto,software]
 *                                 [--workers 2,4,6,8|default] [--runs 3] [--seconds 10]
 *                                 [--scenario motion,video] [--out out/bench]
 *
 * Saída: `<out>/<label>-<AAAAMMDD-HHMM>.json` e uma tabela Markdown no stdout.
 * Rode com a máquina parada (nada de gate, outro render ou sincronização pesada ao mesmo tempo).
 */
import { rm, mkdir, stat, writeFile, access } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Preset } from "@frankframes/encode";
import { assetPath, fileDigest, frameCacheKey, resolveGpuMode, resolveChrome } from "@frankframes/engine";
import { renderComposition, resolveFfmpeg } from "@frankframes/producer";
import type { RenderStage } from "@frankframes/producer";
import { FPS, REPO_ROOT, SCENARIOS, SOURCE_NAME, dirSize, ensureVideoSource, machineInfo, median, stageScenario, stamp } from "./bench/common.ts";
import type { MachineInfo, Scenario } from "./bench/common.ts";

const STAGES: readonly RenderStage[] = ["compile", "probe", "extract", "capture", "audio", "encode", "assemble"];
const PRESETS: readonly Preset[] = ["draft", "standard", "high"];

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "baseline" },
    presets: { type: "string", default: PRESETS.join(",") },
    gpu: { type: "string", default: "auto,software" },
    workers: { type: "string", default: "default" },
    runs: { type: "string", default: "3" },
    seconds: { type: "string", default: "10" },
    scenario: { type: "string", default: SCENARIOS.join(",") },
    out: { type: "string", default: "out/bench" },
  },
  strict: true,
});

function list(raw: string): string[] {
  return raw.split(",").map((item) => item.trim()).filter((item) => item !== "");
}

function oneOf<T extends string>(items: string[], allowed: readonly T[], flag: string): T[] {
  for (const item of items) {
    if (!(allowed as readonly string[]).includes(item)) throw new Error(`--${flag}: "${item}" inválido (use ${allowed.join(", ")})`);
  }
  return items as T[];
}

function positive(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${flag} precisa ser um número positivo (recebi "${raw}")`);
  return value;
}

const label = values.label!;
if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error(`--label "${label}" só aceita letras, dígitos, ponto, hífen e sublinhado`);
const presets = oneOf(list(values.presets!), PRESETS, "presets");
const gpus = oneOf(list(values.gpu!), ["auto", "software", "hardware"] as const, "gpu");
const scenarios = oneOf(list(values.scenario!), SCENARIOS, "scenario");
const workerList: Array<number | "default"> = list(values.workers!).map((item) => (item === "default" ? "default" : Math.floor(positive(item, "workers"))));
const runs = Math.floor(positive(values.runs!, "runs"));
const seconds = positive(values.seconds!, "seconds");
// Relativo à raiz do repositório (absoluto vale como está): `--out %TEMP%\ff-bench` tira o ruído do Sync.
const outDir = resolve(REPO_ROOT, values.out!);
if (presets.length === 0 || gpus.length === 0 || scenarios.length === 0 || workerList.length === 0) {
  throw new Error("--presets, --gpu, --scenario e --workers não podem ficar vazios");
}

/**
 * Réplica da fórmula de `defaultWorkerCount` (packages/engine/src/parallel.ts, não exportada): só para
 * registrar quantos workers o `default` significa nesta máquina. Se a fórmula do motor mudar, atualize aqui.
 */
function defaultWorkers(): number {
  const byCpu = Math.max(1, Math.floor(availableParallelism() / 2));
  const byMemory = Math.max(1, Math.floor(totalmem() / (768 * 1024 * 1024)));
  return Math.max(2, Math.min(8, byCpu, byMemory));
}

interface RunRecord {
  scenario: Scenario;
  gpuRequested: string;
  gpuEffective: "software" | "hardware";
  preset: Preset;
  workers: number | "default";
  workersEffective: number;
  run: number;
  /** `true` só na primeira execução do cenário video, com a entrada do cache de frames apagada antes. */
  coldCache: boolean | null;
  frames: number;
  sTotal: number;
  stageSeconds: Record<RenderStage, number>;
  sCapture: number;
  sEncode: number;
  captureFps: number;
  sPerMinute: number;
  outputBytes: number;
  /** Tamanho do workDir ao fim do render (frames PNG + vídeo + áudio): o pico de disco. */
  peakWorkDirBytes: number;
  warnings: string[];
}

/** Segundos de cada estágio: do primeiro evento dele até o primeiro evento do seguinte (ou o fim do render). */
function stageDurations(marks: Array<{ stage: RenderStage; t: number }>, end: number): Record<RenderStage, number> {
  const result = Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<RenderStage, number>;
  const firsts: Array<{ stage: RenderStage; t: number }> = [];
  for (const mark of marks) {
    if (!firsts.some((item) => item.stage === mark.stage)) firsts.push(mark);
  }
  firsts.forEach((item, index) => {
    const next = firsts[index + 1]?.t ?? end;
    result[item.stage] = (next - item.t) / 1000;
  });
  return result;
}

const pair = await resolveFfmpeg();
const machine: MachineInfo = await machineInfo(pair.ffmpeg);
const chrome = await resolveChrome();
const autoResolved = await resolveGpuMode("auto", chrome.path);

await mkdir(outDir, { recursive: true });
const tmpDir = join(outDir, "run-tmp");
await mkdir(tmpDir, { recursive: true });

const entries = new Map<Scenario, string>();
for (const scenario of scenarios) {
  if (scenario === "video") await ensureVideoSource(pair.ffmpeg, outDir);
  entries.set(scenario, await stageScenario(scenario, outDir, seconds));
}

const records: RunRecord[] = [];
const seen = new Set<string>();
const jsonPath = join(outDir, `${label}-${stamp()}.json`);

async function save(complete: boolean): Promise<void> {
  const document = { label, complete, startedAt: new Date().toISOString(), seconds, runs, machine, defaultWorkers: defaultWorkers(), autoResolvesTo: autoResolved, outDir, records };
  await writeFile(jsonPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

for (const scenario of scenarios) {
  const entry = entries.get(scenario)!;
  for (const gpu of gpus) {
    // Composição com vídeo força software mesmo em `auto` (render.ts): o modo efetivo é o que conta.
    const effective: "software" | "hardware" = gpu === "auto" ? (scenario === "video" ? "software" : autoResolved) : gpu;
    for (const workers of workerList) {
      for (const preset of presets) {
        const key = `${scenario}|${effective}|${workers}|${preset}`;
        if (seen.has(key)) {
          process.stderr.write(`· ${scenario} gpu=${gpu} (${effective}) ${preset}: igual a uma combinação já medida, pulada\n`);
          continue;
        }
        seen.add(key);

        for (let run = 0; run < runs; run += 1) {
          let coldCache: boolean | null = null;
          if (scenario === "video") {
            // Execução 1 com cache frio: apaga a entrada do cache de frames deste vídeo/janela antes.
            const cacheRoot = assetPath("cache", "frames");
            const sourcePath = join(outDir, SOURCE_NAME);
            const cacheDir = join(cacheRoot, frameCacheKey({ digest: await fileDigest(sourcePath), fps: FPS, offset: 0, duration: seconds }));
            coldCache = run === 0;
            if (coldCache) await rm(cacheDir, { recursive: true, force: true });
          }

          const outPath = join(tmpDir, `${scenario}-${effective}-${preset}-${run + 1}.mp4`);
          const marks: Array<{ stage: RenderStage; t: number }> = [];
          const started = performance.now();
          const result = await renderComposition({
            entry,
            outPath,
            gpu,
            preset,
            codec: "av1",
            ffmpeg: pair.ffmpeg,
            ffprobe: pair.ffprobe,
            ...(workers === "default" ? {} : { workers }),
            // O workDir fica até eu medi-lo (depois do relógio parar) e só então é removido.
            keepWorkDir: true,
            onProgress: (stage) => marks.push({ stage, t: performance.now() - started }),
          });
          const end = performance.now() - started;
          // Os frames só saem do disco no fim do render, e o vídeo codificado entra por último: o tamanho final do
          // workDir (frames + vídeo + áudio) é o pico de disco do render.
          const peakWorkDirBytes = await dirSize(result.workDir);
          await rm(result.workDir, { recursive: true, force: true });

          if (scenario === "video") {
            // Confere que a chave de cache calculada aqui é a do render: sem isso "frio/quente" seria chute.
            const marker = join(assetPath("cache", "frames"), frameCacheKey({ digest: await fileDigest(join(outDir, SOURCE_NAME)), fps: FPS, offset: 0, duration: seconds }), ".complete");
            await access(marker).catch(() => {
              throw new Error(`entrada de cache esperada ausente (${marker}): a chave de cache do benchmark não confere com a do render`);
            });
          }

          const stageSeconds = stageDurations(marks, end);
          const sTotal = end / 1000;
          const videoSeconds = result.frames / (FPS.num / FPS.den);
          const sCapture = stageSeconds.capture;
          const record: RunRecord = {
            scenario,
            gpuRequested: gpu,
            gpuEffective: effective,
            preset,
            workers,
            workersEffective: workers === "default" ? defaultWorkers() : workers,
            run: run + 1,
            coldCache,
            frames: result.frames,
            sTotal,
            stageSeconds,
            sCapture,
            sEncode: stageSeconds.encode,
            captureFps: result.frames / sCapture,
            sPerMinute: sTotal / (videoSeconds / 60),
            outputBytes: (await stat(outPath)).size,
            peakWorkDirBytes,
            warnings: result.warnings,
          };
          records.push(record);
          await rm(outPath, { force: true });
          await save(false);
          process.stderr.write(
            `· ${scenario} gpu=${gpu}→${effective} ${preset} workers=${workers} run ${run + 1}/${runs}${coldCache === true ? " (frio)" : ""}: ` +
              `${sTotal.toFixed(1)} s total, captura ${sCapture.toFixed(1)} s (${record.captureFps.toFixed(1)} fps), encode ${record.sEncode.toFixed(1)} s\n`,
          );
        }
      }
    }
  }
}

await save(true);
await rm(tmpDir, { recursive: true, force: true });

interface Group {
  scenario: Scenario;
  gpu: string;
  preset: Preset;
  workers: string;
  cache: string;
  items: RunRecord[];
}

const groups = new Map<string, Group>();
for (const record of records) {
  const cache = record.coldCache === null ? "—" : record.coldCache ? "frio" : "quente";
  const key = `${record.scenario}|${record.gpuEffective}|${record.workers}|${record.preset}|${cache}`;
  const group = groups.get(key) ?? { scenario: record.scenario, gpu: record.gpuEffective, preset: record.preset, workers: String(record.workers), cache, items: [] };
  group.items.push(record);
  groups.set(key, group);
}

function stat3(values: number[], digits = 1): string {
  const fixed = (value: number): string => value.toFixed(digits);
  return values.length === 1 ? fixed(values[0]!) : `${fixed(median(values))} (${fixed(Math.min(...values))}–${fixed(Math.max(...values))})`;
}

const lines = [
  `### ${label} — ${machine.cpu}, ${machine.logicalCores} threads, ${machine.ramGiB} GiB, GPU: ${machine.gpuRenderer}`,
  "",
  "Mediana (mín–máx) das execuções. `captureFps` e `s_capture` incluem abrir o Chrome e a prontidão da página.",
  "",
  "| cenário | GPU efetiva | workers | preset | cache | n | s_total | s_capture | captureFps | s/min | s_encode | pico workDir (MB) |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
];
for (const group of groups.values()) {
  const pick = (selector: (record: RunRecord) => number, digits?: number): string => stat3(group.items.map(selector), digits);
  lines.push(
    `| ${group.scenario} | ${group.gpu} | ${group.workers} | ${group.preset} | ${group.cache} | ${group.items.length} | ${pick((r) => r.sTotal)} | ${pick((r) => r.sCapture)} | ${pick((r) => r.captureFps)} | ${pick((r) => r.sPerMinute)} | ${pick((r) => r.sEncode)} | ${pick((r) => r.peakWorkDirBytes / 1_000_000, 0)} |`,
  );
}
process.stdout.write(`${lines.join("\n")}\n\nJSON: ${jsonPath}\n`);
