// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assetPath, injectEngine } from "@frankframes/engine";
import { prepare } from "@frankframes/producer";
import type { PreparedComposition } from "@frankframes/producer";
import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_ROOT = fileURLToPath(new URL("../../../catalog/blocks/", import.meta.url));
const SLUG = /^[a-z0-9-]+$/;
const MEDIA_PREFIX = "/__ff_media/";
const FONTS_PREFIX = "/__ff_fonts/";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
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

export interface GalleryServer {
  url: string;
  close: () => Promise<void>;
}

interface BlockCard {
  slug: string;
  name: string;
  seconds: number | undefined;
  format: string;
}

function send(res: ServerResponse, status: number, body: string | Buffer, contentType: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Código de erro do `prepare` para a resposta 500; nunca inventa detalhe. */
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "E_PREPARE";
}

/** Resolve `relative` abaixo de `root`; devolve `undefined` quando escapa. */
function inside(root: string, relative: string): string | undefined {
  const target = resolve(root, relative);
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep) ? target : undefined;
}

async function readMeta(dir: string): Promise<{ name?: string; seconds?: number }> {
  try {
    const raw = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
    const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name : undefined;
    const seconds =
      typeof raw.durationSeconds === "number" && Number.isFinite(raw.durationSeconds) && raw.durationSeconds > 0
        ? raw.durationSeconds
        : undefined;
    return { ...(name !== undefined ? { name } : {}), ...(seconds !== undefined ? { seconds } : {}) };
  } catch {
    return {};
  }
}

function readFormat(html: string): string {
  const width = Number(/data-width="(\d+)"/.exec(html)?.[1] ?? 0);
  const height = Number(/data-height="(\d+)"/.exec(html)?.[1] ?? 0);
  if (!width || !height) return "16:9";
  return width >= height ? "16:9" : "9:16";
}

async function readBlocks(root: string): Promise<BlockCard[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const slugs = entries
    .filter((entry) => entry.isDirectory() && SLUG.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const cards: BlockCard[] = [];
  for (const slug of slugs) {
    const dir = join(root, slug);
    const meta = await readMeta(dir);
    const html = await readFile(join(dir, "index.html"), "utf8").catch(() => "");
    cards.push({
      slug,
      name: meta.name ?? slug,
      seconds: meta.seconds,
      format: readFormat(html),
    });
  }
  return cards;
}

function galleryHtml(cards: BlockCard[]): string {
  const items = cards
    .map((card) => {
      const duration = card.seconds === undefined ? "—" : `${card.seconds}s`;
      return `<a class="card" href="/view/${card.slug}">
<div class="thumb"><img src="/thumb/${card.slug}.png" alt="${escapeHtml(card.name)}" loading="lazy"></div>
<div class="meta"><h2>${escapeHtml(card.name)}</h2><p><span>${escapeHtml(duration)}</span><span>${escapeHtml(card.format)}</span><span class="slug">${card.slug}</span></p></div>
</a>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Galeria · FrankFrames</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #0d0d0c; color: #f4f1e8; font-family: system-ui, sans-serif; }
  body { padding: 40px 32px 64px; }
  header { max-width: 1440px; margin: 0 auto 28px; border-bottom: 1px solid rgba(244, 241, 232, 0.16); padding-bottom: 18px; }
  header h1 { font-size: 22px; letter-spacing: 0.02em; margin: 0 0 6px; font-weight: 600; }
  header p { margin: 0; font-size: 13px; color: rgba(244, 241, 232, 0.56); }
  main { max-width: 1440px; margin: 0 auto; display: grid; gap: 18px; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); }
  .card { display: block; text-decoration: none; color: inherit; background: #151513; border: 1px solid rgba(244, 241, 232, 0.12); border-radius: 6px; overflow: hidden; }
  .card:hover { border-color: rgba(244, 241, 232, 0.4); }
  .thumb { aspect-ratio: 16 / 9; background: #090908; }
  .thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .meta { padding: 12px 14px 14px; }
  .meta h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
  .meta p { margin: 0; display: flex; gap: 10px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(244, 241, 232, 0.52); }
  .meta .slug { margin-left: auto; text-transform: none; letter-spacing: 0; }
</style>
</head>
<body>
<header><h1>Galeria de blocos</h1><p>${cards.length} bloco(s) · prévia ao vivo em cada cartão</p></header>
<main>
${items}
</main>
</body>
</html>
`;
}

async function sendFile(res: ServerResponse, base: string, relative: string): Promise<boolean> {
  const target = inside(base, relative);
  if (target === undefined) {
    send(res, 403, "acesso negado\n", "text/plain; charset=utf-8");
    return true;
  }
  const info = await stat(target).catch(() => undefined);
  if (info === undefined || !info.isFile()) return false;
  const body = await readFile(target);
  send(res, 200, body, MIME[extname(target).toLowerCase()] ?? "application/octet-stream");
  return true;
}

/**
 * Galeria local do catálogo: grade de cartões, thumbs e prévia ao vivo de cada
 * bloco servida pelo mesmo pipeline do `preview`.
 */
export async function startGallery(options: { root?: string; port?: number } = {}): Promise<GalleryServer> {
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const fontsRoot = resolve(assetPath("fonts"));
  const prepared = new Map<string, Promise<PreparedComposition>>();

  const load = (slug: string, indexHtml: string): Promise<PreparedComposition> => {
    const cached = prepared.get(slug);
    if (cached !== undefined) return cached;
    const pending = prepare({ entry: indexHtml });
    prepared.set(slug, pending);
    pending.catch(() => prepared.delete(slug));
    return pending;
  };

  async function mediaDirs(): Promise<string[]> {
    const dirs: string[] = [];
    for (const pending of prepared.values()) {
      const result = await pending.catch(() => undefined);
      if (result?.mediaDir !== undefined) dirs.push(resolve(result.mediaDir));
    }
    return dirs;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      send(res, 405, "método não permitido\n", "text/plain; charset=utf-8");
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      send(res, 400, "caminho inválido\n", "text/plain; charset=utf-8");
      return;
    }
    if (pathname.includes("\0")) {
      send(res, 400, "caminho inválido\n", "text/plain; charset=utf-8");
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      send(res, 200, galleryHtml(await readBlocks(root)), "text/html; charset=utf-8");
      return;
    }

    if (pathname.startsWith(FONTS_PREFIX)) {
      if (!(await sendFile(res, fontsRoot, pathname.slice(FONTS_PREFIX.length)))) {
        send(res, 404, "fonte não encontrada\n", "text/plain; charset=utf-8");
      }
      return;
    }

    if (pathname.startsWith(MEDIA_PREFIX)) {
      const relative = pathname.slice(MEDIA_PREFIX.length);
      for (const dir of await mediaDirs()) {
        if (await sendFile(res, dir, relative)) return;
      }
      send(res, 404, "mídia não encontrada\n", "text/plain; charset=utf-8");
      return;
    }

    if (pathname.startsWith("/thumb/")) {
      const match = /^\/thumb\/([a-z0-9-]+)\.png$/.exec(pathname);
      if (!match) {
        send(res, 400, "slug inválido\n", "text/plain; charset=utf-8");
        return;
      }
      const slug = match[1]!;
      const file = inside(root, join(slug, "thumb.png"));
      if (file === undefined) {
        send(res, 403, "acesso negado\n", "text/plain; charset=utf-8");
        return;
      }
      const info = await stat(file).catch(() => undefined);
      if (info === undefined || !info.isFile()) {
        send(res, 404, "thumb não encontrada\n", "text/plain; charset=utf-8");
        return;
      }
      send(res, 200, await readFile(file), "image/png");
      return;
    }

    if (pathname.startsWith("/view/")) {
      const match = /^\/view\/([a-z0-9-]+)$/.exec(pathname);
      if (!match) {
        send(res, 400, "slug inválido\n", "text/plain; charset=utf-8");
        return;
      }
      const slug = match[1]!;
      const entry = inside(root, join(slug, "index.html"));
      if (entry === undefined) {
        send(res, 403, "acesso negado\n", "text/plain; charset=utf-8");
        return;
      }
      const info = await stat(entry).catch(() => undefined);
      if (info === undefined || !info.isFile()) {
        send(res, 404, "bloco não encontrado\n", "text/plain; charset=utf-8");
        return;
      }

      try {
        const composition = await load(slug, entry);
        const html = injectEngine(composition.compiledHtml, {
          ...(composition.manifest !== undefined ? { manifest: composition.manifest } : {}),
          fontsBase: "/__ff_fonts",
          live: true,
          preview: { fps: composition.fps, frames: composition.totalFrames },
        });
        send(res, 200, html, "text/html; charset=utf-8");
      } catch (error) {
        send(res, 500, `${errorCode(error)}\n`, "text/plain; charset=utf-8");
      }
      return;
    }

    send(res, 404, "não encontrado\n", "text/plain; charset=utf-8");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "erro interno\n", "text/plain; charset=utf-8");
      else res.end();
    });
  });

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(options.port ?? 0, "127.0.0.1", () => {
    server.off("error", listening.reject);
    listening.resolve();
  });
  await listening.promise;

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error(`galeria não abriu uma porta TCP em ${root}`);
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      server.closeAllConnections();
      await closed.promise;
    },
  };
}
