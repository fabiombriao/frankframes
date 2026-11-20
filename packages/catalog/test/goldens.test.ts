// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureGolden, engineSignature } from "@frankframes/producer";
import type { GoldenManifest } from "@frankframes/producer";
import { resolveChrome } from "@frankframes/engine";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("blocos do catálogo não mudam de pixel", { timeout: 900_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  const manifest = JSON.parse(await readFile(join(root, "catalog", "goldens.json"), "utf8")) as GoldenManifest;
  const engine = await engineSignature("software");
  assert.equal(
    engine.browser,
    manifest.engine.browser,
    `goldens gerados com ${manifest.engine.browser}, rodando com ${engine.browser}: rode \`node scripts/generate-goldens.ts\``,
  );

  const problems: string[] = [];
  for (const expected of manifest.blocks) {
    const actual = await captureGolden(join(root, "catalog", "blocks", expected.name, "index.html"), { gpu: "software" });
    for (const golden of expected.frames) {
      const got = actual.frames.find((frame) => frame.frame === golden.frame)?.sha256;
      if (got !== golden.sha256) {
        problems.push(`${expected.name} frame ${golden.frame}: esperado ${golden.sha256.slice(0, 12)}, obtido ${(got ?? "ausente").slice(0, 12)}`);
      }
    }
  }

  assert.deepEqual(problems.slice(0, 8), [], `${problems.length} frame(s) divergentes; rode \`node scripts/generate-goldens.ts\``);
});
