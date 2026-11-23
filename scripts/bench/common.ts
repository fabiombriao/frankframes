// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Peças compartilhadas pelos benchmarks de captura (`scripts/bench-capture.ts` e `scripts/bench-frame.ts`).
 * Só API pública de `@frankframes/*`; nada aqui altera o produto.
 */
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { detectFfmpeg } from "@frankframes/encode";
import { PINNED_BROWSER, probeRenderer, resolveChrome } from "@frankframes/engine";

const run = promisify(execFile);

export const BENCH_DIR = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export type Scenario = "motion" | "video";
export const SCENARIOS: readonly Scenario[] = ["motion", "video"];

/** Duração e fps do vídeo de origem e do cenário `motion` (fixos nos HTML). */
export const SOURCE_SECONDS = 10;
export const FPS = { num: 30, den: 1 } as const;
export const SOURCE_NAME = "src-1080p.mkv";

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("mediana de lista vazia");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Copia o HTML do cenário para `<outDir>/<cenário>-1080p.html` com a duração pedida. O vídeo de origem mora
 * ao lado (`<outDir>/src-1080p.mkv`), então o `src` relativo do repositório é reescrito para o nome curto.
 */
export async function stageScenario(scenario: Scenario, outDir: string, seconds: number): Promise<string> {
  if (scenario === "video" && seconds > SOURCE_SECONDS) {
    throw new Error(`o vídeo de origem tem ${SOURCE_SECONDS} s: --seconds ${seconds} não cabe no cenário video`);
  }
  const source = await readFile(join(BENCH_DIR, `${scenario}-1080p.html`), "utf8");
  const withDuration = source.replaceAll(`data-duration="${SOURCE_SECONDS}"`, `data-duration="${seconds}"`);
  if (withDuration === source && seconds !== SOURCE_SECONDS) {
    throw new Error(`${scenario}-1080p.html não tem data-duration="${SOURCE_SECONDS}" para trocar`);
  }
  const staged = withDuration.replace("../../out/bench/" + SOURCE_NAME, SOURCE_NAME);
  if (scenario === "video" && !staged.includes(`src="${SOURCE_NAME}"`)) {
    throw new Error("video-1080p.html: o src do vídeo de origem mudou; atualize stageScenario");
  }
  await mkdir(outDir, { recursive: true });
  const target = join(outDir, `${scenario}-1080p.html`);
  await writeFile(target, staged, "utf8");
  return target;
}

/** Gera o vídeo de origem (MJPEG 1080p, 10 s) com o FFmpeg vendorizado, se ainda não existe. Nunca é versionado. */
export async function ensureVideoSource(ffmpeg: string, outDir: string): Promise<string> {
  const target = join(outDir, SOURCE_NAME);
  if (await exists(target)) return target;
  await mkdir(outDir, { recursive: true });
  await run(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=s=1920x1080:r=${FPS.num}:d=${SOURCE_SECONDS}`, "-c:v", "mjpeg", "-q:v", "3", "-y", target],
    { maxBuffer: 16 << 20 },
  );
  return target;
}

export interface MachineInfo {
  cpu: string;
  logicalCores: number;
  availableParallelism: number;
  ramGiB: number;
  os: string;
  node: string;
  chrome: { path: string; version: string; pinned: boolean };
  pinnedBrowserVersion: string;
  /** Renderer reportado pelo Chrome com as flags de hardware (a sonda que decide `auto`). */
  gpuRenderer: string;
  gpuIsHardware: boolean;
  ffmpeg: string;
}

export async function machineInfo(ffmpeg: string): Promise<MachineInfo> {
  const chrome = await resolveChrome();
  const [renderer, facts] = await Promise.all([probeRenderer(chrome.path), detectFfmpeg(ffmpeg)]);
  return {
    cpu: cpus()[0]?.model.trim() ?? "desconhecida",
    logicalCores: cpus().length,
    availableParallelism: availableParallelism(),
    ramGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    os: `${platform()} ${release()}`,
    node: process.version,
    chrome: { path: chrome.path, version: chrome.version, pinned: chrome.pinned },
    pinnedBrowserVersion: PINNED_BROWSER.version,
    gpuRenderer: renderer.renderer,
    gpuIsHardware: renderer.hardware,
    ffmpeg: facts.version.split("\n")[0]?.trim() ?? facts.version,
  };
}

export function stamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
