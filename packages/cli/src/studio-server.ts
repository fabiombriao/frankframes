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
import { loadComposition } from "@frankframes/contract";
import type { ResolvedClip } from "@frankframes/contract";
import { assetPath, injectEngine } from "@frankframes/engine";
import { applyPatches, EditError, prepare } from "@frankframes/producer";
import type { ClipPatch, PreparedComposition } from "@frankframes/producer";
import { listBlocks } from "@frankframes/catalog";

export interface StudioServer {
  url: string;
  close: () => Promise<void>;
}

export interface StudioOptions {
  entry: string;
  port?: number;
}

const STUDIO_DIR = fileURLToPath(new URL("./studio/", import.meta.url));
const STUDIO_FILES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};
const MEDIA_PREFIX = "/__ff_media/";
const FONTS_PREFIX = "/__ff_fonts/";
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

function flattenClips(clips: ResolvedClip[]): ResolvedClip[] {
  const out: ResolvedClip[] = [];
  const visit = (list: ResolvedClip[]): void => {
    for (const clip of list) {
      out.push(clip);
      visit(clip.children);
    }
  };
  visit(clips);
  return out;
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

  const loadPreview = async (): Promise<{ prepared: PreparedComposition; html: string }> => {
    const current = await stat(entryPath);
    if (preview !== undefined && preview.mtimeMs === current.mtimeMs) {
      return { prepared: preview.prepared, html: preview.html };
    }
    const workDir = await mkdtemp(join(tmpdir(), "ff-studio-"));
    workDirs.add(workDir);
    const prepared = await prepare({ entry: entryPath, workDir });
    const html = injectEngine(prepared.compiledHtml, {
      manifest: prepared.manifest,
      fontsBase: "/__ff_fonts",
      live: true,
      preview: { fps: prepared.fps, frames: prepared.totalFrames, id: prepared.composition.id },
    });
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
    return {
      entry: entryPath,
      id: composition.id,
      fps: composition.fps,
      duration: composition.duration.kind === "unresolved" ? null : composition.duration.seconds,
      clips: flattenClips(composition.clips).map((clip) => ({
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
    const composition = loadComposition(next);
    if (!composition.ok) {
      throw new ReplyError(400, "E_CONTRACT_INVALID", "a edição deixaria o contrato inválido", composition.diagnostics);
    }
    await writeAtomic(entryPath, next);
    sendJson(res, 200, {
      ok: true,
      duration: composition.duration.kind === "unresolved" ? null : composition.duration.seconds,
      diagnostics: composition.diagnostics,
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

    const composition = loadComposition(next);
    if (!composition.ok) {
      throw new ReplyError(400, "E_CONTRACT_INVALID", "o clip novo deixaria o contrato inválido", composition.diagnostics);
    }
    await writeAtomic(entryPath, next);
    sendJson(res, 200, { ok: true, id });
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
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
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
      if (pathname.startsWith(FONTS_PREFIX)) {
        await serveAsset(res, resolve(assetPath("fonts")), pathname.slice(FONTS_PREFIX.length));
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
        const clipId = pathname.slice("/api/clips/".length);
        if (clipId === "" || clipId.includes("/")) {
          send(res, 400, "clip inválido\n", "text/plain; charset=utf-8");
          return;
        }
        await patchClip(clipId, req, res);
        return;
      }
      if (pathname === "/api/clips") {
        await insertClip(req, res);
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
