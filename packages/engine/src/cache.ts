// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { removeOrWarn, removeTree, warnCleanup } from "./cleanup.ts";
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
  const window = `v2:${input.fps.num}/${input.fps.den}@${input.offset.toFixed(3)}-${input.duration.toFixed(3)}`;
  return `${input.digest.slice(0, 16)}-${createHash("sha256").update(window).digest("hex").slice(0, 8)}`;
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir).catch(() => [])) {
    total += await stat(join(dir, entry)).then((info) => info.size).catch(() => 0);
  }
  return total;
}

/**
 * Remove as entradas mais antigas até caber no teto. Nunca falha o render. `inUse` são diretórios que alguém
 * está escrevendo agora (extração em andamento): ficam de fora, mesmo que sejam os mais antigos.
 */
export async function evictCache(root: string, maxBytes: number, inUse: ReadonlySet<string> = new Set()): Promise<number> {
  const entries = await readdir(root).catch(() => [] as string[]);
  const sized: Array<{ path: string; bytes: number; mtime: number }> = [];
  let total = 0;
  for (const entry of entries) {
    const path = join(root, entry);
    const bytes = await directorySize(path);
    total += bytes;
    if (inUse.has(path)) continue;
    const mtime = await stat(path).then((info) => info.mtimeMs).catch(() => 0);
    sized.push({ path, bytes, mtime });
  }
  if (total <= maxBytes) return 0;

  sized.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
  let removed = 0;
  for (const item of sized) {
    if (total <= maxBytes) break;
    // missingOk: outro processo pode ter evictado a mesma entrada entre o readdir e aqui (ENOENT esperado).
    // Outra falha vai ao stderr com o caminho e a entrada NÃO conta como removida (o total não desce).
    const failure = await removeTree(item.path, { missingOk: true });
    if (failure !== undefined) {
      warnCleanup(item.path, failure);
      continue;
    }
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

/** Extrações deste processo, por diretório final: duas chamadas iguais esperam a mesma em vez de brigar pelo disco. */
interface InFlight {
  promise: Promise<CachedExtraction>;
  /** O dono abortou: quem só esperava (sem cancelar) assume a extração em vez de herdar o cancelamento alheio. */
  ownerAborted: () => boolean;
}
const inFlight = new Map<string, InFlight>();
/** Diretórios em escrita agora (finais e temporários): a evicção não toca neles. */
const writing = new Set<string>();

async function readMarker(dir: string): Promise<number | undefined> {
  try {
    const frameCount = Number(await readFile(join(dir, ".complete"), "utf8"));
    return Number.isInteger(frameCount) && frameCount > 0 ? frameCount : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Espera `promise`, mas rejeita já se o chamador cancelar: o cancelamento de quem espera não depende de quem extrai. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("cancelado"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("cancelado"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Extrai para `<dir>.tmp-<pid>-<rand>` e só publica com `rename`: o diretório final nunca existe pela metade, e
 * cancelar (ou falhar) apaga o temporário em vez de deixar um `.complete` falso ou lixo para trás.
 */
async function extractInto(
  options: ExtractOptions & FrameCacheOptions & { ffmpeg: string; input: string },
  root: string,
  dir: string,
): Promise<CachedExtraction> {
  const temp = `${dir}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writing.add(dir);
  writing.add(temp);
  try {
    let frameCount: number;
    try {
      ({ frameCount } = await extractFrames({ ...options, outDir: temp }));
      await writeFile(join(temp, ".complete"), String(frameCount), "utf8");
    } catch (error) {
      // missingOk: se a extração falhou antes de criar o diretório, o temporário nem existe. Falha de remoção vai
      // ao stderr; o erro da extração sobe intacto.
      await removeOrWarn(temp, { missingOk: true });
      throw error;
    }

    // Outro processo pode ter publicado o mesmo diretório enquanto extraíamos: se está completo, vale o dele.
    const existing = await readMarker(dir);
    if (existing !== undefined) {
      // O resultado (hit) não depende da remoção do temporário: falha vira aviso no stderr.
      await removeOrWarn(temp);
      return { dir, frameCount: existing, hit: true };
    }
    // Sem marcador, o que está lá é resto de extração interrompida. force:true: normalmente não há nada (ENOENT
    // esperado); se houver e a remoção falhar, o erro sobe, pois o rename abaixo dependeria dela.
    await rm(dir, { recursive: true, force: true });
    try {
      await rename(temp, dir);
    } catch (error) {
      const raced = await readMarker(dir);
      await removeOrWarn(temp);
      if (raced !== undefined) return { dir, frameCount: raced, hit: true };
      throw error;
    }
    return { dir, frameCount, hit: false };
  } finally {
    writing.delete(dir);
    writing.delete(temp);
  }
}

/**
 * Reaproveita frames já extraídos para o mesmo arquivo e a mesma janela.
 * A chave inclui o conteúdo da fonte, então trocar o vídeo invalida sozinho. Chamadas simultâneas para a mesma
 * chave (renders em lote) compartilham uma extração só.
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

  for (;;) {
    options.signal?.throwIfAborted();
    const frameCount = await readMarker(dir);
    if (frameCount !== undefined) {
      // Usar renova a posição na fila de evicção: o mais antigo sai primeiro, e este acabou de ser usado.
      const now = new Date();
      try {
        await utimes(dir, now, now);
      } catch (error) {
        // A evicção de outro render levou o diretório entre a leitura e a renovação: extrai de novo.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      return { dir, frameCount, hit: true };
    }

    const running = inFlight.get(dir);
    if (running === undefined) {
      const promise = extractInto(options, root, dir);
      const entry: InFlight = { promise, ownerAborted: () => options.signal?.aborted === true };
      inFlight.set(dir, entry);
      try {
        const extracted = await promise;
        await evictCache(root, options.maxBytes ?? DEFAULT_FRAME_CACHE_BYTES, writing);
        return extracted;
      } finally {
        inFlight.delete(dir);
      }
    }

    try {
      const joined = await untilAborted(running.promise, options.signal);
      return { ...joined, hit: true };
    } catch (error) {
      // Falha do dono que foi cancelamento dele: quem esperava não cancelou, então tenta como dono.
      if (options.signal?.aborted === true || !running.ownerAborted()) throw error;
    }
  }
}
