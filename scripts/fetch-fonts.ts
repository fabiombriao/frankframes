// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Baixa o catálogo de fontes (SIL OFL 1.1) para `vendor/fonts`.
 * Uso: node scripts/fetch-fonts.ts [--force]
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FONT_CATALOG, fontFileName } from "@frankframes/engine";

const VERSION = "5.2.5";
const TARGET = fileURLToPath(new URL("../vendor/fonts/", import.meta.url));
const force = process.argv.includes("--force");

await mkdir(TARGET, { recursive: true });
const existing = new Set(await readdir(TARGET));

let downloaded = 0;
let skipped = 0;
let bytes = 0;

for (const family of FONT_CATALOG) {
  for (const weight of family.weights) {
    const file = fontFileName(family, weight);
    if (existing.has(file) && !force) {
      skipped++;
      continue;
    }
    const url = `https://cdn.jsdelivr.net/npm/@fontsource/${family.pkg}@${VERSION}/files/${file}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.subarray(0, 4).toString("latin1") !== "wOF2") throw new Error(`${file} não é woff2`);
    await writeFile(join(TARGET, file), buffer);
    downloaded++;
    bytes += buffer.byteLength;
  }
  const licenseFile = `OFL-${family.slug}.txt`;
  if (!existing.has(licenseFile)) {
    const response = await fetch(`https://cdn.jsdelivr.net/npm/@fontsource/${family.pkg}@${VERSION}/LICENSE`);
    if (response.ok) await writeFile(join(TARGET, licenseFile), await response.text());
  }
}

process.stdout.write(`fontes: ${downloaded} baixadas, ${skipped} já existiam, ${(bytes / 1024).toFixed(0)} KB novas\n`);
