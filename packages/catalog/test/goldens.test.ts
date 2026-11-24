// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureGolden, engineSignature, loadGoldenSet, psnr } from "@frankframes/producer";
import { resolveChrome } from "@frankframes/engine";
import { defaultConcurrency, mapPool } from "../../../scripts/pool.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("blocos do catálogo não mudam de pixel", { timeout: 900_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  // Conjunto da plataforma atual; sem conjunto, `E_GOLDENS_PLATFORM_MISSING` reprova o teste (nada de skip).
  const { manifest, pngPath, platform } = await loadGoldenSet(join(root, "catalog"));
  const engine = await engineSignature("software");
  assert.equal(
    engine.browser,
    manifest.engine.browser,
    `goldens ${platform} gerados com${manifest.engine.browser}, rodando com ${engine.browser}: rode \`node scripts/generate-goldens.ts\``,
  );

  const perBlock = await mapPool(manifest.blocks, defaultConcurrency(), async (expected) => {
    const found: string[] = [];
    const actual = await captureGolden(join(root, "catalog", "blocks", expected.name, "index.html"), {
      gpu: "software",
      includePng: true,
    });
    for (const golden of expected.frames) {
      const got = actual.frames.find((frame) => frame.frame === golden.frame);
      if (got?.sha256 === golden.sha256) continue;

      const stored = await readFile(pngPath(expected.name, golden.frame)).catch(() => null);
      if (got?.png !== undefined && stored !== null) {
        const quality = await psnr(got.png, stored);
        if (quality >= 50) continue; // jitter de rasterização, não mudança visual
        found.push(
          `${expected.name} frame ${golden.frame}: PSNR ${quality.toFixed(1)} dB (esperado ≥50); rode \`node scripts/generate-goldens.ts\``,
        );
      } else {
        found.push(`${expected.name} frame ${golden.frame}: hash ${golden.sha256.slice(0, 12)} e sem PNG de referência`);
      }
    }
    return found;
  });
  const problems = perBlock.flat();

  assert.deepEqual(problems.slice(0, 8), [], `${problems.length} frame(s) divergentes; rode \`node scripts/generate-goldens.ts\``);
});
