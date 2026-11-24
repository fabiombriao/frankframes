// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { statIfPresent } from "../src/fs-util.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

test("statIfPresent: arquivo existente devolve Stats", async (t) => {
  const dir = await tempDir(t, "ff-fsutil-");
  const file = join(dir, "a.txt");
  await writeFile(file, "abc");
  const info = await statIfPresent(file);
  assert.ok(info !== undefined && info.isFile());
  assert.equal(info.size, 3);
});

test("statIfPresent: caminho inexistente devolve undefined", async (t) => {
  const dir = await tempDir(t, "ff-fsutil-");
  assert.equal(await statIfPresent(join(dir, "nao-existe")), undefined);
});

test("statIfPresent: caminho 'dentro' de um arquivo (ENOTDIR) devolve undefined", async (t) => {
  const dir = await tempDir(t, "ff-fsutil-");
  const file = join(dir, "a.txt");
  await writeFile(file, "abc");
  assert.equal(await statIfPresent(join(file, "filho")), undefined);
});

test("statIfPresent: erro que não é ENOENT/ENOTDIR sobe (caminho com caractere nulo)", async () => {
  await assert.rejects(statIfPresent("a\0b"), (error: unknown) => (error as NodeJS.ErrnoException).code === "ERR_INVALID_ARG_VALUE");
});
