// FrankFrames — proprietário. Ver LICENSE na raiz.
// Funções puras de motion.js (cliente do Studio): formatar o atributo e trocar de preset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describePresets } from "@frankframes/contract";
import { formatMotionAttr, swapPreset, transitionParams, transitionPartner } from "../src/studio/motion.js";
import { percentSpan } from "../src/studio/timeline-math.js";

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

/* ------------------------- Transição (EDT-54) ------------------------- */

const transitionPresets = describePresets("transition");
const barOf = (id: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({
  id,
  tag: "div",
  start,
  end,
  parentId: null,
  motion: {},
  ...extra,
});

test("transitionPartner acha o irmão que termina onde B começa, ou o parceiro declarado", () => {
  const a = barOf("a", 0, 1);
  const b = barOf("b", 1, 3);
  assert.equal(transitionPartner([a, b], b)?.id, "a");
  assert.equal(transitionPartner([a, b], a), null, "o primeiro clip não tem parceiro");
  const gap = barOf("b", 2, 3);
  assert.equal(transitionPartner([a, gap], gap), null, "com vão não há parceiro");
  const overlapped = barOf("b", 0.5, 2.5, {
    motion: { transition: { raw: "dissolver", preset: "dissolver", params: {}, dur: 0.5, partner: "a" } },
  });
  assert.equal(transitionPartner([a, overlapped], overlapped)?.id, "a");
  const nested = barOf("b", 1, 2, { parentId: "x" });
  assert.equal(transitionPartner([a, nested], nested), null, "só clips da raiz");
});

test("transitionParams larga o que o preset não aceita, o vazio e o padrão", () => {
  assert.deepEqual(transitionParams("cortina", { dir: "left" }, transitionPresets), { dir: "left" });
  assert.deepEqual(transitionParams("cortina", { dir: "right" }, transitionPresets), {}, "igual ao padrão");
  assert.deepEqual(transitionParams("dissolver", { dir: "left" }, transitionPresets), {}, "dissolver não tem dir");
  assert.deepEqual(transitionParams("cortina", { dir: "" }, transitionPresets), {});
});

test("percentSpan usa a mesma régua da barra e corta nas bordas", () => {
  assert.deepEqual(percentSpan(1, 0.5, 10), { left: 10, width: 5 });
  const edge = percentSpan(9.8, 1, 10);
  assert.ok(Math.abs(edge.left - 98) < 1e-9 && Math.abs(edge.width - 2) < 1e-9, JSON.stringify(edge));
  assert.deepEqual(percentSpan(1, 1, 0), { left: 0, width: 0 });
});
