// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FONT_CATALOG, expectedFontFiles, fontFaceCss } from "../src/index.ts";

test("todo arquivo do catálogo existe em vendor/fonts", async () => {
  const present = new Set(await readdir(fileURLToPath(new URL("../../../vendor/fonts/", import.meta.url))));
  const missing = expectedFontFiles().filter((file) => !present.has(file));
  assert.deepEqual(missing, [], "rode `node scripts/fetch-fonts.ts`");
  assert.ok(FONT_CATALOG.length >= 20, `catálogo com ${FONT_CATALOG.length} famílias é pequeno demais`);
});

test("CSS cobre todas as famílias e fixa a fonte padrão", () => {
  const css = fontFaceCss();
  for (const family of FONT_CATALOG) {
    assert.ok(css.includes(`font-family:"${family.name}"`), `${family.name} ausente do CSS`);
  }
  assert.ok(css.includes('html{font-family:"Inter"'), "fonte padrão precisa ser fixada");
  assert.ok(!/http(s)?:\/\//.test(css), "fonte de CDN externa quebra o determinismo");
});
