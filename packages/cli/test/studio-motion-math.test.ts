// FrankFrames — proprietário. Ver LICENSE na raiz.
// Funções puras de motion.js (cliente do Studio): formatar o atributo e trocar de preset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describePresets } from "@frankframes/contract";
import { formatMotionAttr, swapPreset } from "../src/studio/motion.js";

const enterPresets = describePresets("enter");

test("formatMotionAttr omite o que é igual ao default do preset", () => {
  assert.equal(formatMotionAttr("subir", { dur: "0.6" }, enterPresets), "subir");
  assert.equal(formatMotionAttr("subir", {}, enterPresets), "subir");
  assert.equal(formatMotionAttr("subir", { dur: "0.60" }, enterPresets), "subir", "comparação numérica");
});

test("formatMotionAttr escreve só os parâmetros que diferem, em ordem estável", () => {
  assert.equal(
    formatMotionAttr("subir", { distance: "40px", dur: "0.8" }, enterPresets),
    "subir dur=0.8 distance=40px",
  );
});

test("swapPreset mantém dur/at/curve aceitos e descarta o resto", () => {
  assert.equal(swapPreset("subir dur=0.8 distance=40px", "crescer", enterPresets), "crescer dur=0.8");
  assert.equal(swapPreset("subir dur=0.8", null, enterPresets), null);
  assert.equal(swapPreset(null, "subir", enterPresets), "subir");
});
