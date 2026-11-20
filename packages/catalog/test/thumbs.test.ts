// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const catalog = fileURLToPath(new URL("../../../catalog/blocks/", import.meta.url));

test("todo bloco tem thumbnail PNG real", async () => {
  const slugs = (await readdir(catalog)).filter((slug) => !slug.includes("."));
  assert.ok(slugs.length >= 8, `esperado ao menos 8 blocos, obtido ${slugs.length}`);

  for (const slug of slugs) {
    const png = await readFile(join(catalog, slug, "thumb.png")).catch(() => null);
    assert.ok(png, `${slug}: thumb.png ausente (rode \`node scripts/generate-thumbs.ts\`)`);
    assert.equal(png!.subarray(0, 4).toString("latin1"), "\x89PNG", `${slug}: thumb.png não é PNG`);
    assert.ok(png!.byteLength > 10_000, `${slug}: thumbnail com ${png!.byteLength} bytes parece vazia`);
  }
});
