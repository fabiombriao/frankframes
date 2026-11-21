// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatches, EditError, splitClip } from "../src/edit.ts";
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

const SPLIT_SOURCE = `<!doctype html>
<html><body>
  <div data-composition-id="main" data-root="true">
    <video data-clip-id="v" src="assets/v.mp4" data-start="1" data-duration="4" data-offset="2" data-playback-rate="2" data-fade-in="0.5" data-fade-out="0.5"></video>
    <div data-clip-id="after" data-start="v + 1" data-duration="1" class="clip">fim</div>
  </div>
</body></html>`;

test("split divide o clip, ajusta offset de mídia e mantém o resto da timeline", () => {
  const out = splitClip(SPLIT_SOURCE, { clipId: "v", at: 2.5, newId: "v-2" });
  const composition = loadComposition(out);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  const byId = new Map(composition.clips.map((clip) => [clip.id, clip]));
  const first = byId.get("v")!;
  const second = byId.get("v-2")!;
  assert.equal(first.start, 1);
  assert.equal(first.end, 2.5);
  assert.equal(first.fadeOut, undefined, "primeira metade perde o fade de saída");
  assert.equal(first.fadeIn, 0.5);
  assert.equal(second.start, 2.5);
  assert.equal(second.end, 5);
  assert.equal(second.fadeIn, undefined, "segunda metade perde o fade de entrada");
  assert.equal(second.fadeOut, 0.5);
  // 1,5 s de timeline a 2× = 3 s de fonte já tocados.
  assert.equal(second.offset, 5);
  assert.equal(second.mediaSrc, "assets/v.mp4");
  assert.equal(byId.get("after")!.start, 6, "quem vinha depois do clip continua no mesmo lugar");
  assert.ok(out.includes('data-start="v-2 + 1"'), "referência reescrita para a segunda metade");
});

test("split recusa corte fora do clip e clip inexistente", () => {
  assert.throws(() => splitClip(SPLIT_SOURCE, { clipId: "v", at: 1, newId: "x" }), (error: unknown) => error instanceof EditError && error.code === "E_SPLIT_OUT_OF_RANGE");
  assert.throws(() => splitClip(SPLIT_SOURCE, { clipId: "v", at: 5, newId: "x" }), (error: unknown) => error instanceof EditError && error.code === "E_SPLIT_OUT_OF_RANGE");
  assert.throws(() => splitClip(SPLIT_SOURCE, { clipId: "nada", at: 2, newId: "x" }), (error: unknown) => error instanceof EditError && error.code === "E_CLIP_NOT_FOUND");
  assert.throws(() => splitClip(SPLIT_SOURCE, { clipId: "v", at: 2, newId: "after" }), (error: unknown) => error instanceof EditError && error.code === "E_AMBIGUOUS_CLIP");
});

test("split recusa clip com automação de volume", () => {
  const source = SPLIT_SOURCE.replace('data-fade-in="0.5"', `data-keyframes='[{"time":0,"volume":1}]'`);
  assert.throws(() => splitClip(source, { clipId: "v", at: 2, newId: "x" }), (error: unknown) => error instanceof EditError && error.code === "E_SPLIT_UNSUPPORTED");
});
