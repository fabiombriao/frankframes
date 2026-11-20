// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import { injectClock } from "./clock.ts";

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
};

export interface StaticServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Serve a composição por HTTP: `file://` não carrega fonte/mídia com as mesmas
 * regras e não permite trocar mídia depois. Todo HTML recebe o relógio virtual
 * antes de qualquer script do autor.
 */
export async function startServer(rootDir: string): Promise<StaticServer> {
  const root = resolve(rootDir);

  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      const relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
      const file = normalize(join(root, relative));
      if (file !== root && !file.startsWith(root + sep)) {
        response.writeHead(403).end("fora da raiz");
        return;
      }

      const raw = await readFile(file);
      const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
      const body = type.startsWith("text/html") ? Buffer.from(injectClock(raw.toString("utf8"))) : raw;
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
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      return closed.promise;
    },
  };
}
