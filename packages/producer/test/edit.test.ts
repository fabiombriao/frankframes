// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatches, EditError } from "../src/edit.ts";
import { loadComposition } from "@frankframes/contract";

const SOURCE = `<!doctype html>
<html><body>
  <!-- comentário que precisa sobreviver -->
  <div data-composition-id="main" data-root="true" data-duration="4">
    <div data-clip-id="a" data-start="0" data-duration="1" class="clip">olá</div>
    <div data-clip-id="b" data-start="a" data-duration="2" class="clip"><b>negrito</b></div>
  </div>
</body></html>`;

test("troca atributo existente sem re-serializar o arquivo", () => {
  const out = applyPatches(SOURCE, [{ clipId: "a", attributes: { "data-duration": "2.5" } }]);
  assert.ok(out.includes("<!-- comentário que precisa sobreviver -->"), "comentário preservado");
  assert.ok(out.includes('data-duration="2.5"'), "valor novo aplicado");
  assert.ok(out.includes('data-start="0"'));
  const composition = loadComposition(out);
  assert.equal(composition.ok, true);
  assert.deepEqual(composition.duration, { kind: "authored", seconds: 4 });
});

test("cria atributo ausente e remove com null", () => {
  const added = applyPatches(SOURCE, [{ clipId: "a", attributes: { "data-audio-role": "voice" } }]);
  assert.ok(added.includes('data-audio-role="voice"'));
  assert.equal(loadComposition(added).ok, true);

  const removed = applyPatches(SOURCE, [{ clipId: "a", attributes: { class: null } }]);
  const lineOfA = /<div [^>]*data-clip-id="a"[^>]*>/.exec(removed)?.[0] ?? "";
  assert.ok(!lineOfA.includes("class="), `classe deveria sair do clip a: ${lineOfA}`);
  assert.ok(/<div [^>]*data-clip-id="b"[^>]*class="clip"/.test(removed), "o outro clip mantém a classe");
  assert.equal(loadComposition(removed).ok, true);
});

test("edita texto simples e recusa elemento com marcação", () => {
  const out = applyPatches(SOURCE, [{ clipId: "a", text: "novo & melhor" }]);
  assert.ok(out.includes("novo &amp; melhor"));
  assert.equal(loadComposition(out).ok, true);

  assert.throws(
    () => applyPatches(SOURCE, [{ clipId: "b", text: "x" }]),
    (error: unknown) => error instanceof EditError && error.code === "E_TEXT_NOT_EDITABLE",
  );
});

test("clip inexistente e id duplicado falham alto", () => {
  assert.throws(
    () => applyPatches(SOURCE, [{ clipId: "zzz", text: "x" }]),
    (error: unknown) => error instanceof EditError && error.code === "E_CLIP_NOT_FOUND",
  );

  const duplicated = SOURCE.replace('data-clip-id="b"', 'data-clip-id="a"');
  assert.throws(
    () => applyPatches(duplicated, [{ clipId: "a", text: "x" }]),
    (error: unknown) => error instanceof EditError && error.code === "E_AMBIGUOUS_CLIP",
  );
});
