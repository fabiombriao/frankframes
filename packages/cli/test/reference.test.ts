// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderReference } from "../../../scripts/generate-reference.ts";

test("referência de diagnósticos está sincronizada com o código", async () => {
  const committed = await readFile(fileURLToPath(new URL("../../../docs/reference/diagnostics.md", import.meta.url)), "utf8");
  assert.equal(committed, renderReference(), "rode `node scripts/generate-reference.ts`");
});
