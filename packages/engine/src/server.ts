// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createServer } from "node:http";
import { readFile as nodeReadFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { assetPath } from "./home.ts";
import type { AddressInfo } from "node:net";
import { injectEngine } from "./inject.ts";
import type { PreviewAudioConfig } from "./inject.ts";
import type { Injection } from "./inject.ts";

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

/** Falha de leitura de arquivo no servidor: cada tentativa extra e cada falha final ficam registradas. */
export interface ServerFailure {
  /** Caminho da URL pedida (sem a raiz do disco). */
  path: string;
  /** Código do erro do sistema (EBUSY, EPERM, EACCES, ...). */
  code: string;
  /** Tentativa que falhou, começando em 1. */
  attempt: number;
  /** `retry`: vai tentar de novo; `failed`: respondeu 500. */
  outcome: "retry" | "failed";
}

export interface StaticServer {
  url: string;
  /** Avisa os clientes do preview que o arquivo mudou. */
  notify: () => void;
  /** Falhas recentes de leitura (as últimas 50), da mais antiga para a mais nova. */
  failures: () => ServerFailure[];
  close: () => Promise<void>;
}

export interface ServerOptions {
  /** Diretório servido em `/__ff_media/` com os frames já extraídos. */
  mediaRoot?: string;
  manifest?: Injection["manifest"];
  disableMediaShim?: boolean;
  /** Diretório das fontes embarcadas servido em `/__ff_fonts/`. `null` desliga. */
  fontsRoot?: string | null;
  /** HTML já compilado que substitui o arquivo de entrada. */
  page?: { path: string; html: string };
  /** Preview: relógio em tempo real + recarga por SSE. */
  live?: boolean;
  /** Preview com barra de controle (fps e total de frames). */
  preview?: { fps: { num: number; den: number }; frames: number; id?: string; autoplay?: boolean };
  /** Áudio do preview injetado na página (veja `Injection.audio`). */
  audio?: PreviewAudioConfig;
  /** Diretório dos mixes de preview servido em `/__ff_audio/<sha256>.wav`. */
  audioDir?: string;
  /** Leitura de arquivo. Só existe para o teste provar o retry e o 500 sem travar um arquivo de verdade. */
  readFile?: (path: string) => Promise<Buffer>;
  /** Destino do registro de falhas de leitura, uma linha por evento (padrão: stderr). */
  log?: (line: string) => void;
}

/**
 * Erros do sistema que costumam ser passageiros no Windows (sincronizador de pasta,
 * antivírus segurando o arquivo): a única leitura que se repete, e só estas.
 */
const TRANSIENT_READ_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
/** Espera antes de cada nova tentativa: no máximo 3 tentativas extras. */
const READ_RETRY_DELAYS_MS = [50, 100, 200];
/** Arquivo que não existe: 404. Qualquer outro erro de leitura é 500 com o código. */
const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
const MAX_FAILURES = 50;

/** Arquivo de fonte pela extensão: vale para as embarcadas e para `@font-face` do autor. */
const FONT_PATH = /\.(woff2?|ttf|otf)$/i;

const MEDIA_PREFIX = "/__ff_media/";
const FONTS_PREFIX = "/__ff_fonts/";
const AUDIO_PREFIX = "/__ff_audio/";
/** O mix só é endereçado pela chave (sha256 hex): nada de caminho vindo da URL. */
const AUDIO_NAME = /^[0-9a-f]{64}\.wav$/;

/**
 * Serve a composição por HTTP: `file://` não carrega fonte/mídia com as mesmas
 * regras e não permite trocar mídia depois. Todo HTML recebe o relógio virtual,
 * as fontes embarcadas e o shim de mídia antes de qualquer script do autor.
 */
export async function startServer(rootDir: string, options: ServerOptions = {}): Promise<StaticServer> {
  const clients = new Set<import("node:http").ServerResponse>();
  const failures: ServerFailure[] = [];
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const record = (failure: ServerFailure): void => {
    failures.push(failure);
    if (failures.length > MAX_FAILURES) failures.shift();
    // Falha de leitura é rara e importa: fica no log do processo (no gate, em out/ci-suite.log).
    const next = failure.outcome === "retry" ? "vai repetir" : "sem sucesso";
    log(`[frankframes] servidor: ${failure.code} ao ler ${failure.path} (tentativa ${failure.attempt}, ${next})`);
  };
  const readFile = options.readFile ?? ((path: string) => nodeReadFile(path));
  /** Lê o arquivo; repete só erro passageiro, no máximo 3 vezes, e registra cada tentativa. */
  const readAsset = async (file: string, path: string): Promise<Buffer> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await readFile(file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (!TRANSIENT_READ_CODES.has(code)) throw error;
        const delay = READ_RETRY_DELAYS_MS[attempt - 1];
        record({ path, code, attempt, outcome: delay === undefined ? "failed" : "retry" });
        if (delay === undefined) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      }
    }
  };
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
      if (pathname.startsWith(AUDIO_PREFIX)) {
        const name = pathname.slice(AUDIO_PREFIX.length);
        if (options.audioDir === undefined || !AUDIO_NAME.test(name)) {
          response.writeHead(404).end("não encontrado");
          return;
        }
        const wav = await readAsset(join(resolve(options.audioDir), name), pathname);
        response.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store" }).end(wav);
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
      const raw = isEntry ? Buffer.from(options.page!.html) : await readAsset(file, pathname);
      const type = isEntry ? "text/html; charset=utf-8" : (MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
      const body = type.startsWith("text/html")
        ? Buffer.from(
            injectEngine(raw.toString("utf8"), {
              manifest: options.manifest,
              disableMediaShim: options.disableMediaShim,
              fontsBase: roots.fonts ? FONTS_PREFIX.slice(0, -1) : null,
              ...(options.live === true ? { live: true } : {}),
              ...(options.preview !== undefined ? { preview: options.preview } : {}),
              ...(options.audio !== undefined ? { audio: options.audio } : {}),
            }),
          )
        : raw;
      response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (error instanceof URIError) {
        response.writeHead(400).end("URL inválida");
      } else if (code !== undefined && NOT_FOUND_CODES.has(code)) {
        // Fonte declarada que não existe é falha de autoria e precisa aparecer no registro: sem ele,
        // "A network error occurred" de um 404 e de uma queda de conexão ficam indistinguíveis (EDT-72).
        const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        if (FONT_PATH.test(path)) record({ path, code, attempt: 1, outcome: "failed" });
        response.writeHead(404).end("não encontrado");
      } else {
        // Qualquer outro erro é falha do servidor, não "arquivo ausente": o corpo traz o código.
        const detail = code ?? (error instanceof Error ? error.message : String(error));
        const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        if (code === undefined || !TRANSIENT_READ_CODES.has(code)) record({ path, code: detail, attempt: 1, outcome: "failed" });
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(`erro ao servir o arquivo: ${detail}`);
      }
    }
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;

  return {
    url: `http://127.0.0.1:${port}/`,
    failures: () => [...failures],
    notify: () => {
      for (const client of clients) client.write("data: reload\n\n");
    },
    // Idempotente: quem abre a sessão pode ter fechado o servidor numa falha, e o `finally` do chamador fecha de novo.
    close: () => {
      closing ??= (async () => {
        for (const client of clients) client.end();
        clients.clear();
        const closed = Promise.withResolvers<void>();
        server.closeAllConnections();
        server.close((error) => (error ? closed.reject(error) : closed.resolve()));
        await closed.promise;
      })();
      return closing;
    },
  };
}
