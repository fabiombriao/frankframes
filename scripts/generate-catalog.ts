// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Gera `catalog/README.md` a partir dos blocos instalados. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listBlocks } from "@frankframes/catalog";

const catalog = fileURLToPath(new URL("../catalog/blocks/", import.meta.url));
const target = fileURLToPath(new URL("../catalog/README.md", import.meta.url));

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
  writeFileSync(target, renderCatalogPage());
  process.stdout.write(`catalog/README.md · ${listBlocks().length} blocos\n`);
}
