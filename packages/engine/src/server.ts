// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { assetPath } from "./home.ts";
import type { AddressInfo } from "node:net";
import { injectEngine } from "./inject.ts";
import type { MediaManifest } from "./media.ts";

const DEFAULT_FONTS = assetPath("fonts");

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

export interface StaticServer {
  url: string;
  /** Avisa os clientes do preview que o arquivo mudou. */
  notify: () => void;
  close: () => Promise<void>;
}

export interface ServerOptions {
  /** Diretório servido em `/__ff_media/` com os frames já extraídos. */
  mediaRoot?: string;
  manifest?: MediaManifest;
  disableMediaShim?: boolean;
  /** Diretório das fontes embarcadas servido em `/__ff_fonts/`. `null` desliga. */
  fontsRoot?: string | null;
  /** HTML já compilado que substitui o arquivo de entrada. */
  page?: { path: string; html: string };
  /** Preview: relógio em tempo real + recarga por SSE. */
  live?: boolean;
}

const MEDIA_PREFIX = "/__ff_media/";
const FONTS_PREFIX = "/__ff_fonts/";

/**
 * Serve a composição por HTTP: `file://` não carrega fonte/mídia com as mesmas
 * regras e não permite trocar mídia depois. Todo HTML recebe o relógio virtual,
 * as fontes embarcadas e o shim de mídia antes de qualquer script do autor.
 */
export async function startServer(rootDir: string, options: ServerOptions = {}): Promise<StaticServer> {
  const clients = new Set<import("node:http").ServerResponse>();
  const roots = {
    site: resolve(rootDir),
    media: options.mediaRoot ? resolve(options.mediaRoot) : undefined,
    fonts: options.fontsRoot === null ? undefined : resolve(options.fontsRoot ?? DEFAULT_FONTS),
  };

  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/__ff_reload") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        response.write(": conectado\n\n");
        clients.add(response);
        request.on("close", () => clients.delete(response));
        return;
      }
      if (pathname === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }

      const isMedia = pathname.startsWith(MEDIA_PREFIX);
      const isFont = pathname.startsWith(FONTS_PREFIX);
      const base = isMedia ? roots.media : isFont ? roots.fonts : roots.site;
      if (!base) {
        response.writeHead(404).end("rota não configurada");
        return;
      }

      const relative = decodeURIComponent(
        isMedia
          ? pathname.slice(MEDIA_PREFIX.length - 1)
          : isFont
            ? pathname.slice(FONTS_PREFIX.length - 1)
            : pathname === "/"
              ? "/index.html"
              : pathname,
      );
      const file = normalize(join(base, relative));
      if (file !== base && !file.startsWith(base.endsWith(sep) ? base : base + sep)) {
        response.writeHead(403).end("fora da raiz");
        return;
      }

      const isEntry = options.page !== undefined && (pathname === "/" || pathname === `/${options.page.path}`);
      const raw = isEntry ? Buffer.from(options.page!.html) : await readFile(file);
      const type = isEntry ? "text/html; charset=utf-8" : (MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
      const body = type.startsWith("text/html")
        ? Buffer.from(
            injectEngine(raw.toString("utf8"), {
              manifest: options.manifest,
              disableMediaShim: options.disableMediaShim,
              fontsBase: roots.fonts ? FONTS_PREFIX.slice(0, -1) : null,
              ...(options.live === true ? { live: true } : {}),
            }),
          )
        : raw;
      response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
    } catch {
      response.writeHead(404).end("não encontrado");
    }
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    notify: () => {
      for (const client of clients) client.write("data: reload\n\n");
    },
    close: async () => {
      for (const client of clients) client.end();
      clients.clear();
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      return closed.promise;
    },
  };
}
