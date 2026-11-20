// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Congela o pixel dos blocos do catálogo em `catalog/goldens.json`. */
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureGolden, engineSignature } from "../packages/producer/src/goldens.ts";
import type { GoldenManifest } from "../packages/producer/src/goldens.ts";

const catalog = fileURLToPath(new URL("../catalog/blocks/", import.meta.url));
const target = fileURLToPath(new URL("../catalog/goldens.json", import.meta.url));
const gpu = process.argv.includes("--gpu-hardware") ? "hardware" : "software";

const blocks = [];
for (const slug of (await readdir(catalog)).sort()) {
  const entry = join(catalog, slug, "index.html");
  const golden = await captureGolden(entry, { gpu });
  blocks.push({ ...golden, name: slug });
  process.stdout.write(`${slug.padEnd(16)} ${golden.frames.map((frame) => `${frame.frame}:${frame.sha256.slice(0, 8)}`).join(" ")}\n`);
}

const manifest: GoldenManifest = { engine: await engineSignature(gpu), blocks };
await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`\n${blocks.length} bloco(s) em catalog/goldens.json · ${manifest.engine.browser} · ${gpu}\n`);
