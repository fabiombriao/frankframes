// FrankFrames — proprietário. Ver LICENSE na raiz.
// Inspetor de clip e de composição (EDT-85): reescreve só o atributo que o usuário mudou e nunca arredonda o que veio da fonte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { displayNumber, numericChanges } from "../src/studio/inspector.js";
import { compositionFields, compositionPatch } from "../src/studio/composition.js";

/** Um campo como o inspetor o preenche: `shown` é o texto exibido; `text` é o que o usuário deixou no campo. */
function field(key: string, original: number | null, edited?: string): { key: string; shown: string; text: string; original: number | null } {
  const shown = displayNumber(original);
  return { key, shown, text: edited ?? shown, original };
}

test("displayNumber arredonda a milissegundo só para exibir e esvazia o ausente", () => {
  assert.equal(displayNumber(68.164583), "68.165");
  assert.equal(displayNumber(2), "2");
  assert.equal(displayNumber(0.0004), "0");
  assert.equal(displayNumber(null), "");
  assert.equal(displayNumber(undefined), "");
});

test("EDT-85: mudar só o início não reescreve a duração derivada da fonte (68,164583 não vira 68.165)", () => {
  const { attributes, errors } = numericChanges([
    field("data-start", 0, "3"),
    field("data-duration", 68.164583),
    field("data-media-start", null),
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(attributes, { "data-start": "3" });
  assert.ok(!("data-duration" in attributes), "a duração não foi tocada e não pode ser regravada");
});

test("EDT-85: nada editado não gera nenhuma mudança, por mais arredondado que seja o texto exibido", () => {
  const { attributes, errors } = numericChanges([field("data-start", 1.0004), field("data-duration", 68.164583), field("data-volume", 0.3333333)]);
  assert.deepEqual({ attributes, errors }, { attributes: {}, errors: [] });
});

test("EDT-85: o campo que o usuário editou é gravado exatamente como digitado", () => {
  const { attributes } = numericChanges([field("data-start", 0), field("data-duration", 68.164583, "10.5")]);
  assert.deepEqual(attributes, { "data-duration": "10.5" });
});

test("EDT-85: digitar o valor arredondado exibido não é edição; digitar valor com mais casas é", () => {
  assert.deepEqual(numericChanges([field("data-duration", 68.164583, "68.165")]).attributes, {}, "texto igual ao exibido");
  assert.deepEqual(numericChanges([field("data-duration", 68.164583, "68.164583")]).attributes, {}, "texto diferente, mesmo valor da fonte");
  assert.deepEqual(numericChanges([field("data-duration", 68.164583, "68.1646")]).attributes, { "data-duration": "68.1646" });
});

test("EDT-85: esvaziar um campo existente remove o atributo; esvaziar um ausente não faz nada", () => {
  assert.deepEqual(numericChanges([field("data-media-start", 4, "")]).attributes, { "data-media-start": null });
  assert.deepEqual(numericChanges([field("data-media-start", null, "")]).attributes, {});
});

test("EDT-85: preencher um atributo que não existia grava o valor", () => {
  assert.deepEqual(numericChanges([field("data-media-start", null, "2")]).attributes, { "data-media-start": "2" });
});

test("EDT-85: texto que não é número vira erro e não vira atributo", () => {
  const { attributes, errors } = numericChanges([field("data-start", 1, "abc"), field("data-duration", 2, "3")]);
  assert.deepEqual(attributes, { "data-duration": "3" });
  assert.equal(errors.length, 1);
  assert.match(errors[0] as string, /data-start/);
});

test("EDT-85: o inspetor da composição também não regrava a duração arredondada da fonte", () => {
  // Raiz com data-duration de 7 casas: o campo mostra 6, mudar só a largura não pode reenviar a duração.
  const data = { durationKind: "authored" as const, duration: 68.1645833, width: 1920, height: 1080, fps: { num: 30, den: 1 } };
  const fields = compositionFields(data);
  assert.equal(fields.duration, "68.164583");
  assert.deepEqual(compositionPatch(data, { ...fields, width: "1280" }), { body: { width: 1280 }, error: null });
  assert.deepEqual(compositionPatch(data, fields), { body: null, error: null });
  assert.deepEqual(compositionPatch(data, { ...fields, duration: "70" }), { body: { duration: 70 }, error: null });
});
