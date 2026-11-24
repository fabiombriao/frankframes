// FrankFrames — proprietário. Ver LICENSE na raiz.
// Funções puras de composition.js (cliente do Studio): campos do inspetor de Composição, corpo do POST e aviso de fim (EDT-84).
import { test } from "node:test";
import assert from "node:assert/strict";
import { compositionFields, compositionPatch, fpsText, pastEndNotice, PAST_END_CODE } from "../src/studio/composition.js";
import { CODES } from "@frankframes/contract";

const AUTHORED = { durationKind: "authored" as const, duration: 4, width: 1920, height: 1080, fps: { num: 30, den: 1 } };
const DERIVED = { durationKind: "derived" as const, duration: 68, width: null, height: null, fps: { num: 30000, den: 1001 } };

test("fpsText escreve inteiro e fps racional no formato de data-fps", () => {
  assert.equal(fpsText({ num: 30, den: 1 }), "30");
  assert.equal(fpsText({ num: 30000, den: 1001 }), "30000/1001");
  assert.equal(fpsText(24), "24");
  assert.equal(fpsText(undefined), "");
});

test("compositionFields: raiz autoral preenche a duração; derivada marca o checkbox e esvazia o campo", () => {
  assert.deepEqual(compositionFields(AUTHORED), { duration: "4", derived: false, width: "1920", height: "1080", fps: "30" });
  assert.deepEqual(compositionFields(DERIVED), { duration: "", derived: true, width: "", height: "", fps: "30000/1001" });
});

test("compositionPatch manda só o que mudou e nada quando nada mudou", () => {
  const same = compositionFields(AUTHORED);
  assert.deepEqual(compositionPatch(AUTHORED, same), { body: null, error: null });
  assert.deepEqual(compositionPatch(AUTHORED, { ...same, duration: "68" }), { body: { duration: 68 }, error: null });
  assert.deepEqual(compositionPatch(AUTHORED, { ...same, width: "1280", height: "720", fps: "60" }), {
    body: { width: 1280, height: 720, fps: "60" },
    error: null,
  });
});

test('compositionPatch: marcar "derivada" envia duration null (remove data-duration); já derivada não reenvia', () => {
  const fields = compositionFields(AUTHORED);
  assert.deepEqual(compositionPatch(AUTHORED, { ...fields, derived: true }), { body: { duration: null }, error: null });
  assert.deepEqual(compositionPatch(DERIVED, compositionFields(DERIVED)), { body: null, error: null });
  assert.deepEqual(compositionPatch(DERIVED, { ...compositionFields(DERIVED), derived: false, duration: "70" }), {
    body: { duration: 70 },
    error: null,
  });
});

test("compositionPatch recusa duração vazia ou <= 0, tamanho não numérico e fps vazio, sem corpo", () => {
  const fields = compositionFields(AUTHORED);
  for (const bad of [{ duration: "" }, { duration: "0" }, { duration: "-2" }, { duration: "abc" }, { width: "" }, { height: "x" }, { fps: "  " }]) {
    const result = compositionPatch(AUTHORED, { ...fields, ...bad });
    assert.equal(result.body, null, JSON.stringify(bad));
    assert.equal(typeof result.error, "string", JSON.stringify(bad));
  }
});

test("pastEndNotice só existe com W_CLIP_PAST_END e lista os clips afetados", () => {
  assert.equal(PAST_END_CODE, CODES.CLIP_PAST_END, "o cliente usa o código registrado no contrato");
  assert.equal(pastEndNotice([]), null);
  assert.equal(pastEndNotice(undefined), null);
  assert.equal(pastEndNotice([{ code: "W_OUTRO", severity: "warning", message: "x" }]), null);
  const notice = pastEndNotice([
    { code: PAST_END_CODE, severity: "warning", message: "o clip a passa", hint: "suba o fim", clipId: "a" },
    { code: "W_OUTRO", severity: "warning", message: "x" },
    { code: PAST_END_CODE, severity: "warning", message: "o clip b passa", clipId: "b" },
  ]);
  assert.deepEqual(notice, { count: 2, ids: ["a", "b"], message: "o clip a passa", hint: "suba o fim" });
});
