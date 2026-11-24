// FrankFrames — proprietário. Ver LICENSE na raiz.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { assetPath, browserPlatform, openSession, removeOrWarn, resolveChrome, startServer } from "@frankframes/engine";
import type { Session } from "@frankframes/engine";
import type { BrowserPlatform, GpuMode } from "@frankframes/engine";
import { prepare } from "./render.ts";

const run = promisify(execFile);

export interface GoldenFrame {
  frame: number;
  sha256: string;
  /** PNG do frame, para comparação tolerante quando o hash diverge. */
  png?: Buffer;
}

export interface GoldenBlock {
  name: string;
  durationSeconds: number;
  frames: GoldenFrame[];
}

export interface GoldenManifest {
  engine: { browser: string; gpu: GpuMode; viewport: string };
  blocks: GoldenBlock[];
}

/** Códigos do seletor de goldens por plataforma; entram em `docs/reference/diagnostics.md`. */
export const GOLDEN_ERROR_CODES = ["E_GOLDENS_PLATFORM_MISSING"] as const;

/** Esta plataforma não tem conjunto de goldens: erro com código e `hint`, nunca o conjunto de outra plataforma. */
export class GoldenSetMissingError extends Error {
  readonly code = "E_GOLDENS_PLATFORM_MISSING";
  readonly hint: string;
  constructor(platform: string, arch: string, key: BrowserPlatform | undefined, available: string[]) {
    const have = available.length === 0 ? "nenhum" : available.join(", ");
    const hint =
      key === undefined
        ? `plataformas com goldens: ${have}; esta (${platform}/${arch}) não tem browser pinado, então não há conjunto a gerar`
        : `gere o conjunto no ambiente desta plataforma com \`node scripts/generate-goldens.ts\` (conjuntos existentes: ${have}); não copie o de outra plataforma`;
    super(`E_GOLDENS_PLATFORM_MISSING: sem goldens para ${key ?? `${platform}/${arch}`} (${hint})`);
    this.name = "GoldenSetMissingError";
    this.hint = hint;
  }
}

/** Conjunto de goldens de UMA plataforma: `catalog/goldens/<plataforma>/goldens.json` e `<bloco>/<frame>.png`. */
export interface GoldenSet {
  platform: BrowserPlatform;
  dir: string;
  manifest: GoldenManifest;
  /** PNG de referência de um frame; pode não existir em disco (o chamador trata a ausência). */
  pngPath(block: string, frame: number): string;
}

/** Diretório do conjunto da plataforma (existindo ou não). */
export function goldenDir(catalogDir: string, platform: BrowserPlatform): string {
  return join(catalogDir, "goldens", platform);
}

/**
 * Conjunto de goldens da plataforma do processo (ou do par `platform`/`arch` dado, para teste). Plataforma sem
 * browser pinado ou sem conjunto gerado falha alto (`E_GOLDENS_PLATFORM_MISSING`): nunca pula nem usa outro conjunto.
 */
export async function loadGoldenSet(catalogDir: string, platform: string = process.platform, arch: string = process.arch): Promise<GoldenSet> {
  const key = browserPlatform(platform, arch);
  const available = async (): Promise<string[]> => {
    try {
      return (await readdir(join(catalogDir, "goldens"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  if (key === undefined) throw new GoldenSetMissingError(platform, arch, undefined, await available());
  const dir = goldenDir(catalogDir, key);
  let raw: string;
  try {
    raw = await readFile(join(dir, "goldens.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new GoldenSetMissingError(platform, arch, key, await available());
    throw error;
  }
  return { platform: key, dir, manifest: JSON.parse(raw) as GoldenManifest, pngPath: (block, frame) => join(dir, block, `${frame}.png`) };
}

/** Frames amostrados: começo, meio e fim, sem depender do último frame parcial. */
export function sampleFrames(totalFrames: number): number[] {
  return [0.1, 0.3, 0.5, 0.7, 0.9].map((ratio) => Math.min(totalFrames - 1, Math.round(ratio * (totalFrames - 1))));
}

export async function captureGolden(
  entry: string,
  options: { gpu?: GpuMode; ratios?: number[]; includePng?: boolean } = {},
): Promise<GoldenBlock> {
  // Verificação pode rodar em paralelo; sob carga, exige mais leituras estáveis.
  const shots = Math.max(1, Number(process.env.FRANKFRAMES_GOLDEN_SHOTS) || 5);
  const prepared = await prepare({ entry });
  const server = await startServer(prepared.entryDir, {
    ...(prepared.mediaDir !== undefined ? { mediaRoot: prepared.mediaDir } : {}),
    ...(prepared.manifest !== undefined ? { manifest: prepared.manifest } : {}),
    page: { path: basename(prepared.entry), html: prepared.compiledHtml },
  });
  // O servidor já está de pé: qualquer rejeição daqui para baixo (inclusive do openSession) o fecha.
  let session: Session | undefined;
  try {
    session = await openSession({
      url: `${server.url}${basename(prepared.entry)}`,
      viewport: prepared.viewport,
      gpu: options.gpu ?? "software",
      // Goldens são verificação, não caminho de velocidade: exigem frames estáveis.
      captureShots: shots,
      serverFailures: server.failures,
    });
    const frames: GoldenFrame[] = [];
    const samples = sampleFrames(prepared.totalFrames);

    // Aquecimento: a primeira captura de uma sessão nova ainda carrega estado de
    // composição. Uma rodada no primeiro frame amostrado é descartada.
    await session.seekFrame(samples[0]!, prepared.fps);
    await session.capture();
    void shots;

    for (const frame of samples) {
      await session.seekFrame(frame, prepared.fps);
      const { png, sha256 } = await session.capture();
      frames.push({ frame, sha256, ...(options.includePng === true ? { png } : {}) });
    }
    const errors = session.pageErrors();
    if (errors.length > 0) throw new Error(`erros na página em ${entry}: ${errors[0]}`);
    return { name: basename(prepared.entryDir), durationSeconds: prepared.seconds, frames };
  } finally {
    try {
      await session?.close();
    } finally {
      await server.close();
    }
  }
}

/** Um frame no meio do bloco, como PNG, para thumbnail. */
export async function captureFrameAt(entry: string, ratio = 0.5): Promise<{ png: Buffer; frame: number; totalFrames: number }> {
  const prepared = await prepare({ entry });
  const server = await startServer(prepared.entryDir, {
    ...(prepared.mediaDir !== undefined ? { mediaRoot: prepared.mediaDir } : {}),
    ...(prepared.manifest !== undefined ? { manifest: prepared.manifest } : {}),
    page: { path: basename(prepared.entry), html: prepared.compiledHtml },
  });
  let session: Session | undefined;
  try {
    session = await openSession({
      url: `${server.url}${basename(prepared.entry)}`,
      viewport: prepared.viewport,
      gpu: "software",
      captureShots: 3,
      serverFailures: server.failures,
    });
    const frame = Math.min(prepared.totalFrames - 1, Math.round(ratio * (prepared.totalFrames - 1)));
    await session.seekFrame(frame, prepared.fps);
    const { png } = await session.capture();
    return { png, frame, totalFrames: prepared.totalFrames };
  } finally {
    try {
      await session?.close();
    } finally {
      await server.close();
    }
  }
}

export async function engineSignature(gpu: GpuMode = "software"): Promise<GoldenManifest["engine"]> {
  const chrome = await resolveChrome();
  return { browser: chrome.version, gpu, viewport: "nativo" };
}

/** PSNR médio (dB) entre dois PNGs de mesmo tamanho via FFmpeg; `Infinity` quando idênticos. */
export async function psnr(a: Buffer, b: Buffer): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "ff-golden-"));
  try {
    const left = join(dir, "a.png");
    const right = join(dir, "b.png");
    await writeFile(left, a);
    await writeFile(right, b);
    const ffmpeg = assetPath("ffmpeg", "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    // psnr sai com código 0; qualquer falha do FFmpeg (tamanhos diferentes, PNG ilegível) tem de aparecer.
    const result = await run(ffmpeg, ["-hide_banner", "-i", left, "-i", right, "-lavfi", "[0][1]psnr", "-f", "null", "-"], {
      encoding: "utf8",
    });
    const match = /average:([\d.]+|inf)/.exec(result.stderr);
    if (match === null) throw new Error(`psnr: FFmpeg não devolveu a média: ${result.stderr.slice(-300)}`);
    return match[1] === "inf" ? Infinity : Number(match[1]);
  } finally {
    // O PSNR já está calculado: falha ao remover vira aviso no stderr e não troca o erro do corpo.
    await removeOrWarn(dir);
  }
}
