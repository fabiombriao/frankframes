// FrankFrames — proprietário. Ver LICENSE na raiz.
// Uso:
//   node scripts/generate-goldens.ts                      regenera todos os blocos
//   node scripts/generate-goldens.ts --only a,b           regenera só esses (os demais ficam como estão)
//   node scripts/generate-goldens.ts --compare a,b        captura e compara com os PNGs guardados; não grava nada
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureGolden, engineSignature, psnr } from "../packages/producer/src/goldens.ts";
import { defaultConcurrency, mapPool } from "./pool.ts";
import type { GoldenBlock, GoldenManifest } from "../packages/producer/src/goldens.ts";

const catalog = fileURLToPath(new URL("../catalog/blocks/", import.meta.url));
const target = fileURLToPath(new URL("../catalog/goldens.json", import.meta.url));
const gpu = process.argv.includes("--gpu-hardware") ? "hardware" : "software";
/** Abaixo disto a mudança é visual, não jitter de rasterização (EDT-56). */
const COMPARE_THRESHOLD_DB = 45;

/** Lê `--flag a,b` ou `--flag=a,b`; `undefined` quando a flag não existe. */
function listFlag(name: string): string[] | undefined {
  const args = process.argv.slice(2);
  const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return undefined;
  const raw = args[index]!.includes("=") ? args[index]!.slice(name.length + 1) : args[index + 1];
  const list = (raw ?? "").split(",").map((slug) => slug.trim()).filter((slug) => slug !== "");
  if (list.length === 0) throw new Error(`${name} exige ao menos um bloco: ${name} slug,slug`);
  return list;
}

const all = (await readdir(catalog)).sort();
const only = listFlag("--only");
const compare = listFlag("--compare");
if (only !== undefined && compare !== undefined) throw new Error("--only e --compare não combinam: --compare não grava nada");
for (const slug of [...(only ?? []), ...(compare ?? [])]) {
  if (!all.includes(slug)) throw new Error(`bloco inexistente: ${slug}`);
}

if (compare !== undefined) {
  const results = await mapPool(compare, defaultConcurrency(), async (slug) => {
    const golden = await captureGolden(join(catalog, slug, "index.html"), { gpu, includePng: true });
    const scores: Array<{ frame: number; db: number }> = [];
    for (const frame of golden.frames) {
      const stored = await readFile(join(catalog, "..", "goldens", slug, `${frame.frame}.png`));
      if (frame.png === undefined) throw new Error(`${slug} frame ${frame.frame}: captura sem PNG`);
      scores.push({ frame: frame.frame, db: await psnr(frame.png, stored) });
    }
    const min = Math.min(...scores.map((score) => score.db));
    const cells = scores.map((score) => `${score.frame}:${Number.isFinite(score.db) ? score.db.toFixed(1) : "inf"}`);
    process.stdout.write(`${slug.padEnd(22)} min ${Number.isFinite(min) ? min.toFixed(1) : "inf"} dB  ${cells.join(" ")}\n`);
    return { slug, min };
  });
  const below = results.filter((result) => result.min < COMPARE_THRESHOLD_DB);
  for (const result of below) process.stdout.write(`ABAIXO de ${COMPARE_THRESHOLD_DB} dB: ${result.slug} (${result.min.toFixed(1)} dB)\n`);
  process.exitCode = below.length === 0 ? 0 : 1;
} else {
  const slugs = only ?? all;
  const blocks = await mapPool(slugs, defaultConcurrency(), async (slug) => {
    const golden = await captureGolden(join(catalog, slug, "index.html"), { gpu, includePng: true });
    const dir = join(catalog, "..", "goldens", slug);
    await mkdir(dir, { recursive: true });
    for (const frame of golden.frames) {
      if (frame.png !== undefined) await writeFile(join(dir, `${frame.frame}.png`), frame.png);
    }
    const frames = golden.frames.map(({ frame, sha256 }) => ({ frame, sha256 }));
    process.stdout.write(`${slug.padEnd(22)} ${frames.map((f) => f.sha256.slice(0, 8)).join(" ")}\n`);
    return { name: slug, durationSeconds: golden.durationSeconds, frames } satisfies GoldenBlock;
  });

  let merged: GoldenBlock[] = blocks;
  if (only !== undefined) {
    // Parcial: mantém as entradas dos outros blocos e troca só as regeneradas, na ordem do manifesto.
    const current = JSON.parse(await readFile(target, "utf8")) as GoldenManifest;
    const fresh = new Map(blocks.map((block) => [block.name, block]));
    merged = current.blocks.map((block) => fresh.get(block.name) ?? block);
    for (const block of blocks) if (!current.blocks.some((entry) => entry.name === block.name)) merged.push(block);
    merged.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // mesma ordem do `.sort()` de readdir
  }
  const manifest: GoldenManifest = { engine: await engineSignature(gpu), blocks: merged };
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
}
