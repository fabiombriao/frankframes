// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadComposition } from "@frankframes/contract";

export interface CatalogEntry {
  slug: string;
  name: string;
  summary: string;
  durationSeconds: number;
  /** Dimensões da composição (`data-width`/`data-height` da raiz), para escolher 16:9 × 9:16 sem adivinhar pelo slug. */
  width: number;
  height: number;
  tags: string[];
  sha256: string;
  sizeBytes: number;
}

const BLOCKS_DIR = fileURLToPath(new URL("../../../catalog/blocks/", import.meta.url));
const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const FILES = ["index.html", "meta.json", "thumb.png"] as const;

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: esperado objeto JSON`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where}: "${field}" precisa ser texto não vazio`);
  return value;
}

/** Lê `catalog/blocks/*` e devolve o índice publicado, validando o sha256 do HTML. */
export async function buildCatalogIndex(): Promise<CatalogEntry[]> {
  let entries: string[];
  try {
    entries = (await readdir(BLOCKS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && SLUG.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch (error) {
    throw new Error(`diretório do catálogo ausente: ${BLOCKS_DIR} (${(error as Error).message})`);
  }

  return Promise.all(entries.map(async (slug) => readEntry(slug)));
}

async function readEntry(slug: string): Promise<CatalogEntry> {
  const dir = join(BLOCKS_DIR, slug);
  const metaPath = join(dir, "meta.json");
  let raw: Record<string, unknown>;
  try {
    raw = record(JSON.parse(await readFile(metaPath, "utf8")), metaPath);
  } catch (error) {
    throw new Error(`${slug}: meta.json ilegível em ${metaPath} (${(error as Error).message})`);
  }

  const name = text(raw.name, "name", `${slug}: meta.json`);
  const summary = text(raw.summary, "summary", `${slug}: meta.json`);
  if (typeof raw.durationSeconds !== "number" || !Number.isFinite(raw.durationSeconds) || raw.durationSeconds <= 0) {
    throw new Error(`${slug}: meta.json: "durationSeconds" precisa ser número > 0`);
  }
  if (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== "string")) {
    throw new Error(`${slug}: meta.json: "tags" precisa ser array de textos`);
  }
  if (typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(raw.sha256)) {
    throw new Error(`${slug}: meta.json: "sha256" precisa ser um hex SHA-256 do index.html`);
  }

  const html = await readFile(join(dir, "index.html")).catch((error: Error) => {
    throw new Error(`${slug}: index.html ilegível (${error.message})`);
  });
  const sha256 = createHash("sha256").update(html).digest("hex");
  if (sha256 !== raw.sha256.toLowerCase()) {
    throw new Error(
      `${slug}: "sha256" do meta.json divergente do index.html (meta ${raw.sha256.toLowerCase()}, html ${sha256})`,
    );
  }

  const { width, height } = loadComposition(html.toString("utf8"));
  if (width === undefined || height === undefined) throw new Error(`${slug}: bloco sem data-width/data-height`);

  return {
    slug,
    name,
    summary,
    durationSeconds: raw.durationSeconds,
    width,
    height,
    tags: raw.tags as string[],
    sha256,
    sizeBytes: html.byteLength,
  };
}

/** Copia o catálogo para `destination` e escreve `<destination>/index.json`. */
export async function publishCatalog(destination: string): Promise<{ files: number; bytes: number }> {
  const index = await buildCatalogIndex();
  const target = resolve(destination);
  await mkdir(target, { recursive: true });

  let files = 0;
  let bytes = 0;
  for (const entry of index) {
    const blockDir = join(BLOCKS_DIR, entry.slug);
    const outputDir = join(target, entry.slug);
    await mkdir(outputDir, { recursive: true });
    for (const file of FILES) {
      const source = join(blockDir, file);
      const info = await stat(source).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`${entry.slug}: arquivo obrigatório ausente no bloco: ${file}`);
      await copyFile(source, join(outputDir, file));
      files += 1;
      bytes += info.size;
    }
  }

  const indexJson = `${JSON.stringify(index, null, 2)}\n`;
  await writeFile(join(target, "index.json"), indexJson, "utf8");
  files += 1;
  bytes += Buffer.byteLength(indexJson);
  return { files, bytes };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function send(res: ServerResponse, status: number, body: string | Buffer, contentType: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

async function handle(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  const relative = pathname.replace(/^\/+/, "");
  const target = resolve(root, relative);
  if (isAbsolute(relative) || (target !== root && !target.startsWith(root + sep))) {
    send(res, 403, "acesso negado\n", "text/plain; charset=utf-8");
    return;
  }

  let file = target;
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    send(res, 200, method === "HEAD" ? Buffer.alloc(0) : body, MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
  } catch {
    send(res, 404, "não encontrado\n", "text/plain; charset=utf-8");
  }
}

/** Serve um diretório publicado em `127.0.0.1` numa porta livre. */
export interface CatalogServer {
  url: string;
  close: () => Promise<void>;
}

export async function serveCatalog(root: string, port = 0): Promise<CatalogServer> {
  const base = resolve(root);
  const server = createServer((req, res) => {
    handle(base, req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "erro interno\n", "text/plain; charset=utf-8");
      else res.end();
    });
  });

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(port, "127.0.0.1", () => {
    server.off("error", listening.reject);
    listening.resolve();
  });
  await listening.promise;

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error(`servidor não abriu uma porta TCP em ${base}`);
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      server.closeAllConnections();
      return closed.promise;
    },
  };
}
