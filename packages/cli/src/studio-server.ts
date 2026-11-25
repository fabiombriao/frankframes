// FrankFrames — proprietário. Ver LICENSE na raiz.
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { statIfPresent } from "./fs-util.ts";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describePresets, listPresets, loadComposition, parseComposition, parseMotionValue } from "@frankframes/contract";
import type { MotionKind, MotionSource, ResolvedClip } from "@frankframes/contract";
import { MediaRotationError, assetPath, injectEngine, warnCleanup } from "@frankframes/engine";
import type { PreviewAudioConfig, VideoOrientation } from "@frankframes/engine";
import {
  applyPatches,
  applyTransition,
  editCaptionText,
  editKeyframes,
  EditError,
  explicitClipIds,
  hasCaptionMeta,
  mergeKeyframePoints,
  compileComposition,
  prepare,
  PreviewAudioError,
  readCaptionFile,
  renderPreviewAudio,
  resolveFfmpeg,
  splitClip,
  deleteClip,
  duplicateClip,
  editComposition,
  trimClipStart,
} from "@frankframes/producer";
import type { ClipPatch, CompositionPatch, FfmpegPair, KeyframeRequest, PreparedComposition } from "@frankframes/producer";
import { UnknownBlockError, installBlock, listBlocks, motionThumbPath } from "@frankframes/catalog";
import { ExportError, createExporter } from "./studio-export.ts";
import { HistoryStaleError, StudioHistory } from "./studio-history.ts";
import { WaveformError, waveformFor } from "./studio-waveform.ts";
import {
  BLOCKS_DIR,
  COMPOSITIONS_DIR,
  IMAGE_SECONDS,
  MediaUploadError,
  isSubCompositionFile,
  measureMedia,
  mediaKind,
  mediaMarkup,
  storeMedia,
  subCompositionMarkup,
  supportedExtensions,
} from "./studio-media.ts";

export interface StudioServer {
  url: string;
  close: () => Promise<void>;
}

export interface StudioOptions {
  entry: string;
  port?: number;
  /** Cache dos mixes de preview; padrão `cache/preview-audio` do FRANKFRAMES_HOME. */
  audioCacheDir?: string;
  /** Cache das waveforms; padrão `cache/waveform` do FRANKFRAMES_HOME. */
  waveformCacheDir?: string;
}

const STUDIO_DIR = fileURLToPath(new URL("./studio/", import.meta.url));
const STUDIO_FILES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/timeline-math.js": "timeline-math.js",
  "/motion.js": "motion.js",
  "/composition.js": "composition.js",
  "/inspector.js": "inspector.js",
  "/player-fit.js": "player-fit.js",
  "/style.css": "style.css",
};
const MEDIA_PREFIX = "/__ff_media/";
/** Miniaturas GIF dos presets de motion (`<preset>.gif`), do catálogo. */
const MOTION_PREFIX = "/__ff_motion/";
const MOTION_KINDS: readonly MotionKind[] = ["enter", "exit", "emphasis", "camera", "transition"];
const FONTS_PREFIX = "/__ff_fonts/";
const AUDIO_PREFIX = "/__ff_audio/";
const AUDIO_NAME = /^[0-9a-f]{64}\.wav$/;
/** Arquivos do projeto (ex.: `assets/`) vistos pelo preview via `<base>`. */
const SITE_PREFIX = "/__ff_site/";
const MAX_BODY_BYTES = 1024 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/** Erro com status HTTP e código estável; nunca vira 200. */
class ReplyError extends Error {
  readonly status: number;
  readonly code: string;
  readonly diagnostics?: unknown;

  constructor(status: number, code: string, message: string, diagnostics?: unknown) {
    super(message);
    this.name = "ReplyError";
    this.status = status;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

function send(res: ServerResponse, status: number, body: string | Buffer, contentType: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, `${JSON.stringify(value)}\n`, "application/json; charset=utf-8");
}

/** Resolve `relative` abaixo de `root`; `undefined` quando escapa da raiz. */
function inside(root: string, relative: string): string | undefined {
  const target = resolve(root, relative);
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep) ? target : undefined;
}

/** Erro cujo `hint` acionável chega ao Studio dentro de `diagnostics`. */
function hintedError(status: number, code: string, message: string, hint: string | undefined): ReplyError {
  return new ReplyError(status, code, message, [{ code, severity: "error", message, ...(hint === undefined ? {} : { hint }) }]);
}

/** Roda uma leitura ou edição de legendas e devolve a recusa do producer com o código e o hint dela. */
function captionsStep<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (!(error instanceof EditError)) throw error;
    throw hintedError(error.code === "E_CAPTIONS_CUE_NOT_FOUND" ? 404 : 400, error.code, error.message, error.hint);
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "E_STUDIO";
}

async function bodyJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ReplyError(413, "E_BODY_TOO_LARGE", "corpo acima de 1 MB");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let text: string;
  try {
    text = Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    throw new ReplyError(400, "E_BODY_INVALID", `corpo ilegível: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ReplyError(400, "E_BODY_INVALID", `corpo não é JSON válido: ${(error as Error).message}`);
  }
}

function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ReplyError(400, "E_BODY_INVALID", "corpo precisa ser um objeto JSON");
  }
  return body as Record<string, unknown>;
}

interface FlatClip {
  clip: ResolvedClip;
  /** Id do clip pai (host de sub-composição) ou `null` na raiz. */
  parentId: string | null;
}

function flattenClips(clips: ResolvedClip[]): FlatClip[] {
  const out: FlatClip[] = [];
  const visit = (list: ResolvedClip[], parentId: string | null): void => {
    for (const clip of list) {
      out.push({ clip, parentId });
      visit(clip.children, clip.id);
    }
  };
  visit(clips, null);
  return out;
}

/** Um atributo de motion como o Studio o mostra: texto bruto e, se a gramática fecha, preset e chaves. */
interface MotionEntry {
  raw: string;
  /** `null` quando o texto não segue `preset chave=valor` (o contrato aponta o erro). */
  preset: string | null;
  params: Record<string, string>;
}

/**
 * Motion do elemento do próprio clip (ordinal 0) para o inspetor. Fonte passiva (só `style`, sem atributo)
 * não tem chave em `attrs`, então não vira entrada. Leitura apenas: a escrita passa por `POST /api/clips/<id>`.
 */
function motionOf(source: MotionSource): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kind of MOTION_KINDS) {
    const raw = source.attrs[kind];
    if (raw === undefined) continue;
    const parsed = parseMotionValue(raw);
    const entry: MotionEntry = parsed.ok ? { raw, preset: parsed.preset, params: parsed.params } : { raw, preset: null, params: {} };
    out[kind] = entry;
  }
  if (source.split !== undefined) {
    const { mode, order, stagger, explicit } = source.split;
    out["split"] = { mode, order, stagger, explicit };
  }
  return out;
}

/**
 * `transition` ganha a sobreposição (`dur`, o deslocamento negativo de `data-start`) e o parceiro A (o id
 * referenciado). Só leitura: a escrita é `POST /api/clips/<id>/transition`.
 */
function withTransition(motion: Record<string, unknown>, clip: ResolvedClip): Record<string, unknown> {
  const entry = motion["transition"] as MotionEntry | undefined;
  if (entry === undefined) return motion;
  const expr = clip.startExpr;
  return {
    ...motion,
    transition: {
      ...entry,
      dur: expr.kind === "reference" && expr.offset < 0 ? Math.round(-expr.offset * 1e6) / 1e6 : null,
      partner: expr.kind === "reference" ? expr.refId : null,
    },
  };
}

/** Tipo de linha na timeline: áudio; vídeo (inclui imagem e sub-composição); texto para o resto. */
function clipKind(clip: ResolvedClip): "audio" | "video" | "text" {
  if (clip.tag === "audio") return "audio";
  if (clip.tag === "video" || clip.tag === "img" || clip.isSubComposition) return "video";
  return "text";
}

function clipDuration(clip: ResolvedClip): number | null {
  if (clip.authoredDuration !== undefined) return clip.authoredDuration;
  if (clip.start !== undefined && clip.end !== undefined) return clip.end - clip.start;
  return null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

const ELEMENT = /<([a-zA-Z][\w:-]*)\b([^>]*)>/g;
const CLIP_ID_ATTR = /\bdata-clip-id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/;

/**
 * Texto plano do clip: só quando o conteúdo entre a tag de abertura e o
 * primeiro fechamento da mesma tag não tem marcação. Regex simples, como o
 * contrato do estúdio pede; caso não dê para ler, `null`.
 */
function extractClipText(source: string, tag: string, id: string): string | null {
  const expected = tag.toLowerCase();
  for (const match of source.matchAll(ELEMENT)) {
    if ((match[1] ?? "").toLowerCase() !== expected) continue;
    const attr = CLIP_ID_ATTR.exec(match[2] ?? "");
    if (attr === null) continue;
    if ((attr[1] ?? attr[2] ?? attr[3]) !== id) continue;
    const start = (match.index ?? 0) + match[0].length;
    const close = new RegExp(`</${expected}\\s*>`, "i").exec(source.slice(start));
    if (close === null) return null;
    const inner = source.slice(start, start + close.index);
    if (inner.includes("<")) return null;
    return decodeEntities(inner.trim());
  }
  return null;
}

interface RootClose {
  index: number;
  tag: string;
}

/** Índice da tag de fechamento do elemento marcado com `data-composition-id`. */
function findRootClose(source: string): RootClose | null {
  const start = /<([a-zA-Z][\w:-]*)\b[^>]*\bdata-composition-id\s*=[^>]*>/.exec(source);
  if (start === null) return null;
  const tag = (start[1] ?? "").toLowerCase();
  const scan = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  scan.lastIndex = (start.index ?? 0) + start[0].length;
  let depth = 1;
  for (let match = scan.exec(source); match !== null; match = scan.exec(source)) {
    if (match[1] === "/") {
      depth -= 1;
      if (depth === 0) return { index: match.index, tag };
    } else if (!match[0].endsWith("/>")) {
      depth += 1;
    }
  }
  return null;
}

function nextClipId(source: string): string {
  let max = 0;
  for (const match of source.matchAll(/\bdata-clip-id\s*=\s*["']clip-(\d+)["']/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) max = value;
  }
  const used = new Set(
    [...source.matchAll(/\bdata-clip-id\s*=\s*["']([^"']+)["']/g)].map((match) => match[1] ?? ""),
  );
  let n = max + 1;
  while (used.has(`clip-${n}`)) n += 1;
  return `clip-${n}`;
}

function numeric(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ReplyError(400, "E_BODY_INVALID", `"${field}" precisa ser número`);
  }
  return value;
}

export async function startStudio(options: StudioOptions): Promise<StudioServer> {
  const entryPath = resolve(options.entry);
  const entryDir = dirname(entryPath);
  const entryName = basename(entryPath);
  const audioCacheDir = resolve(options.audioCacheDir ?? assetPath("cache", "preview-audio"));
  const waveformCacheDir = options.waveformCacheDir === undefined ? undefined : resolve(options.waveformCacheDir);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`porta inválida: ${String(options.port)}`);
  }
  const info = await stat(entryPath).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`entrada inacessível: ${entryPath} (${error.code ?? error.message})`, { cause: error });
  });
  if (!info.isFile()) throw new Error(`entrada não é arquivo: ${entryPath}`);

  const clients = new Set<ServerResponse>();
  let watcher: FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let preview: { mtimeMs: number; revision: number; prepared: PreparedComposition; html: string } | undefined;
  /** Escritas fora do arquivo de entrada (legendas): o `mtime` dele não muda, então o cache do preview conta aqui. */
  let revision = 0;
  let tmpCounter = 0;
  const history = new StudioHistory();
  let mutations: Promise<unknown> = Promise.resolve();
  let ffmpegPending: Promise<FfmpegPair> | undefined;

  /** Uma escrita por vez: leitura-modificação-escrita do mesmo arquivo não pode intercalar. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = mutations.then(task, task);
    // ignora-erro: o erro volta a quem chamou por `run` (retornado); aqui só a fila segue para a próxima escrita
    mutations = run.catch(() => undefined);
    return run;
  };

  const ffmpegPair = (): Promise<FfmpegPair> => {
    const pending = ffmpegPending ?? resolveFfmpeg();
    // Falha não fica em cache: a próxima importação ou waveform tenta resolver de novo.
    ffmpegPending = pending;
    pending.catch(() => {
      if (ffmpegPending === pending) ffmpegPending = undefined;
    });
    return pending;
  };

  const ffprobePath = (): Promise<string> => ffmpegPair().then((pair) => pair.ffprobe);

  /** Export do arquivo salvo (EDT-46). O progresso chega aos navegadores como `event: export`. */
  const exporter = createExporter({
    entry: entryPath,
    onEvent: (job) => {
      for (const client of clients) client.write(`event: export
data: ${JSON.stringify(job)}

`);
    },
  });

  const scheduleChange = (): void => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      for (const client of clients) client.write("data: change\n\n");
    }, 80);
    debounce.unref();
  };

  const ensureWatcher = (): void => {
    if (watcher !== undefined) return;
    watcher = watch(entryDir, (_event, filename) => {
      if (filename !== null && String(filename) !== entryName) return;
      scheduleChange();
    });
    watcher.on("error", (error: Error) => {
      process.stderr.write(`studio: watcher falhou: ${error.message}\n`);
    });
  };

  const writeAtomic = async (target: string, content: string): Promise<void> => {
    const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${++tmpCounter}.tmp`);
    try {
      await writeFile(tmp, content, "utf8");
      await rename(tmp, target);
    } catch (error) {
      // force: o tmp pode não existir (o writeFile falhou antes de criá-lo); outras falhas aparecem no stderr.
      await rm(tmp, { force: true }).catch((cleanupError: unknown) => warnCleanup(tmp, cleanupError));
      throw error;
    }
  };

  /** O watcher só olha o arquivo de entrada: escrita em sub-composição recarrega o preview por aqui. */
  const subCompositionChanged = (): void => {
    revision += 1;
    scheduleChange();
  };

  /** Grava uma versão nova e registra no histórico. */
  const commit = async (label: string, before: string, after: string, file = entryPath): Promise<void> => {
    await writeAtomic(file, after);
    history.record(label, file, before, after);
    if (file !== entryPath) subCompositionChanged();
  };

  const validated = (next: string, message: string): ReturnType<typeof loadComposition> => {
    const composition = loadComposition(next);
    if (!composition.ok) throw new ReplyError(400, "E_CONTRACT_INVALID", message, composition.diagnostics);
    return composition;
  };

  const durationOf = (composition: ReturnType<typeof loadComposition>): number | null =>
    composition.duration.kind === "unresolved" ? null : composition.duration.seconds;

  /**
   * Mix do preview (o mesmo grafo do render). Falha do mix não derruba o vídeo: vira `{error}`
   * e aparece na barra do preview.
   */
  const previewAudioConfig = async (prepared: PreparedComposition): Promise<PreviewAudioConfig | null> => {
    const started = performance.now();
    try {
      const { ffmpeg } = await resolveFfmpeg();
      const result = await renderPreviewAudio({ prepared, ffmpeg, cacheDir: audioCacheDir });
      if (result === null) return null;
      if ("disabled" in result) return { disabled: result.disabled };
      process.stderr.write(
        `studio: áudio do preview ${result.key.slice(0, 8)} ${result.cached ? "do cache" : "mixado"} em ${Math.round(performance.now() - started)} ms\n`,
      );
      for (const warning of result.warnings) process.stderr.write(`studio: áudio: ${warning}\n`);
      return { src: `${AUDIO_PREFIX}${result.key}.wav` };
    } catch (error) {
      const text = error instanceof PreviewAudioError ? `${error.code}: ${error.message} (${error.hint})` : `E_PREVIEW_AUDIO: ${(error as Error).message}`;
      process.stderr.write(`studio: ${text}\n`);
      return { error: text };
    }
  };

  const loadPreview = async (): Promise<{ prepared: PreparedComposition; html: string }> => {
    const current = await stat(entryPath);
    // Lida antes do `prepare`: uma escrita durante a preparação deixa o cache vencido.
    const seen = revision;
    if (preview !== undefined && preview.mtimeMs === current.mtimeMs && preview.revision === seen) {
      return { prepared: preview.prepared, html: preview.html };
    }
    const prepared = await prepare({ entry: entryPath });
    const audio = await previewAudioConfig(prepared);
    const html = injectEngine(prepared.compiledHtml, {
      manifest: prepared.manifest,
      fontsBase: "/__ff_fonts",
      live: true,
      ...(audio !== null ? { audio } : {}),
      // O Studio recarrega pelo próprio /api/events; a barra não abre /__ff_reload (404 aqui).
      // `autoplay: false`: o Studio abre pausado no 0 (§9d); só a recarga pós-edição restaura o play.
      preview: { fps: prepared.fps, frames: prepared.totalFrames, id: prepared.composition.id, reload: false, autoplay: false },
    }).replace(/<head[^>]*>/i, (head) => `${head}<base href="${SITE_PREFIX}">`);
    preview = { mtimeMs: current.mtimeMs, revision: seen, prepared, html };
    return { prepared, html };
  };

  const serveStatic = async (res: ServerResponse, pathname: string): Promise<void> => {
    const file = STUDIO_FILES[pathname];
    if (file === undefined) {
      send(res, 404, "não encontrado\n", "text/plain; charset=utf-8");
      return;
    }
    const target = join(STUDIO_DIR, file);
    const body = await readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (body === undefined) {
      send(res, 503, "interface ausente\n", "text/plain; charset=utf-8");
      return;
    }
    send(res, 200, body, MIME[extname(target).toLowerCase()] ?? "application/octet-stream");
  };

  const serveAsset = async (res: ServerResponse, root: string | undefined, relative: string): Promise<void> => {
    if (root === undefined) {
      send(res, 404, "rota não configurada\n", "text/plain; charset=utf-8");
      return;
    }
    if (relative === "" || relative.includes("\0")) {
      send(res, 400, "caminho inválido\n", "text/plain; charset=utf-8");
      return;
    }
    const target = inside(root, relative);
    if (target === undefined) {
      send(res, 403, "fora da raiz\n", "text/plain; charset=utf-8");
      return;
    }
    const info = await statIfPresent(target);
    if (info === undefined || !info.isFile()) {
      send(res, 404, "não encontrado\n", "text/plain; charset=utf-8");
      return;
    }
    send(res, 200, await readFile(target), MIME[extname(target).toLowerCase()] ?? "application/octet-stream");
  };

  /** Arquivo de um `data-composition-src`: na pasta da entrada, sem URL, `..` nem segmento oculto. */
  const subCompositionPath = (src: string): string | undefined => {
    const hidden = src.split(/[\\/]/).some((part) => part !== "." && part.startsWith("."));
    return /^[a-z][a-z0-9+.-]+:/i.test(src) || isAbsolute(src) || hidden ? undefined : inside(entryDir, src);
  };

  /** `undefined` quando o arquivo não existe (ou é pasta); outra falha de leitura aparece. */
  const readIfPresent = (file: string): Promise<string | undefined> =>
    readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EISDIR") return undefined;
      throw error;
    });

  /** Hosts de legendas (EDT-97): clips de topo cujo `data-composition-src` tem a meta do `captions`. */
  const captionHostIds = async (clips: ResolvedClip[]): Promise<Set<string>> => {
    const ids = new Set<string>();
    for (const clip of clips) {
      const file = clip.src === undefined ? undefined : subCompositionPath(clip.src);
      const html = file === undefined ? undefined : await readIfPresent(file);
      if (html !== undefined && hasCaptionMeta(html)) ids.add(clip.id);
    }
    return ids;
  };

  const captionsFile = async (hostId: string): Promise<{ src: string; file: string; html: string }> => {
    const host = loadComposition(await readFile(entryPath, "utf8")).clips.find((clip) => clip.id === hostId);
    if (host === undefined) {
      throw hintedError(404, "E_CLIP_NOT_FOUND", `clip "${hostId}" não existe no topo da composição`, "recarregue a composição e escolha o host das legendas na timeline");
    }
    const refuse = (message: string): ReplyError =>
      hintedError(400, "E_CAPTIONS_HOST", message, "escolha um clip cujo data-composition-src é um arquivo gerado por frankframes captions, dentro da pasta da composição");
    const src = host.src;
    if (src === undefined) throw refuse(`o clip "${hostId}" não tem data-composition-src`);
    const file = subCompositionPath(src);
    if (file === undefined) throw refuse(`o arquivo de "${hostId}" fica fora da pasta da composição: ${src}`);
    const html = await readIfPresent(file);
    if (html === undefined) throw refuse(`arquivo de legendas não encontrado: ${src}`);
    return { src, file, html };
  };

  /** `GET /api/captions/<hostId>`: as legendas do arquivo, com tempos locais ao host. */
  const listCaptions = async (hostId: string, res: ServerResponse): Promise<void> => {
    const { src, html } = await captionsFile(hostId);
    sendJson(res, 200, { src, cues: captionsStep(() => readCaptionFile(html)).cues });
  };

  /** `POST /api/captions/<hostId>/<cueId>` com `{text}`; ver `editCaptionText`. A árvore valida antes de gravar. */
  const editCaption = async (hostId: string, cueId: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const text = objectBody(await bodyJson(req)).text;
    if (typeof text !== "string") throw hintedError(400, "E_BODY_INVALID", '"text" precisa ser texto', 'envie {"text": "texto da legenda"}');
    const { file, html } = await captionsFile(hostId);
    const next = captionsStep(() => editCaptionText(html, cueId, text));
    const composition = await validatedTree(await readFile(entryPath, "utf8"), "a legenda deixaria o contrato inválido", new Map([[file, next]]));
    const changed = next !== html;
    if (changed) await commit(`editar legenda ${cueId}`, html, next, file);
    sendJson(res, 200, {
      ok: true,
      id: cueId,
      changed,
      duration: durationOf(composition),
      diagnostics: composition.diagnostics,
      history: history.state(),
    });
  };

  const compositionPayload = async (): Promise<unknown> => {
    const source = await readFile(entryPath, "utf8");
    const composition = loadComposition(source);
    const captionHosts = await captionHostIds(composition.clips);
    const explicit = explicitClipIds(source);
    // Elemento próprio de cada clip (ordinal 0): é o que o inspetor edita.
    const ownMotion = new Map<string, MotionSource>();
    // Tempos (locais ao clip) dos keyframes dos descendentes: o Studio os mostra, só leitura.
    const descendantTimes = new Map<string, Set<number>>();
    for (const item of parseComposition(source).motion) {
      if (item.own && item.ordinal === 0) ownMotion.set(item.clipId, item);
      if (item.ordinal > 0 && item.keyframes !== undefined) {
        const times = descendantTimes.get(item.clipId) ?? new Set<number>();
        for (const point of item.keyframes) times.add(point.time);
        descendantTimes.set(item.clipId, times);
      }
    }
    return {
      entry: entryPath,
      id: composition.id,
      fps: composition.fps,
      duration: composition.duration.kind === "unresolved" ? null : composition.duration.seconds,
      // Raiz como o arquivo a declara (inspetor de Composição): `durationKind` diz se `data-duration` manda;
      // `contentEnd` é o fim do último clip de topo, o que "derivada" daria.
      width: composition.width ?? null,
      height: composition.height ?? null,
      durationKind: composition.duration.kind,
      contentEnd: composition.clips.reduce<number | null>(
        (latest, clip) => (clip.end === undefined ? latest : Math.max(latest ?? 0, clip.end)),
        null,
      ),
      clips: flattenClips(composition.clips).map(({ clip, parentId }) => ({
        id: clip.id,
        tag: clip.tag,
        start: clip.start ?? null,
        duration: clipDuration(clip),
        end: clip.end ?? null,
        offset: clip.offset,
        playbackRate: clip.playbackRate,
        volume: clip.volume ?? 1,
        role: clip.audioRole ?? null,
        text: extractClipText(source, clip.tag, clip.id),
        track: clip.track,
        kind: clipKind(clip),
        hasAudio: clip.hasAudio === true,
        mediaSrc: clip.mediaSrc ?? null,
        fadeIn: clip.fadeIn ?? null,
        fadeOut: clip.fadeOut ?? null,
        hasKeyframes: clip.keyframes !== undefined,
        motion: withTransition(
          motionOf(ownMotion.get(clip.id) ?? { clipId: clip.id, ordinal: 0, tag: clip.tag, own: true, attrs: {} }),
          clip,
        ),
        // Um ponto por tempo, volume e propriedades visuais juntos (docs/contract.md §9d); o que a rota
        // `/keyframes` edita. Os descendentes só aparecem como tempos, sem edição.
        keyframes: mergeKeyframePoints(clip.keyframes ?? [], ownMotion.get(clip.id)?.keyframes ?? []),
        descendantKeyframeTimes: [...(descendantTimes.get(clip.id) ?? [])].sort((a, b) => a - b),
        hasChildren: clip.children.length > 0 || clip.isSubComposition,
        captions: parentId === null && captionHosts.has(clip.id),
        parentId,
        // Só clip de topo com data-clip-id explícito aceita ferramentas de edição.
        editable: parentId === null && explicit.has(clip.id),
      })),
      diagnostics: composition.diagnostics,
    };
  };

  const patchClip = async (clipId: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = objectBody(await bodyJson(req));
    const patch: ClipPatch = { clipId };
    if (body.attributes !== undefined) {
      const attributes = objectBody(body.attributes);
      const parsed: Record<string, string | null> = {};
      for (const [name, value] of Object.entries(attributes)) {
        if (value !== null && typeof value !== "string") {
          throw new ReplyError(400, "E_ATTRIBUTE_INVALID", `atributo "${name}" precisa ser texto ou null`);
        }
        parsed[name] = value;
      }
      patch.attributes = parsed;
    }
    if (body.text !== undefined) {
      if (typeof body.text !== "string") {
        throw new ReplyError(400, "E_TEXT_NOT_EDITABLE", '"text" precisa ser texto');
      }
      patch.text = body.text;
    }

    const source = await readFile(entryPath, "utf8");
    let next: string;
    try {
      next = applyPatches(source, [patch]);
    } catch (error) {
      if (error instanceof EditError) throw new ReplyError(400, error.code, error.message);
      throw error;
    }
    const composition = validated(next, "a edição deixaria o contrato inválido");
    await commit(`editar ${clipId}`, source, next);
    sendJson(res, 200, {
      ok: true,
      duration: durationOf(composition),
      diagnostics: composition.diagnostics,
      history: history.state(),
    });
  };

  /**
   * `POST /api/composition` com `{duration?, width?, height?, fps?}`; ver `editComposition`. `duration: null`
   * remove `data-duration` (derivada). O contrato valida o resultado antes de ir ao arquivo e à história.
   */
  const patchComposition = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = objectBody(await bodyJson(req));
    const patch: CompositionPatch = {};
    if (body.duration !== undefined) patch.duration = body.duration === null ? null : numeric(body, "duration");
    if (body.width !== undefined) patch.width = numeric(body, "width");
    if (body.height !== undefined) patch.height = numeric(body, "height");
    if (body.fps !== undefined) {
      // `30` (número) e `"30"` valem igual; racional só como texto.
      if (typeof body.fps === "number" && Number.isFinite(body.fps)) patch.fps = String(body.fps);
      else if (typeof body.fps === "string") patch.fps = body.fps;
      else throw new ReplyError(400, "E_BODY_INVALID", '"fps" precisa ser texto ("30", "30000/1001") ou número');
    }

    const source = await readFile(entryPath, "utf8");
    let next: string;
    try {
      next = editComposition(source, patch);
    } catch (error) {
      if (error instanceof EditError) throw new ReplyError(400, error.code, error.message);
      throw error;
    }
    const composition = validated(next, "a edição da composição deixaria o contrato inválido");
    if (next !== source) await commit("editar composição", source, next);
    sendJson(res, 200, { ok: true, duration: durationOf(composition), diagnostics: composition.diagnostics, history: history.state() });
  };

  const insertClip = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = objectBody(await bodyJson(req));
    const template = body.template;
    // EDT-88: sem plano B. Só existe o texto simples; bloco do catálogo é `POST /api/blocks` e nunca vira texto.
    if (template !== "text") {
      const message = `template desconhecido: ${JSON.stringify(template)}`;
      throw new ReplyError(400, "E_TEMPLATE_INVALID", message, [
        { code: "E_TEMPLATE_INVALID", severity: "error", message, hint: 'o único template é "text" (texto simples); para um bloco do catálogo use POST /api/blocks' },
      ]);
    }
    const start = numeric(body, "start");
    const duration = numeric(body, "duration");
    if (duration <= 0) throw new ReplyError(400, "E_BODY_INVALID", '"duration" precisa ser > 0');

    const source = await readFile(entryPath, "utf8");
    const root = findRootClose(source);
    if (root === null) {
      throw new ReplyError(400, "E_ROOT_NOT_FOUND", "elemento com data-composition-id não encontrado");
    }
    const id = nextClipId(source);
    const track = topTrack(source);
    // `position:absolute` porque a camada (`z-index`, §4) só vale em elemento posicionado.
    const style = "position:absolute;left:0;right:0;top:45%;text-align:center";
    const markup = `\n  <div data-clip-id="${id}" data-start="${start}" data-duration="${duration}" data-track="${track}" class="clip" style="${style}">Texto</div>\n`;
    const next = source.slice(0, root.index) + markup + source.slice(root.index);

    validated(next, "o clip novo deixaria o contrato inválido");
    await commit("inserir texto", source, next);
    sendJson(res, 200, { ok: true, id, history: history.state() });
  };

  /** Faixa de um clip visual novo (EDT-44): uma acima da maior faixa visual da raiz, 0 se não há nenhuma. */
  const topTrack = (source: string): number => {
    const visualTracks = loadComposition(source)
      .clips.filter((clip) => clipKind(clip) !== "audio")
      .map((clip) => clip.track);
    return visualTracks.length === 0 ? 0 : Math.max(...visualTracks) + 1;
  };

  /**
   * Valida a árvore inteira, sub-composições incluídas (`loadComposition` sozinho só lê o arquivo de entrada): id
   * duplicado entre arquivos, raiz ausente ou duração sem resolver no arquivo inlinado barram a mutação.
   */
  const validatedTree = async (next: string, message: string, files?: ReadonlyMap<string, string>): Promise<ReturnType<typeof loadComposition>> => {
    const compiled = await compileComposition({ entryHtml: next, entryDir, entryPath, ...(files === undefined ? {} : { files }) });
    if (!compiled.composition.ok) throw new ReplyError(400, "E_CONTRACT_INVALID", message, compiled.composition.diagnostics);
    return compiled.composition;
  };

  /**
   * `POST /api/blocks` com `{slug, start}` (EDT-88): copia o bloco do catálogo para `blocks/<slug>/` com a mesma rotina do
   * `frankframes blocks add` e insere um host `data-composition-src` no tempo pedido, com a duração do bloco. Os arquivos
   * copiados ficam no projeto mesmo se o clip for desfeito ou apagado; copiar de novo nunca sobrescreve edição sua.
   */
  const insertBlock = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = objectBody(await bodyJson(req));
    const slug = body.slug;
    if (typeof slug !== "string" || slug === "") throw new ReplyError(400, "E_BODY_INVALID", '"slug" precisa ser texto');
    const start = numeric(body, "start");
    if (start < 0) throw new ReplyError(400, "E_BODY_INVALID", '"start" precisa ser >= 0');

    let block: ReturnType<typeof listBlocks>[number] | undefined;
    try {
      block = listBlocks().find((candidate) => candidate.slug === slug);
    } catch (error) {
      throw new ReplyError(500, "E_CATALOG", (error as Error).message);
    }
    if (block === undefined) {
      const unknown = new UnknownBlockError(slug);
      throw new ReplyError(404, unknown.code, unknown.message, [
        { code: unknown.code, severity: "error", message: unknown.message, hint: unknown.hint },
      ]);
    }

    const source = await readFile(entryPath, "utf8");
    const root = findRootClose(source);
    if (root === null) throw new ReplyError(400, "E_ROOT_NOT_FOUND", "elemento com data-composition-id não encontrado");

    const target = join(entryDir, BLOCKS_DIR, slug);
    const reused = (await statIfPresent(target)) !== undefined;
    if (!reused) await installBlock(slug, target);

    const id = nextClipId(source);
    const src = `${BLOCKS_DIR}/${slug}/index.html`;
    const markup = `\n  ${subCompositionMarkup(id, src, start, block.durationSeconds, topTrack(source))}\n`;
    const next = source.slice(0, root.index) + markup + source.slice(root.index);
    await validatedTree(next, `o bloco ${slug} deixaria o contrato inválido`);
    await commit(`inserir bloco ${slug}`, source, next);
    sendJson(res, 200, { ok: true, id, slug, src, duration: block.durationSeconds, reused, history: history.state() });
  };

  /**
   * `.html` local pelo Importar (EDT-88): vira sub-composição no tempo pedido, com a duração derivada da raiz do arquivo
   * (§5). O arquivo vai para `compositions/`; se não for uma composição válida, é descartado e nada muda no projeto.
   */
  const importSubComposition = async (name: string, start: number, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const source = await readFile(entryPath, "utf8");
    const root = findRootClose(source);
    if (root === null) throw new ReplyError(400, "E_ROOT_NOT_FOUND", "elemento com data-composition-id não encontrado");

    let stored: Awaited<ReturnType<typeof storeMedia>>;
    try {
      stored = await storeMedia(req, entryDir, name, COMPOSITIONS_DIR);
    } catch (error) {
      if (error instanceof MediaUploadError) throw new ReplyError(error.status, error.code, error.message);
      throw error;
    }
    const discard = async (): Promise<void> => {
      if (stored.created) await unlink(stored.file);
    };

    try {
      const inner = loadComposition(await readFile(stored.file, "utf8"));
      if (!inner.ok) throw new ReplyError(400, "E_CONTRACT_INVALID", `${name} não é uma sub-composição válida`, inner.diagnostics);
      if (inner.duration.kind === "unresolved") {
        throw new ReplyError(400, "E_CONTRACT_INVALID", `${name} não tem duração resolvida`, [
          { code: "E_DURATION_UNRESOLVED", severity: "error", message: "duração da sub-composição não resolvida", hint: "declare data-duration na raiz do arquivo" },
        ]);
      }
      const duration = inner.duration.seconds;
      const id = nextClipId(source);
      const markup = `\n  ${subCompositionMarkup(id, stored.src, start, duration, topTrack(source))}\n`;
      const next = source.slice(0, root.index) + markup + source.slice(root.index);
      await validatedTree(next, `a sub-composição ${name} deixaria o contrato inválido`);
      await commit(`importar ${stored.src}`, source, next);
      sendJson(res, 200, { ok: true, id, src: stored.src, kind: "composition", duration, reused: !stored.created, history: history.state() });
    } catch (error) {
      await discard();
      throw error;
    }
  };

  /** `POST /api/media?name=<arquivo>&start=<s>` com o arquivo cru no corpo. */
  const importMedia = async (url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const name = url.searchParams.get("name") ?? "";
    if (isSubCompositionFile(name)) {
      const htmlStart = Number(url.searchParams.get("start") ?? "0");
      if (!Number.isFinite(htmlStart) || htmlStart < 0) throw new ReplyError(400, "E_BODY_INVALID", '"start" precisa ser número >= 0');
      await importSubComposition(name, htmlStart, req, res);
      return;
    }
    const kind = mediaKind(name);
    if (kind === undefined) {
      const message = `tipo de arquivo não suportado: ${name || "(sem nome)"}`;
      throw new ReplyError(400, "E_MEDIA_UNSUPPORTED", message, [
        { severity: "error", message, hint: `use ${supportedExtensions().join(", ")}` },
      ]);
    }
    const start = Number(url.searchParams.get("start") ?? "0");
    if (!Number.isFinite(start) || start < 0) throw new ReplyError(400, "E_BODY_INVALID", '"start" precisa ser número >= 0');

    const source = await readFile(entryPath, "utf8");
    const root = findRootClose(source);
    if (root === null) throw new ReplyError(400, "E_ROOT_NOT_FOUND", "elemento com data-composition-id não encontrado");

    let stored: Awaited<ReturnType<typeof storeMedia>>;
    try {
      stored = await storeMedia(req, entryDir, name);
    } catch (error) {
      if (error instanceof MediaUploadError) throw new ReplyError(error.status, error.code, error.message);
      throw error;
    }
    const discard = async (): Promise<void> => {
      if (stored.created) await unlink(stored.file);
    };

    let duration = IMAGE_SECONDS;
    let orientation: VideoOrientation | undefined;
    if (kind !== "img") {
      try {
        const measured = await measureMedia(await ffprobePath(), stored.file, kind);
        // Precisão do probe, sem arredondar: arredondar para cima encurtaria/estenderia a fonte (§9d).
        duration = measured.duration;
        orientation = measured.orientation;
      } catch (error) {
        await discard();
        if (error instanceof MediaRotationError) {
          throw new ReplyError(400, "E_MEDIA_ROTATION", error.message, [
            { severity: "error", message: error.message, hint: error.hint },
          ]);
        }
        const message = `não foi possível medir ${name}: ${(error as Error).message}`;
        throw new ReplyError(400, "E_MEDIA_PROBE", message, [
          { severity: "error", message, hint: "confira se o arquivo abre num player; rode `frankframes doctor` se o ffprobe faltar" },
        ]);
      }
    }

    const id = nextClipId(source);
    const markup = `\n  ${mediaMarkup(kind, id, stored.src, start, duration)}\n`;
    const next = source.slice(0, root.index) + markup + source.slice(root.index);
    try {
      validated(next, "a mídia nova deixaria o contrato inválido");
    } catch (error) {
      await discard();
      throw error;
    }
    await commit(`importar ${stored.src}`, source, next);
    sendJson(res, 200, { ok: true, id, src: stored.src, kind, duration, orientation, reused: !stored.created, history: history.state() });
  };

  const split = async (clipId: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = objectBody(await bodyJson(req));
    const at = numeric(body, "at");
    const source = await readFile(entryPath, "utf8");
    const newId = nextClipId(source);
    let next: string;
    try {
      next = splitClip(source, { clipId, at, newId });
    } catch (error) {
      if (error instanceof EditError) throw new ReplyError(400, error.code, error.message);
      throw error;
    }
    const composition = validated(next, "o corte deixaria o contrato inválido");
    await commit(`dividir ${clipId}`, source, next);
    sendJson(res, 200, { ok: true, id: newId, duration: durationOf(composition), history: history.state() });
  };

  /**
   * `POST /api/clips/<id>/duplicate` com `{}` (cópia no fim do original) ou `/paste` com `{at}`; ver
   * `duplicateClip`. O id novo sai do servidor; nenhum clip existente se move.
   */
  const copy = async (clipId: string, mode: "duplicate" | "paste", req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = objectBody(await bodyJson(req));
    const source = await readFile(entryPath, "utf8");
    let at = 0;
    if (mode === "paste") at = numeric(body, "at");
    else {
      const original = loadComposition(source).clips.find((item) => item.id === clipId);
      if (original !== undefined) {
        if (original.end === undefined) throw new ReplyError(400, "E_COPY_UNSUPPORTED", `clip "${clipId}" não tem fim resolvido; defina data-duration`);
        at = original.end;
      }
    }
    const newId = nextClipId(source);
    let result: ReturnType<typeof duplicateClip>;
    try {
      result = duplicateClip(source, { clipId, at, newId });
    } catch (error) {
      if (error instanceof EditError) {
        const message = mode === "paste" && error.code === "E_CLIP_NOT_FOUND" ? "o clip copiado não existe mais" : error.message;
        throw new ReplyError(400, error.code, message);
      }
      throw error;
    }
    const composition = validated(result.source, mode === "paste" ? "colar deixaria o contrato inválido" : "duplicar deixaria o contrato inválido");
    await commit(`${mode === "paste" ? "colar" : "duplicar"} ${clipId}`, source, result.source);
    sendJson(res, 200, { ok: true, id: newId, duration: durationOf(composition), warnings: result.warnings, history: history.state() });
  };

  /** `POST /api/clips/<id>/trim` com `{start}`; ver `trimClipStart`. O offset de mídia sai do servidor. */
  const trim = async (clipId: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = objectBody(await bodyJson(req));
    const start = numeric(body, "start");
    const source = await readFile(entryPath, "utf8");
    let next: string;
    try {
      next = trimClipStart(source, { clipId, start });
    } catch (error) {
      if (error instanceof EditError) throw new ReplyError(400, error.code, error.message);
      throw error;
    }
    const composition = validated(next, "aparar deixaria o contrato inválido");
    if (next !== source) await commit(`aparar ${clipId}`, source, next);
    sendJson(res, 200, { ok: true, id: clipId, duration: durationOf(composition), history: history.state() });
  };

  /** `POST /api/clips/<id>/delete` com `{}`; ver `deleteClip`. */
  const remove = async (clipId: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    objectBody(await bodyJson(req));
    const source = await readFile(entryPath, "utf8");
    let next: string;
    try {
      next = deleteClip(source, { clipId });
    } catch (error) {
      if (error instanceof EditError) throw new ReplyError(400, error.code, error.message);
      throw error;
    }
    const composition = validated(next, "a exclusão deixaria o contrato inválido");
    await commit(`excluir ${clipId}`, source, next);
    sendJson(res, 200, { ok: true, id: clipId, duration: durationOf(composition), history: history.state() });
  };

  /** `POST /api/clips/<id>/transition` com `{preset, dur, params?}`; ver `applyTransition`. */
  const transition = async (clipId: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = objectBody(await bodyJson(req));
    const preset = body.preset;
    if (preset !== null && typeof preset !== "string") {
      throw new ReplyError(400, "E_BODY_INVALID", '"preset" precisa ser o nome de um preset de transição ou null');
    }
    const params: Record<string, string> = {};
    if (body.params !== undefined) {
      for (const [key, item] of Object.entries(objectBody(body.params))) {
        if (typeof item !== "string") throw new ReplyError(400, "E_BODY_INVALID", `parâmetro "${key}" precisa ser texto`);
        params[key] = item;
      }
    }
    const request = preset === null ? { clipId, preset } : { clipId, preset, dur: numeric(body, "dur"), params };
    const source = await readFile(entryPath, "utf8");
    let next: string;
    try {
      next = applyTransition(source, request);
    } catch (error) {
      if (error instanceof EditError) throw new ReplyError(400, error.code, error.message);
      throw error;
    }
    const composition = validated(next, "a transição deixaria o contrato inválido");
    if (next !== source) await commit(`transição ${clipId}`, source, next);
    sendJson(res, 200, { ok: true, duration: durationOf(composition), diagnostics: composition.diagnostics, history: history.state() });
  };

  /**
   * `POST /api/clips/<id>/keyframes` com `{op, time, ...}`; ver `editKeyframes`. O resultado passa pelo contrato
   * (faixa dos valores, curva, sobreposição com presets) antes de ir ao arquivo.
   */
  const keyframes = async (clipId: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = objectBody(await bodyJson(req));
    const op = body.op;
    const time = numeric(body, "time");
    const value = body.value;
    if (value !== undefined && typeof value !== "number" && typeof value !== "string") {
      throw new ReplyError(400, "E_BODY_INVALID", '"value" precisa ser número ou texto');
    }
    const curve = body.curve;
    if (curve !== undefined && curve !== null && typeof curve !== "string") {
      throw new ReplyError(400, "E_BODY_INVALID", '"curve" precisa ser texto ou null');
    }
    const prop = body.prop;
    if (prop !== undefined && typeof prop !== "string") throw new ReplyError(400, "E_BODY_INVALID", '"prop" precisa ser texto');
    let request: KeyframeRequest;
    if (op === "add") {
      if (prop === undefined) throw new ReplyError(400, "E_BODY_INVALID", '"prop" é obrigatório em "add"');
      if (curve === null) throw new ReplyError(400, "E_BODY_INVALID", '"curve" null só vale em "edit"');
      request = { clipId, op, time, prop: prop as never, value, curve };
    } else if (op === "move") {
      request = { clipId, op, time, to: numeric(body, "to") };
    } else if (op === "remove") {
      request = { clipId, op, time, prop: prop as never };
    } else if (op === "edit") {
      request = { clipId, op, time, prop: prop as never, value, curve };
    } else {
      throw new ReplyError(400, "E_BODY_INVALID", '"op" precisa ser add, move, remove ou edit');
    }
    const source = await readFile(entryPath, "utf8");
    let next: string;
    try {
      next = editKeyframes(source, request);
    } catch (error) {
      if (error instanceof EditError) throw new ReplyError(400, error.code, error.message);
      throw error;
    }
    const composition = validated(next, "o keyframe deixaria o contrato inválido");
    if (next !== source) await commit(`keyframe ${clipId}`, source, next);
    sendJson(res, 200, { ok: true, duration: durationOf(composition), diagnostics: composition.diagnostics, history: history.state() });
  };

  const travel = async (direction: "undo" | "redo", res: ServerResponse): Promise<void> => {
    const file = history.target(direction) ?? entryPath;
    // Sub-composição apagada fora do Studio é histórico vencido (409), não erro interno.
    const current = file === entryPath ? await readFile(file, "utf8") : await readIfPresent(file);
    let target: string | undefined;
    try {
      target = direction === "undo" ? history.undo(current) : history.redo(current);
    } catch (error) {
      if (error instanceof HistoryStaleError) throw new ReplyError(409, error.code, error.message);
      throw error;
    }
    if (target === undefined) {
      sendJson(res, 200, { ok: true, changed: false, history: history.state() });
      return;
    }
    try {
      await writeAtomic(file, target);
    } catch (error) {
      history.revert(direction);
      throw error;
    }
    if (file !== entryPath) subCompositionChanged();
    const entry = file === entryPath ? target : await readFile(entryPath, "utf8");
    sendJson(res, 200, { ok: true, changed: true, duration: durationOf(loadComposition(entry)), history: history.state() });
  };

  /** Picos do arquivo-fonte de um clip com som. É leitura: não entra em `serial()`. */
  const waveform = async (clipId: string, res: ServerResponse): Promise<void> => {
    const composition = loadComposition(await readFile(entryPath, "utf8"));
    const clip = flattenClips(composition.clips).find((item) => item.clip.id === clipId)?.clip;
    if (clip === undefined) throw new ReplyError(404, "E_CLIP_NOT_FOUND", `clip "${clipId}" não existe`);

    const unsupported = (message: string): ReplyError =>
      new ReplyError(400, "E_WAVEFORM_UNSUPPORTED", message, [{ severity: "error", message, hint: "só áudio/vídeo com som" }]);
    if (clip.mediaSrc === undefined || clip.hasAudio !== true) throw unsupported(`o clip "${clipId}" não é áudio nem vídeo com som`);
    // Mesma regra do `/__ff_site/`: segmento oculto (`.`, `..`, `.env`) ou caminho fora da pasta da entrada não passa.
    const relative = clip.mediaSrc;
    const file =
      /^[a-z][a-z0-9+.-]+:/i.test(relative) || relative.split(/[\\/]/).some((part) => part.startsWith("."))
        ? undefined
        : inside(entryDir, relative);
    if (file === undefined) throw unsupported(`o arquivo de "${clipId}" fica fora da pasta da composição: ${relative}`);
    if (!(await stat(file).then((info) => info.isFile(), () => false))) {
      const message = `arquivo de mídia não encontrado: ${relative}`;
      throw new ReplyError(500, "E_WAVEFORM_FAILED", message, [{ severity: "error", message, hint: "confira o caminho do arquivo no clip" }]);
    }

    try {
      const { ffmpeg } = await ffmpegPair();
      sendJson(res, 200, await waveformFor(ffmpeg, file, { cacheDir: waveformCacheDir }));
    } catch (error) {
      if (!(error instanceof WaveformError)) throw error;
      const status = error.code === "E_WAVEFORM_NO_AUDIO" ? 422 : 500;
      throw new ReplyError(status, error.code, error.message, [{ severity: "error", message: error.message, hint: error.hint }]);
    }
  };

  const events = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(": conectado\n\n");
    clients.add(res);
    ensureWatcher();
    req.on("close", () => clients.delete(res));
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    let pathname: string;
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
      pathname = decodeURIComponent(url.pathname);
    } catch {
      send(res, 400, "caminho inválido\n", "text/plain; charset=utf-8");
      return;
    }
    if (pathname.includes("\0")) {
      send(res, 400, "caminho inválido\n", "text/plain; charset=utf-8");
      return;
    }

    if (method === "GET") {
      if (pathname === "/api/composition") {
        sendJson(res, 200, await compositionPayload());
        return;
      }
      if (pathname === "/api/blocks") {
        try {
          sendJson(
            res,
            200,
            listBlocks().map(({ slug, name, summary, durationSeconds, tags }) => ({ slug, name, summary, durationSeconds, tags })),
          );
        } catch (error) {
          throw new ReplyError(500, "E_CATALOG", (error as Error).message);
        }
        return;
      }
      const waveformMatch = /^\/api\/waveform\/([^/]+)$/.exec(pathname);
      if (waveformMatch !== null) {
        await waveform(waveformMatch[1]!, res);
        return;
      }
      const captionsMatch = /^\/api\/captions\/([^/]+)$/.exec(pathname);
      if (captionsMatch !== null) {
        await listCaptions(captionsMatch[1]!, res);
        return;
      }
      if (pathname === "/api/history") {
        sendJson(res, 200, history.state());
        return;
      }
      if (pathname === "/api/motion/presets") {
        sendJson(res, 200, Object.fromEntries(MOTION_KINDS.map((kind) => [kind, describePresets(kind)])));
        return;
      }
      if (pathname.startsWith(MOTION_PREFIX)) {
        // Só `<preset>.gif` de um preset que existe: o nome vira caminho, então nada de `..` nem de barra.
        const file = pathname.slice(MOTION_PREFIX.length);
        const name = file.endsWith(".gif") ? file.slice(0, -4) : "";
        if (!listPresets().some((preset) => preset.name === name)) {
          send(res, 404, "não encontrado\n", "text/plain; charset=utf-8");
          return;
        }
        send(res, 200, await readFile(motionThumbPath(name)), "image/gif");
        return;
      }
      if (pathname === "/api/events") {
        events(req, res);
        return;
      }
      if (pathname === "/api/export") {
        sendJson(res, 200, { job: exporter.job(), defaults: exporter.defaults() });
        return;
      }
      if (pathname === "/preview") {
        try {
          const loaded = await loadPreview();
          send(res, 200, loaded.html, "text/html; charset=utf-8");
        } catch (error) {
          throw new ReplyError(500, errorCode(error), (error as Error).message);
        }
        return;
      }
      if (pathname.startsWith(MEDIA_PREFIX)) {
        await serveAsset(res, preview === undefined ? undefined : preview.prepared.mediaDir, pathname.slice(MEDIA_PREFIX.length));
        return;
      }
      if (pathname.startsWith(SITE_PREFIX)) {
        const relative = pathname.slice(SITE_PREFIX.length);
        // Arquivo oculto do projeto (.env, .git) nunca sai pelo preview.
        if (relative.split(/[\\/]/).some((part) => part.startsWith("."))) {
          send(res, 403, "arquivo oculto\n", "text/plain; charset=utf-8");
          return;
        }
        await serveAsset(res, entryDir, relative);
        return;
      }
      if (pathname.startsWith(FONTS_PREFIX)) {
        await serveAsset(res, resolve(assetPath("fonts")), pathname.slice(FONTS_PREFIX.length));
        return;
      }
      if (pathname.startsWith(AUDIO_PREFIX)) {
        // Só a chave do mix (sha256): nada de caminho vindo da URL.
        const name = pathname.slice(AUDIO_PREFIX.length);
        if (!AUDIO_NAME.test(name)) {
          send(res, 404, "não encontrado\n", "text/plain; charset=utf-8");
          return;
        }
        await serveAsset(res, audioCacheDir, name);
        return;
      }
      if (pathname === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      if (Object.hasOwn(STUDIO_FILES, pathname)) {
        await serveStatic(res, pathname);
        return;
      }
      send(res, 404, "não encontrado\n", "text/plain; charset=utf-8");
      return;
    }

    if (method === "POST") {
      if (pathname.startsWith("/api/clips/")) {
        const rest = pathname.slice("/api/clips/".length);
        const splitMatch = /^([^/]+)\/split$/.exec(rest);
        if (splitMatch !== null) {
          await serial(() => split(splitMatch[1]!, req, res));
          return;
        }
        const copyMatch = /^([^/]+)\/(duplicate|paste)$/.exec(rest);
        if (copyMatch !== null) {
          await serial(() => copy(copyMatch[1]!, copyMatch[2] as "duplicate" | "paste", req, res));
          return;
        }
        const trimMatch = /^([^/]+)\/trim$/.exec(rest);
        if (trimMatch !== null) {
          await serial(() => trim(trimMatch[1]!, req, res));
          return;
        }
        const deleteMatch =/^([^/]+)\/delete$/.exec(rest);
        if (deleteMatch !== null) {
          await serial(() => remove(deleteMatch[1]!, req, res));
          return;
        }
        const transitionMatch = /^([^/]+)\/transition$/.exec(rest);
        if (transitionMatch !== null) {
          await serial(() => transition(transitionMatch[1]!, req, res));
          return;
        }
        const keyframesMatch = /^([^/]+)\/keyframes$/.exec(rest);
        if (keyframesMatch !== null) {
          await serial(() => keyframes(keyframesMatch[1]!, req, res));
          return;
        }
        if (rest === "" || rest.includes("/")) {
          send(res, 400, "clip inválido\n", "text/plain; charset=utf-8");
          return;
        }
        await serial(() => patchClip(rest, req, res));
        return;
      }
      const captionMatch = /^\/api\/captions\/([^/]+)\/([^/]+)$/.exec(pathname);
      if (captionMatch !== null) {
        await serial(() => editCaption(captionMatch[1]!, captionMatch[2]!, req, res));
        return;
      }
      if (pathname === "/api/clips") {
        await serial(() => insertClip(req, res));
        return;
      }
      if (pathname === "/api/composition") {
        await serial(() => patchComposition(req, res));
        return;
      }
      if (pathname === "/api/blocks") {
        await serial(() => insertBlock(req, res));
        return;
      }
      if (pathname === "/api/media") {
        await serial(() => importMedia(url, req, res));
        return;
      }
      // Export fora de `serial()`: o pipeline lê o arquivo uma vez no `prepare`; edições depois não o afetam.
      if (pathname === "/api/export") {
        const { id, output } = await exporter.start(objectBody(await bodyJson(req)));
        sendJson(res, 202, { id, output });
        return;
      }
      if (pathname === "/api/export/cancel") {
        await exporter.cancel();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === "/api/export/reveal") {
        await exporter.reveal();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === "/api/undo" || pathname === "/api/redo") {
        const direction = pathname === "/api/undo" ? "undo" : "redo";
        await serial(() => travel(direction, res));
        return;
      }
      send(res, 404, "não encontrado\n", "text/plain; charset=utf-8");
      return;
    }

    send(res, 405, "método não permitido\n", "text/plain; charset=utf-8");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof ReplyError || error instanceof ExportError) {
        sendJson(res, error.status, {
          code: error.code,
          message: error.message,
          ...(error.diagnostics !== undefined ? { diagnostics: error.diagnostics } : {}),
        });
        return;
      }
      sendJson(res, 500, { code: errorCode(error), message: (error as Error).message });
    });
  });

  const listening = Promise.withResolvers<void>();
  const onError = (error: Error): void => listening.reject(error);
  server.once("error", onError);
  server.listen(port, "127.0.0.1", () => {
    server.off("error", onError);
    listening.resolve();
  });
  await listening.promise;
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      if (debounce !== undefined) clearTimeout(debounce);
      debounce = undefined;
      watcher?.close();
      watcher = undefined;
      // Fechar o Studio com export rodando aborta o render e espera a limpeza.
      await exporter.close();
      for (const client of clients) client.end();
      clients.clear();
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      await closed.promise;
    },
  };
}
