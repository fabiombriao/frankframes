// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-74: `generate-catalog` recalcula o sha256 do index.html no meta.json, sem passo manual.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBlockHashes } from "../../../scripts/generate-catalog.ts";
import { buildCatalogIndex } from "../src/catalog-server.ts";
import { withTempDir } from "../../../scripts/test-support/temp.ts";

const REAL_BLOCKS = fileURLToPath(new URL("../../../catalog/blocks/", import.meta.url));
const SLUGS = ["callout-box", "chart-bars"] as const;

/** Copia dois blocos reais para um diretório temporário: o `catalog/` do repositório nunca é tocado. */
function withCopy<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withTempDir("ff-catalog-sync-", async (root) => {
    for (const slug of SLUGS) await cp(join(REAL_BLOCKS, slug), join(root, slug), { recursive: true });
    return fn(root);
  });
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

test("alterar um index.html e rodar o script deixa o índice válido, sem edição manual", async () => {
  await withCopy(async (root) => {
    assert.equal((await buildCatalogIndex(root)).length, 2, "ponto de partida: cópia coerente");

    const htmlPath = join(root, "callout-box", "index.html");
    const edited = `${await readFile(htmlPath, "utf8")}\n<!-- edição de teste -->\n`;
    await writeFile(htmlPath, edited);
    await assert.rejects(buildCatalogIndex(root), /callout-box.*sha256.*divergente/, "o leitor segue estrito");

    const result = syncBlockHashes(root);
    assert.deepEqual(result, { checked: 2, updated: ["callout-box"] });

    const index = await buildCatalogIndex(root);
    assert.equal(index.find((entry) => entry.slug === "callout-box")?.sha256, sha(edited));
  });
});

test("escrita mínima: só o valor do sha256 muda; ordem, formatação e \\n final ficam", async () => {
  await withCopy(async (root) => {
    const metaPath = join(root, "callout-box", "meta.json");
    const before = await readFile(metaPath, "utf8");
    const htmlPath = join(root, "callout-box", "index.html");
    const edited = `${await readFile(htmlPath, "utf8")}<!-- x -->`;
    await writeFile(htmlPath, edited);

    syncBlockHashes(root);

    const after = await readFile(metaPath, "utf8");
    assert.equal(after, before.replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${sha(edited)}"`));
    assert.deepEqual(Object.keys(JSON.parse(after)), Object.keys(JSON.parse(before)), "ordem das chaves");
    assert.ok(after.endsWith("}\n"));
  });
});

test("hash que já confere não reescreve o meta.json (sem diff sujo)", async () => {
  await withCopy(async (root) => {
    const metaPath = join(root, "chart-bars", "meta.json");
    const bytes = await readFile(metaPath);
    const mtimeBefore = (await stat(metaPath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(syncBlockHashes(root), { checked: 2, updated: [] });
    assert.deepEqual(await readFile(metaPath), bytes);
    assert.equal((await stat(metaPath)).mtimeMs, mtimeBefore, "arquivo nem foi aberto para escrita");

    // Só o bloco alterado é reescrito; o vizinho intacto continua intocado.
    await writeFile(join(root, "callout-box", "index.html"), "<html><body>novo</body></html>");
    const neighborBefore = (await stat(metaPath)).mtimeMs;
    assert.deepEqual(syncBlockHashes(root).updated, ["callout-box"]);
    assert.equal((await stat(metaPath)).mtimeMs, neighborBefore);
  });
});

test("falha alto: index.html ausente e meta.json inválido", async () => {
  await withCopy(async (root) => {
    await rm(join(root, "chart-bars", "index.html"));
    assert.throws(() => syncBlockHashes(root), /E_CATALOG_HTML.*chart-bars/);
  });
  await withCopy(async (root) => {
    await writeFile(join(root, "chart-bars", "meta.json"), "{ não é json");
    assert.throws(() => syncBlockHashes(root), /E_CATALOG_META.*chart-bars/);
  });
  await withCopy(async (root) => {
    await mkdir(join(root, "vazio"));
    assert.throws(() => syncBlockHashes(root), /E_CATALOG_HTML.*vazio/, "bloco sem arquivos não passa em silêncio");
  });
});
