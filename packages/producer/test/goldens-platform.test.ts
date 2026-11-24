// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GoldenSetMissingError, goldenDir, loadGoldenSet } from "../src/goldens.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

/** Catálogo falso com um conjunto por plataforma; o `browser` de cada manifesto diz de qual veio. */
async function fakeCatalog(t: Parameters<typeof tempDir>[0], platforms: Array<"win64" | "linux64">): Promise<string> {
  const catalog = await tempDir(t, "ff-goldens-plat-");
  for (const platform of platforms) {
    const dir = goldenDir(catalog, platform);
    await mkdir(join(dir, "bloco"), { recursive: true });
    const manifest = { engine: { browser: `de-${platform}`, gpu: "software", viewport: "nativo" }, blocks: [] };
    await writeFile(join(dir, "goldens.json"), JSON.stringify(manifest));
  }
  return catalog;
}

test("goldens: cada plataforma lê o conjunto dela, nunca o de outra", async (t) => {
  const catalog = await fakeCatalog(t, ["win64", "linux64"]);
  const win = await loadGoldenSet(catalog, "win32", "x64");
  assert.equal(win.platform, "win64");
  assert.equal(win.manifest.engine.browser, "de-win64");
  assert.equal(win.pngPath("hero", 12), join(catalog, "goldens", "win64", "hero", "12.png"));

  const linux = await loadGoldenSet(catalog, "linux", "x64");
  assert.equal(linux.platform, "linux64");
  assert.equal(linux.manifest.engine.browser, "de-linux64");
  assert.equal(linux.pngPath("hero", 12), join(catalog, "goldens", "linux64", "hero", "12.png"));
});

test("goldens: plataforma sem conjunto gerado falha alto com código e hint, sem cair no de outra", async (t) => {
  const catalog = await fakeCatalog(t, ["win64"]);
  await assert.rejects(loadGoldenSet(catalog, "linux", "x64"), (error: unknown) => {
    assert.ok(error instanceof GoldenSetMissingError);
    assert.equal(error.code, "E_GOLDENS_PLATFORM_MISSING");
    assert.match(error.message, /E_GOLDENS_PLATFORM_MISSING.*linux64/);
    assert.match(error.hint, /generate-goldens/);
    assert.match(error.hint, /existentes: win64/);
    return true;
  });
});

test("goldens: plataforma sem browser pinado (macOS, ARM) falha alto, mesmo com conjuntos existentes", async (t) => {
  const catalog = await fakeCatalog(t, ["win64", "linux64"]);
  for (const [platform, arch] of [["darwin", "arm64"], ["linux", "arm64"], ["win32", "arm64"]] as const) {
    await assert.rejects(loadGoldenSet(catalog, platform, arch), (error: unknown) => {
      assert.ok(error instanceof GoldenSetMissingError);
      assert.equal(error.code, "E_GOLDENS_PLATFORM_MISSING");
      assert.match(error.message, new RegExp(`${platform}/${arch}`));
      assert.match(error.hint, /linux64, win64/);
      return true;
    });
  }
});

test("goldens: catálogo sem a pasta de goldens também é o erro com código (não ENOENT cru)", async (t) => {
  const catalog = await tempDir(t, "ff-goldens-plat-");
  await assert.rejects(loadGoldenSet(catalog, "win32", "x64"), (error: unknown) => error instanceof GoldenSetMissingError && /nenhum/.test(error.hint));
});

test("goldens: manifesto ilegível não vira 'sem conjunto' (o erro real sobe)", async (t) => {
  const catalog = await fakeCatalog(t, ["win64"]);
  await writeFile(join(goldenDir(catalog, "win64"), "goldens.json"), "{ quebrado");
  await assert.rejects(loadGoldenSet(catalog, "win32", "x64"), SyntaxError);
});
