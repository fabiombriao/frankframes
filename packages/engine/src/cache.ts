// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assetHome } from "./home.ts";
import { extractFrames } from "./media.ts";
import type { ExtractOptions } from "./media.ts";

/** Cache de frames extraídos, endereçado pelo conteúdo da fonte + janela. */
export interface FrameCacheOptions {
  /** Raiz do cache. Padrão: `<assetHome>/cache/frames`. */
  root?: string;
  /** Teto de disco; o mais antigo sai primeiro. Padrão: 2 GiB. */
  maxBytes?: number;
}

export const DEFAULT_FRAME_CACHE_BYTES = 2 * 1024 ** 3;

/** Hash do arquivo em pedaços: não carrega 150 MB na memória. */
export async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function frameCacheKey(input: {
  digest: string;
  fps: { num: number; den: number };
  offset: number;
  duration: number;
}): string {
  const window = `${input.fps.num}/${input.fps.den}@${input.offset.toFixed(3)}-${input.duration.toFixed(3)}`;
  return `${input.digest.slice(0, 16)}-${createHash("sha256").update(window).digest("hex").slice(0, 8)}`;
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir).catch(() => [])) {
    total += await stat(join(dir, entry)).then((info) => info.size).catch(() => 0);
  }
  return total;
}

/** Remove as entradas mais antigas até caber no teto. Nunca falha o render. */
export async function evictCache(root: string, maxBytes: number): Promise<number> {
  const entries = await readdir(root).catch(() => [] as string[]);
  const sized: Array<{ path: string; bytes: number; mtime: number }> = [];
  let total = 0;
  for (const entry of entries) {
    const path = join(root, entry);
    const bytes = await directorySize(path);
    const mtime = await stat(path).then((info) => info.mtimeMs).catch(() => 0);
    total += bytes;
    sized.push({ path, bytes, mtime });
  }
  if (total <= maxBytes) return 0;

  sized.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
  let removed = 0;
  for (const item of sized) {
    if (total <= maxBytes) break;
    await rm(item.path, { recursive: true, force: true }).catch(() => {});
    total -= item.bytes;
    removed += 1;
  }
  return removed;
}

export interface CachedExtraction {
  dir: string;
  frameCount: number;
  hit: boolean;
}

/**
 * Reaproveita frames já extraídos para o mesmo arquivo e a mesma janela.
 * A chave inclui o conteúdo da fonte, então trocar o vídeo invalida sozinho.
 */
export async function extractFramesCached(
  options: ExtractOptions & FrameCacheOptions & { ffmpeg: string; input: string },
): Promise<CachedExtraction> {
  const root = options.root ?? join(assetHome(), "cache", "frames");
  await mkdir(root, { recursive: true });

  const digest = await fileDigest(options.input);
  const key = frameCacheKey({
    digest,
    fps: options.fps,
    offset: options.offset ?? 0,
    duration: options.duration ?? 0,
  });
  const dir = join(root, key);
  const marker = join(dir, ".complete");

  try {
    const frameCount = Number(await readFile(marker, "utf8"));
    if (Number.isInteger(frameCount) && frameCount > 0) return { dir, frameCount, hit: true };
  } catch {
    /* sem marcador: extrai de novo */
  }

  await rm(dir, { recursive: true, force: true });
  const { frameCount } = await extractFrames({ ...options, outDir: dir });
  await writeFile(marker, String(frameCount), "utf8");
  await evictCache(root, options.maxBytes ?? DEFAULT_FRAME_CACHE_BYTES);
  return { dir, frameCount, hit: false };
}
