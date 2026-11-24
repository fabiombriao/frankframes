// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupWarning, removeTree } from "../src/cleanup.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

test("removeTree: sucesso devolve undefined e apaga a árvore", async (t) => {
  const root = await tempDir(t, "ff-cleanup-");
  const alvo = join(root, "alvo");
  await mkdir(join(alvo, "fundo"), { recursive: true });
  await writeFile(join(alvo, "fundo", "a.txt"), "x");
  assert.equal(await removeTree(alvo), undefined);
  assert.deepEqual(await readdir(root), []);
});

test("removeTree: caminho inexistente sem missingOk devolve o erro (não engole)", async (t) => {
  const root = await tempDir(t, "ff-cleanup-");
  const falha = await removeTree(join(root, "nao-existe"));
  assert.ok(falha instanceof Error);
  assert.equal((falha as NodeJS.ErrnoException).code, "ENOENT");
});

test("removeTree: com missingOk o caminho inexistente é aceito", async (t) => {
  const root = await tempDir(t, "ff-cleanup-");
  assert.equal(await removeTree(join(root, "nao-existe"), { missingOk: true }), undefined);
});

test("cleanupWarning traz o caminho e o motivo", () => {
  const texto = cleanupWarning("C:/tmp/ff-x", new Error("EBUSY: ocupado"));
  assert.ok(texto.includes("C:/tmp/ff-x"));
  assert.ok(texto.includes("EBUSY: ocupado"));
  assert.match(cleanupWarning("/p", "texto solto"), /não consegui remover \/p: texto solto/);
});
