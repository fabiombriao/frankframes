// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Mantém o catálogo coerente: recalcula o `sha256` do `index.html` de cada bloco no `meta.json` e
 * gera `catalog/README.md` a partir dos blocos instalados.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listBlocks } from "@frankframes/catalog";

const catalog = fileURLToPath(new URL("../catalog/blocks/", import.meta.url));
const target = fileURLToPath(new URL("../catalog/README.md", import.meta.url));

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SHA_FIELD = /("sha256"\s*:\s*")[^"]*(")/;

export interface HashSyncResult {
  /** Blocos examinados. */
  checked: number;
  /** Slugs cujo `meta.json` foi reescrito porque o hash estava desatualizado. */
  updated: string[];
}

/**
 * Recalcula o sha256 de cada `<root>/<slug>/index.html` e grava em `meta.json`.
 * O leitor (`catalog-server`) continua exigindo o hash exato; isto só tira a edição manual.
 * Escrita mínima: troca só o valor de `sha256` (ordem das chaves e formatação intactas) e nem abre
 * o arquivo para escrita quando o hash já confere, para não sujar o diff.
 */
export function syncBlockHashes(root: string = catalog): HashSyncResult {
  const slugs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SLUG.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const updated: string[] = [];
  for (const slug of slugs) {
    const htmlPath = join(root, slug, "index.html");
    const metaPath = join(root, slug, "meta.json");
    let html: Buffer;
    try {
      html = readFileSync(htmlPath);
    } catch (error) {
      throw new Error(`E_CATALOG_HTML: ${slug}: index.html ilegível em ${htmlPath} (${(error as Error).message})`, {
        cause: error,
      });
    }
    const hash = createHash("sha256").update(html).digest("hex");

    const raw = readFileSync(metaPath, "utf8");
    let meta: unknown;
    try {
      meta = JSON.parse(raw);
    } catch (error) {
      throw new Error(`E_CATALOG_META: ${slug}: meta.json inválido em ${metaPath} (${(error as Error).message})`, {
        cause: error,
      });
    }
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
      throw new Error(`E_CATALOG_META: ${slug}: meta.json precisa ser um objeto JSON (${metaPath})`);
    }

    const current = (meta as Record<string, unknown>).sha256;
    if (typeof current === "string" && current.toLowerCase() === hash) continue;

    // Troca só o valor quando o campo já existe; sem o campo, acrescenta no fim (formato do remote.ts).
    const next = SHA_FIELD.test(raw)
      ? raw.replace(SHA_FIELD, `$1${hash}$2`)
      : `${JSON.stringify({ ...(meta as object), sha256: hash }, null, 2)}\n`;
    writeFileSync(metaPath, next);
    updated.push(slug);
  }
  return { checked: slugs.length, updated };
}

function dimensions(slug: string): { width: number; height: number } {
  const html = readFileSync(join(catalog, slug, "index.html"), "utf8");
  const width = Number(/data-width="(\d+)"/.exec(html)?.[1] ?? 1920);
  const height = Number(/data-height="(\d+)"/.exec(html)?.[1] ?? 1080);
  return { width, height };
}

export function renderCatalogPage(): string {
  const blocks = listBlocks();
  const rows = blocks.map((block) => {
    const { width, height } = dimensions(block.slug);
    const format = height > width ? "9:16" : "16:9";
    const thumb = `![${block.slug}](blocks/${block.slug}/thumb.png)`;
    return `| [\`${block.slug}\`](blocks/${block.slug}/index.html) | ${format} | ${block.durationSeconds}s | ${block.name} — ${block.summary} | ${thumb} |`;
  });

  return `# Catálogo

${blocks.length} blocos prontos. Gerado por \`node scripts/generate-catalog.ts\` a partir de
\`meta.json\`, \`index.html\` e \`thumb.png\` de cada bloco. Não edite à mão.

\`\`\`bash
frankframes blocks list
frankframes blocks add <slug> <destino>
frankframes blocks add https://exemplo/bloco <destino>   # exige sha256 no meta.json
\`\`\`

| Bloco | Formato | Duração | Descrição | Thumb |
|---|---|---:|---|---|
${rows.join("\n")}
`;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("generate-catalog.ts")) {
  // Hashes primeiro: o README e o índice publicado leem o meta.json já corrigido.
  const { checked, updated } = syncBlockHashes();
  process.stdout.write(
    updated.length === 0
      ? `sha256 · ${checked} blocos conferem\n`
      : `sha256 · ${updated.length} de ${checked} blocos atualizados: ${updated.join(", ")}\n`,
  );
  writeFileSync(target, renderCatalogPage());
  process.stdout.write(`catalog/README.md · ${listBlocks().length} blocos\n`);
}
