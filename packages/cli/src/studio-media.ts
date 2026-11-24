// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createHash } from "node:crypto";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileSha256, probeDuration, probeVideo } from "@frankframes/engine";
import type { VideoOrientation } from "@frankframes/engine";

export type MediaKind = "video" | "audio" | "img";

const KINDS: Record<string, MediaKind> = {
  ".mp4": "video",
  ".m4v": "video",
  ".mov": "video",
  ".webm": "video",
  ".mkv": "video",
  ".mp3": "audio",
  ".wav": "audio",
  ".m4a": "audio",
  ".aac": "audio",
  ".ogg": "audio",
  ".opus": "audio",
  ".flac": "audio",
  ".png": "img",
  ".jpg": "img",
  ".jpeg": "img",
  ".webp": "img",
  ".gif": "img",
  ".svg": "img",
};

/** Teto de upload: um vídeo de câmera longo cabe; um engano de arquivo não enche o disco. */
export const MAX_MEDIA_BYTES = 4 * 1024 ** 3;
/** Imagem não tem duração própria; entra com este valor e o autor ajusta. */
export const IMAGE_SECONDS = 3;
export const ASSETS_DIR = "assets";

export function mediaKind(name: string): MediaKind | undefined {
  return KINDS[extname(name).toLowerCase()];
}

export function supportedExtensions(): string[] {
  return Object.keys(KINDS);
}

/** Nome seguro para disco e para URL: sem acento, sem espaço, sem caminho. */
export function safeMediaName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const ext = extname(base).toLowerCase();
  const stem = base
    .slice(0, base.length - ext.length)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return `${stem === "" ? "media" : stem}${ext}`;
}

export class MediaUploadError extends Error {
  readonly code: "E_MEDIA_TOO_LARGE" | "E_MEDIA_EMPTY";
  readonly status: number;

  constructor(code: MediaUploadError["code"], status: number, message: string) {
    super(message);
    this.name = "MediaUploadError";
    this.code = code;
    this.status = status;
  }
}

export interface StoredMedia {
  /** Caminho absoluto no disco. */
  file: string;
  /** Caminho relativo à entrada, como vai no `src`. */
  src: string;
  /** `false` quando um arquivo idêntico já existia e foi reaproveitado. */
  created: boolean;
  sha256: string;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Grava o corpo em `<entryDir>/assets/` sem carregar tudo na memória. Conteúdo
 * igual a um arquivo já existente reaproveita o arquivo; nome igual com
 * conteúdo diferente ganha sufixo do hash em vez de sobrescrever.
 */
export async function storeMedia(body: AsyncIterable<Buffer | string>, entryDir: string, name: string): Promise<StoredMedia> {
  const dir = join(entryDir, ASSETS_DIR);
  await mkdir(dir, { recursive: true });
  const fileName = safeMediaName(name);
  const tmp = join(dir, `.upload-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  const hash = createHash("sha256");
  let size = 0;
  const handle = await open(tmp, "wx");
  try {
    for await (const chunk of body) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > MAX_MEDIA_BYTES) {
        throw new MediaUploadError("E_MEDIA_TOO_LARGE", 413, `arquivo acima de ${MAX_MEDIA_BYTES / 1024 ** 3} GiB`);
      }
      hash.update(buffer);
      await handle.write(buffer);
    }
  } catch (error) {
    await handle.close();
    await unlink(tmp);
    throw error;
  }
  await handle.close();
  if (size === 0) {
    await unlink(tmp);
    throw new MediaUploadError("E_MEDIA_EMPTY", 400, "arquivo vazio");
  }

  const sha256 = hash.digest("hex");
  const ext = extname(fileName);
  const candidates = [fileName, `${fileName.slice(0, fileName.length - ext.length)}-${sha256.slice(0, 8)}${ext}`];
  for (const candidate of candidates) {
    const target = join(dir, candidate);
    if (!(await exists(target))) {
      await rename(tmp, target);
      return { file: target, src: `${ASSETS_DIR}/${candidate}`, created: true, sha256 };
    }
    if ((await fileSha256(target)) === sha256) {
      await unlink(tmp);
      return { file: target, src: `${ASSETS_DIR}/${candidate}`, created: false, sha256 };
    }
  }
  await unlink(tmp);
  throw new Error(`não foi possível escolher nome para ${fileName} em ${dir}`);
}

export interface MeasuredMedia {
  /** Segundos; imagem usa `IMAGE_SECONDS`. */
  duration: number;
  /** Só vídeo: rotação e dimensões de exibição (EDT-86), as mesmas que o render usa. */
  orientation?: VideoOrientation;
}

/**
 * Mede a mídia importada com o ffprobe. Vídeo devolve também a orientação de exibição; rotação que o preview e o
 * render não aplicariam igual sobe como `MediaRotationError` (`E_MEDIA_ROTATION`), e o import deve recusar o arquivo.
 */
export async function measureMedia(ffprobe: string, file: string, kind: MediaKind): Promise<MeasuredMedia> {
  if (kind === "img") return { duration: IMAGE_SECONDS };
  if (kind === "audio") return { duration: await probeDuration(ffprobe, file) };
  const { duration, rotation, mirrored, displayWidth, displayHeight } = await probeVideo(ffprobe, file);
  return { duration, orientation: { rotation, mirrored, displayWidth, displayHeight } };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const FILL = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain";

/** Marcação do clip novo; mídia visual ocupa o quadro inteiro. */
export function mediaMarkup(kind: MediaKind, id: string, src: string, start: number, duration: number): string {
  const common = `data-clip-id="${escapeAttribute(id)}" src="${escapeAttribute(src)}" data-start="${start}" data-duration="${duration}"`;
  if (kind === "audio") return `<audio ${common}></audio>`;
  if (kind === "img") return `<img ${common} alt="" style="${FILL}">`;
  return `<video ${common} style="${FILL}"></video>`;
}
