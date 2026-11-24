// FrankFrames — proprietário. Ver LICENSE na raiz.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { cp } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface BlockMeta {
  slug: string;
  name: string;
  summary: string;
  durationSeconds: number;
  tags: string[];
  /** Caminho absoluto do diretório do bloco. */
  dir: string;
}

const BLOCKS_DIR = fileURLToPath(new URL("../../../catalog/blocks/", import.meta.url));
const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

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

function readMeta(file: string, slug: string): BlockMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: meta.json ilegível (${(error as Error).message})`);
  }
  const raw = record(parsed, file);
  const name = text(raw.name, "name", file);
  const summary = text(raw.summary, "summary", file);
  if (typeof raw.durationSeconds !== "number" || !Number.isFinite(raw.durationSeconds) || raw.durationSeconds <= 0) {
    throw new Error(`${file}: "durationSeconds" precisa ser número > 0`);
  }
  if (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== "string")) {
    throw new Error(`${file}: "tags" precisa ser array de textos`);
  }
  return {
    slug,
    name,
    summary,
    durationSeconds: raw.durationSeconds,
    tags: raw.tags as string[],
    dir: resolve(BLOCKS_DIR, slug),
  };
}

/** Lista os blocos do catálogo em ordem alfabética de slug. */
export function listBlocks(): BlockMeta[] {
  if (!existsSync(BLOCKS_DIR)) throw new Error(`diretório do catálogo ausente: ${BLOCKS_DIR}`);
  const slugs = readdirSync(BLOCKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SLUG.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return slugs.map((slug) => readMeta(join(BLOCKS_DIR, slug, "meta.json"), slug));
}

/** Lê um arquivo do bloco (`index.html` por padrão). Lança para slug ou arquivo inválido. */
export function readBlock(slug: string, file = "index.html"): string {
  if (!SLUG.test(slug)) throw new Error(`slug inválido: ${JSON.stringify(slug)}`);
  const dir = resolve(BLOCKS_DIR, slug);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`bloco inexistente: ${slug}`);

  const target = resolve(dir, file);
  if (isAbsolute(file) || file.split(/[\\/]/).includes("..") || (target !== dir && !target.startsWith(dir + sep))) {
    throw new Error(`arquivo fora do bloco "${slug}": ${JSON.stringify(file)}`);
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new Error(`arquivo inexistente no bloco "${slug}": ${JSON.stringify(file)}`);
  }
  return readFileSync(target, "utf8");
}

/** Bloco que o catálogo não tem (`E_BLOCK_UNKNOWN`): quem chama decide como responder, sem plano B. */
export class UnknownBlockError extends Error {
  readonly code = "E_BLOCK_UNKNOWN";
  readonly hint = "rode `frankframes blocks list` para ver os slugs do catálogo";

  constructor(slug: string) {
    super(`bloco desconhecido: ${JSON.stringify(slug)}`);
    this.name = "UnknownBlockError";
  }
}

/**
 * Copia o diretório do bloco (`index.html`, `meta.json`, miniatura) para `target`. É a mesma rotina do
 * `frankframes blocks add <slug>` e do Studio (painel Blocos, EDT-88). Falha alto com `UnknownBlockError`.
 */
export async function installBlock(slug: string, target: string): Promise<BlockMeta> {
  const block = listBlocks().find((candidate) => candidate.slug === slug);
  if (block === undefined) throw new UnknownBlockError(slug);
  await cp(block.dir, target, { recursive: true });
  return block;
}

/** Diretório das miniaturas dos presets de motion (`<nome>.gif`, docs/motion.md). */
export const MOTION_THUMBS_DIR = fileURLToPath(new URL("../../../catalog/motion/thumbs/", import.meta.url));

/** Caminho absoluto da miniatura de um preset. Lança para nome inválido ou miniatura ausente. */
export function motionThumbPath(name: string): string {
  if (!SLUG.test(name)) throw new Error(`nome de preset inválido: ${JSON.stringify(name)}`);
  const file = join(MOTION_THUMBS_DIR, `${name}.gif`);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`miniatura inexistente para o preset "${name}": rode node scripts/generate-motion-thumbs.ts`);
  }
  return file;
}

export { installBlockFromUrl, readBlockHtml } from "./remote.ts";
export type { InstalledBlock } from "./remote.ts";
