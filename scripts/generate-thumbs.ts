// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Gera `thumb.png` (frame do meio) para cada bloco do catálogo. */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureFrameAt } from "../packages/producer/src/goldens.ts";

const catalog = fileURLToPath(new URL("../catalog/blocks/", import.meta.url));

for (const slug of (await readdir(catalog)).sort()) {
  await mkdir(join(catalog, slug), { recursive: true });
  const { png, frame, totalFrames } = await captureFrameAt(join(catalog, slug, "index.html"), 0.5);
  await writeFile(join(catalog, slug, "thumb.png"), png);
  process.stdout.write(`${slug.padEnd(22)} frame ${frame}/${totalFrames - 1} · ${(png.byteLength / 1024).toFixed(0)} KB\n`);
}
