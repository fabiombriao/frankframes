// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("skill publicada é idêntica à do monorepo", async () => {
  const source = await readFile(fileURLToPath(new URL("../../../skills/frankframes/SKILL.md", import.meta.url)), "utf8");
  const packaged = await readFile(fileURLToPath(new URL("../skill/SKILL.md", import.meta.url)), "utf8");
  assert.equal(packaged, source, "rode `node scripts/sync-skill.ts`");
});
