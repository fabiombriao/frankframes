// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureGolden, engineSignature } from "@frankframes/producer";
import { assetPath } from "@frankframes/engine";
import type { GoldenManifest } from "@frankframes/producer";
import { resolveChrome } from "@frankframes/engine";
import { defaultConcurrency, mapPool } from "../../../scripts/pool.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const run = promisify(execFile);
const ffmpeg = assetPath("ffmpeg", "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

/** Jitter de rasterização (1–2 pixels) não é mudança visual: exige-se ≥50 dB. */
async function psnr(a: Buffer, b: Buffer): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "ff-golden-"));
  const left = join(dir, "a.png");
  const right = join(dir, "b.png");
  await writeFile(left, a);
  await writeFile(right, b);
  const result = await run(ffmpeg, ["-hide_banner", "-i", left, "-i", right, "-lavfi", "[0][1]psnr", "-f", "null", "-"], {
    encoding: "utf8",
  }).catch((error: { stderr?: string }) => ({ stderr: error.stderr ?? "" }));
  const match = /average:([\d.]+|inf)/.exec((result as { stderr: string }).stderr);
  if (match?.[1] === "inf") return Infinity;
  return Number(match?.[1] ?? 0);
}

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

  const perBlock = await mapPool(manifest.blocks, defaultConcurrency(), async (expected) => {
    const found: string[] = [];
    const actual = await captureGolden(join(root, "catalog", "blocks", expected.name, "index.html"), {
      gpu: "software",
      includePng: true,
    });
    for (const golden of expected.frames) {
      const got = actual.frames.find((frame) => frame.frame === golden.frame);
      if (got?.sha256 === golden.sha256) continue;

      const stored = await readFile(join(root, "catalog", "goldens", expected.name, `${golden.frame}.png`)).catch(() => null);
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
