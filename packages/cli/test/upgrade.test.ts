// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, decideUpgrade } from "../src/upgrade.ts";

test("comparação de versões cobre patch, minor e major", () => {
  assert.ok(compareVersions("0.1.0", "0.1.1") < 0);
  assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("1.0.0", "1.0.0") === 0);
  assert.ok(compareVersions("0.9.9", "1.0.0") < 0);
});

test("decisão de upgrade cobre os quatro casos", () => {
  assert.equal(decideUpgrade("0.1.0", null), "não publicado");
  assert.equal(decideUpgrade("0.1.0", "0.1.0"), "atualizado");
  assert.equal(decideUpgrade("0.1.0", "0.2.0"), "atualizar");
  assert.equal(decideUpgrade("0.3.0", "0.2.0"), "versão local mais nova");
});
