// FrankFrames — proprietário. Ver LICENSE na raiz.
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describePresets, listPresets, loadComposition, parseComposition, parseMotionValue } from "@frankframes/contract";
import type { MotionKind, MotionSource, ResolvedClip } from "@frankframes/contract";
import { assetPath, injectEngine, probeDuration } from "@frankframes/engine";
import type { PreviewAudioConfig } from "@frankframes/engine";
import {
  applyPatches,
  applyTransition,
  EditError,
  explicitClipIds,
  prepare,
  PreviewAudioError,
  renderPreviewAudio,
  resolveFfmpeg,
  splitClip,
} from "@frankframes/producer";
import type { ClipPatch, PreparedComposition } from "@frankframes/producer";
import { listBlocks, motionThumbPath } from "@frankframes/catalog";
import { HistoryStaleError, StudioHistory } from "./studio-history.ts";
import { IMAGE_SECONDS, MediaUploadError, mediaKind, mediaMarkup, storeMedia, supportedExtensions } from "./studio-media.ts";

export interface StudioServer {
  url: string;
  close: () => Promise<void>;
}

export interface StudioOptions {
  entry: string;
  port?: number;
  /** Cache dos mixes de preview; padrão `cache/preview-audio` do FRANKFRAMES_HOME. */
  audioCacheDir?: string;
}

const STUDIO_DIR = fileURLToPath(new URL("./studio/", import.meta.url));
const STUDIO_FILES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/timeline-math.js": "timeline-math.js",
  "/motion.js": "motion.js",
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
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`porta inválida: ${String(options.port)}`);
  }
  const info = await stat(entryPath).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`entrada inacessível: ${entryPath} (${error.code ?? error.message})`, { cause: error });
  });
  if (!info.isFile()) throw new Error(`entrada não é arquivo: ${entryPath}`);

  const clients = new Set<ServerResponse>();
  const workDirs = new Set<string>();
  let watcher: FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let preview: { mtimeMs: number; prepared: PreparedComposition; html: string } | undefined;
  let tmpCounter = 0;
  const history = new StudioHistory();
  let mutations: Promise<unknown> = Promise.resolve();
  let ffprobe: Promise<string> | undefined;

  /** Uma escrita por vez: leitura-modificação-escrita do mesmo arquivo não pode intercalar. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = mutations.then(task, task);
    mutations = run.catch(() => undefined);
    return run;
  };

  const ffprobePath = (): Promise<string> => {
    const pending = ffprobe ?? resolveFfmpeg().then((pair) => pair.ffprobe);
    // Falha não fica em cache: a próxima importação tenta resolver de novo.
    ffprobe = pending;
    pending.catch(() => {
      if (ffprobe === pending) ffprobe = undefined;
    });
    return pending;
  };

  const ensureWatcher = (): void => {
    if (watcher !== undefined) return;
    watcher = watch(entryDir, (_event, filename) => {
      if (filename !== null && String(filename) !== entryName) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = undefined;
        for (const client of clients) client.write("data: change\n\n");
      }, 80);
      debounce.unref();
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
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  };

  /** Grava uma versão nova e registra no histórico. */
  const commit = async (label: string, before: string, after: string): Promise<void> => {
    await writeAtomic(entryPath, after);
    history.record(label, before, after);
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
    if (preview !== undefined && preview.mtimeMs === current.mtimeMs) {
      return { prepared: preview.prepared, html: preview.html };
    }
    const workDir = await mkdtemp(join(tmpdir(), "ff-studio-"));
    workDirs.add(workDir);
    const prepared = await prepare({ entry: entryPath, workDir });
    const audio = await previewAudioConfig(prepared);
    const html = injectEngine(prepared.compiledHtml, {
      manifest: prepared.manifest,
      fontsBase: "/__ff_fonts",
      live: true,
      ...(audio !== null ? { audio } : {}),
      // O Studio recarrega pelo próprio /api/events; a barra não abre /__ff_reload (404 aqui).
      preview: { fps: prepared.fps, frames: prepared.totalFrames, id: prepared.composition.id, reload: false },
    }).replace(/<head[^>]*>/i, (head) => `${head}<base href="${SITE_PREFIX}">`);
    preview = { mtimeMs: current.mtimeMs, prepared, html };
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
    const info = await stat(target).catch(() => undefined);
    if (info === undefined || !info.isFile()) {
      send(res, 404, "não encontrado\n", "text/plain; charset=utf-8");
      return;
    }
    send(res, 200, await readFile(target), MIME[extname(target).toLowerCase()] ?? "application/octet-stream");
  };

  const compositionPayload = async (): Promise<unknown> => {
    const source = await readFile(entryPath, "utf8");
    const composition = loadComposition(source);
    const explicit = explicitClipIds(source);
    // Elemento próprio de cada clip (ordinal 0): é o que o inspetor edita.
    const ownMotion = new Map<string, MotionSource>();
    for (const item of parseComposition(source).motion) {
      if (item.own && item.ordinal === 0) ownMotion.set(item.clipId, item);
    }
    return {
      entry: entryPath,
      id: composition.id,
      fps: composition.fps,
      duration: composition.duration.kind === "unresolved" ? null : composition.duration.seconds,
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
        keyframes: ownMotion.get(clip.id)?.keyframes ?? null,
        hasChildren: clip.children.length > 0 || clip.isSubComposition,
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

  const insertClip = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = objectBody(await bodyJson(req));
    const template = body.template;
    if (template !== "title" && template !== "subtitle") {
      throw new ReplyError(400, "E_TEMPLATE_INVALID", 'template precisa ser "title" ou "subtitle"');
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
    const markup = `\n  <div data-clip-id="${id}" data-start="${start}" data-duration="${duration}" class="clip">Texto</div>\n`;
    const next = source.slice(0, root.index) + markup + source.slice(root.index);

    validated(next, "o clip novo deixaria o contrato inválido");
    await commit(`inserir ${template}`, source, next);
    sendJson(res, 200, { ok: true, id, history: history.state() });
  };

  /** `POST /api/media?name=<arquivo>&start=<s>` com o arquivo cru no corpo. */
  const importMedia = async (url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const name = url.searchParams.get("name") ?? "";
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
    if (kind !== "img") {
      try {
        duration = Math.round((await probeDuration(await ffprobePath(), stored.file)) * 1e6) / 1e6;
      } catch (error) {
        await discard();
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
    sendJson(res, 200, { ok: true, id, src: stored.src, kind, duration, reused: !stored.created, history: history.state() });
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

  const travel = async (direction: "undo" | "redo", res: ServerResponse): Promise<void> => {
    const current = await readFile(entryPath, "utf8");
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
      await writeAtomic(entryPath, target);
    } catch (error) {
      history.revert(direction);
      throw error;
    }
    sendJson(res, 200, { ok: true, changed: true, duration: durationOf(loadComposition(target)), history: history.state() });
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
        const transitionMatch = /^([^/]+)\/transition$/.exec(rest);
        if (transitionMatch !== null) {
          await serial(() => transition(transitionMatch[1]!, req, res));
          return;
        }
        if (rest === "" || rest.includes("/")) {
          send(res, 400, "clip inválido\n", "text/plain; charset=utf-8");
          return;
        }
        await serial(() => patchClip(rest, req, res));
        return;
      }
      if (pathname === "/api/clips") {
        await serial(() => insertClip(req, res));
        return;
      }
      if (pathname === "/api/media") {
        await serial(() => importMedia(url, req, res));
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
      if (error instanceof ReplyError) {
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
      for (const client of clients) client.end();
      clients.clear();
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      await closed.promise;
      for (const dir of workDirs) await rm(dir, { recursive: true, force: true });
      workDirs.clear();
    },
  };
}
