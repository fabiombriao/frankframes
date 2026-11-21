// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Congela o pixel dos blocos do catálogo em `catalog/goldens.json`. */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureGolden, engineSignature } from "../packages/producer/src/goldens.ts";
import { defaultConcurrency, mapPool } from "./pool.ts";
import type { GoldenManifest } from "../packages/producer/src/goldens.ts";

const catalog = fileURLToPath(new URL("../catalog/blocks/", import.meta.url));
const target = fileURLToPath(new URL("../catalog/goldens.json", import.meta.url));
const gpu = process.argv.includes("--gpu-hardware") ? "hardware" : "software";

const slugs = (await readdir(catalog)).sort();
const blocks = await mapPool(slugs, defaultConcurrency(), async (slug) => {
  const golden = await captureGolden(join(catalog, slug, "index.html"), { gpu, includePng: true });
  const dir = join(catalog, "..", "goldens", slug);
  await mkdir(dir, { recursive: true });
  for (const frame of golden.frames) {
    if (frame.png !== undefined) await writeFile(join(dir, `${frame.frame}.png`), frame.png);
  }
  // O manifesto guarda só hash: PNG tem centenas de KB e não vai para o JSON.
  const frames = golden.frames.map(({ frame, sha256 }) => ({ frame, sha256 }));
  process.stdout.write(`${slug.padEnd(22)} ${frames.map((frame) => frame.sha256.slice(0, 8)).join(" ")}\n`);
  return { name: slug, durationSeconds: golden.durationSeconds, frames };
});

const manifest: GoldenManifest = { engine: await engineSignature(gpu), blocks };
await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`\n${blocks.length} bloco(s) em catalog/goldens.json · ${manifest.engine.browser} · ${gpu}\n`);
