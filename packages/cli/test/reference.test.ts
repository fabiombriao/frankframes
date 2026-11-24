// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderReference } from "../../../scripts/generate-reference.ts";

test("referência de diagnósticos está sincronizada com o código", async () => {
  const committed = await readFile(fileURLToPath(new URL("../../../docs/reference/diagnostics.md", import.meta.url)), "utf8");
  assert.equal(committed, renderReference(), "rode `node scripts/generate-reference.ts`");
});

// Literais "E_XXX" (entre aspas ou crase) no src de cada pacote, com os arquivos onde aparecem.
async function emittedCodes(): Promise<Map<string, string[]>> {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  const found = new Map<string, string[]>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") await walk(path);
      } else if (/\.(ts|js)$/.test(entry.name)) {
        for (const match of (await readFile(path, "utf8")).matchAll(/["'`](E_[A-Z][A-Z0-9_]*)/g)) {
          const code = match[1]!;
          found.set(code, [...(found.get(code) ?? []), relative(packages, path)]);
        }
      }
    }
  };
  for (const pkg of await readdir(packages, { withFileTypes: true })) {
    if (pkg.isDirectory()) await walk(join(packages, pkg.name, "src")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error; // pacote sem src/ não emite nada
    });
  }
  return found;
}

test("todo código E_* emitido no src dos pacotes está no catálogo gerado (EDT-80)", async () => {
  const catalog = new Set(renderReference().match(/E_[A-Z][A-Z0-9_]*/g));
  const emitted = await emittedCodes();
  assert.ok(emitted.size > 80, `a varredura achou só ${emitted.size} códigos: o padrão quebrou?`);
  const missing = [...emitted].filter(([code]) => !catalog.has(code)).map(([code, files]) => `${code} (${[...new Set(files)].join(", ")})`);
  assert.deepEqual(missing, [], "registre cada código no módulo de códigos do pacote e rode `node scripts/generate-reference.ts`");
});
