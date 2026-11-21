// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatches, applyTransition, deleteClip, EditError, splitClip } from "../src/edit.ts";
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

/* ------------------------- applyTransition (EDT-54) ------------------------- */

function clipOf(source: string, id: string) {
  const composition = loadComposition(source);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  const clip = composition.clips.find((item) => item.id === id);
  assert.ok(clip !== undefined, `clip ${id}`);
  return clip;
}

test("applyTransition em clips encostados grava data-transition e a sobreposição em data-start", () => {
  const out = applyTransition(SOURCE, { clipId: "b", preset: "dissolver", dur: 0.5 });
  assert.match(out, /data-clip-id="b"[^>]*data-start="a - 0\.5"/);
  assert.match(out, /data-transition="dissolver"/);
  assert.ok(out.includes("<!-- comentário que precisa sobreviver -->"));
  const b = clipOf(out, "b");
  assert.equal(b.start, 0.5);
  assert.equal(b.end, 2.5);
  assert.equal(clipOf(out, "a").end, 1, "A não muda");
});

test("outro dur muda só o deslocamento do data-start", () => {
  const first = applyTransition(SOURCE, { clipId: "b", preset: "dissolver", dur: 0.5 });
  const second = applyTransition(first, { clipId: "b", preset: "dissolver", dur: 0.8 });
  assert.equal(second, first.replace('data-start="a - 0.5"', 'data-start="a - 0.8"'));
  assert.ok(Math.abs((clipOf(second, "b").start ?? 0) - 0.2) < 1e-9);
});

test("trocar o preset mantém a sobreposição e aceita parâmetros do preset", () => {
  const first = applyTransition(SOURCE, { clipId: "b", preset: "dissolver", dur: 0.5 });
  const out = applyTransition(first, { clipId: "b", preset: "cortina", dur: 0.5, params: { dir: "left" } });
  assert.match(out, /data-transition="cortina dir=left"/);
  assert.match(out, /data-start="a - 0\.5"/);
  assert.equal(loadComposition(out).ok, true);
});

test("preset null volta a adjacente: data-start pelo fim de A e sem data-transition", () => {
  const first = applyTransition(SOURCE, { clipId: "b", preset: "dissolver", dur: 0.5 });
  const back = applyTransition(first, { clipId: "b", preset: null });
  assert.equal(back, SOURCE);
  assert.equal(applyTransition(SOURCE, { clipId: "b", preset: null }), SOURCE, "sem transição, nada a remover");
});

test("B com vão antes falha com E_TRANSITION_GAP", () => {
  const gap = SOURCE.replace('data-start="a" data-duration="2"', 'data-start="2" data-duration="1.5"');
  assert.throws(
    () => applyTransition(gap, { clipId: "b", preset: "dissolver", dur: 0.5 }),
    (error: unknown) => error instanceof EditError && error.code === "E_TRANSITION_GAP",
  );
  assert.throws(
    () => applyTransition(SOURCE, { clipId: "a", preset: "dissolver", dur: 0.5 }),
    (error: unknown) => error instanceof EditError && error.code === "E_TRANSITION_GAP",
    "o primeiro clip não tem A",
  );
  assert.throws(
    () => applyTransition(SOURCE, { clipId: "nao-existe", preset: "dissolver", dur: 0.5 }),
    (error: unknown) => error instanceof EditError && error.code === "E_CLIP_NOT_FOUND",
  );
});

test("A sem data-clip-id ganha um id explícito no mesmo patch e o resultado carrega", () => {
  // A sem id (o id automático `div#1` não serve em data-start); B começa em tempo absoluto.
  const anonymous = SOURCE.replace('<div data-clip-id="a" data-start="0"', '<div data-start="0"').replace(
    'data-clip-id="b" data-start="a"',
    'data-clip-id="b" data-start="1"',
  );
  const out = applyTransition(anonymous, { clipId: "b", preset: "dissolver", dur: 0.4 });
  const named = /<div data-start="0"[^>]*data-clip-id="([^"]+)"/.exec(out);
  assert.ok(named !== null, "A ganhou data-clip-id");
  assert.match(out, new RegExp(`data-start="${named[1]} - 0\\.4"`));
  assert.ok(Math.abs((clipOf(out, "b").start ?? 0) - 0.6) < 1e-9);
  assert.equal(clipOf(out, named[1]!).end, 1, "A continua onde estava");
});

test("preset que não é de transição e dur inválido falham com E_ATTRIBUTE_INVALID", () => {
  for (const request of [
    { clipId: "b", preset: "subir", dur: 0.5 },
    { clipId: "b", preset: "dissolver", dur: 0 },
    { clipId: "b", preset: "dissolver", dur: -1 },
    { clipId: "b", preset: "dissolver", dur: 0.5, params: { dir: "left=right" } },
  ]) {
    assert.throws(
      () => applyTransition(SOURCE, request),
      (error: unknown) => error instanceof EditError && error.code === "E_ATTRIBUTE_INVALID",
      JSON.stringify(request),
    );
  }
});

// ---- EDT-41: excluir clip sem mover o resto ----

const CHAIN = `<!doctype html>
<html><body>
  <!-- fica -->
  <div data-composition-id="main" data-root="true" data-duration="8">
    <div data-clip-id="a" data-start="0" data-duration="2">a</div>
    <div data-clip-id="b" data-start="a" data-duration="1">b</div>
    <div data-clip-id="c" data-start="b + 0.5" data-duration="1">c</div>
    <div data-clip-id="d" data-start="c" data-duration="1">d</div>
  </div>
</body></html>
`;

function startsOf(source: string): Record<string, number | undefined> {
  const composition = loadComposition(source);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  return Object.fromEntries(composition.clips.map((clip) => [clip.id, clip.start]));
}

/** O arquivo sem a (única) linha que contém `needle`. */
function withoutLine(source: string, needle: string): string {
  const lines = source.split(String.fromCharCode(10));
  const hit = lines.filter((line) => line.includes(needle));
  assert.equal(hit.length, 1, needle);
  return lines.filter((line) => !line.includes(needle)).join(String.fromCharCode(10));
}

function deleteError(source: string, clipId: string): EditError {
  try {
    deleteClip(source, { clipId });
  } catch (error) {
    assert.ok(error instanceof EditError, String(error));
    return error;
  }
  assert.fail("esperava EditError");
}

test("excluir b: quem começava no fim dele ganha início absoluto e nada se move", () => {
  const before = startsOf(CHAIN);
  const out = deleteClip(CHAIN, { clipId: "b" });
  const after = startsOf(out);
  assert.equal(after.b, undefined, "b saiu");
  assert.equal(after.a, before.a);
  assert.equal(after.c, before.c, "c continua no mesmo instante");
  assert.equal(after.d, before.d, "d (encadeado em c) também");
  assert.match(out, /data-clip-id="c" data-start="3.5"/);
  // Fora das linhas tocadas o arquivo é idêntico: só a linha de b sumiu e o data-start de c mudou.
  assert.equal(out, withoutLine(CHAIN, "data-clip-id=\"b\"").replace("data-start=\"b + 0.5\"", "data-start=\"3.5\""));
});

test("excluir sem referenciador só remove a linha, sem deixar vazio", () => {
  const out = deleteClip(CHAIN, { clipId: "d" });
  assert.equal(out, withoutLine(CHAIN, "data-clip-id=\"d\""));
  assert.ok(out.split(String.fromCharCode(10)).every((line) => line.trim() !== "" || line === ""), "sem linha só de espaço");
});

test("excluir o primeiro clip da cadeia dá início absoluto ao seguinte (0 + duração)", () => {
  const before = startsOf(CHAIN);
  const out = deleteClip(CHAIN, { clipId: "a" });
  const after = startsOf(out);
  assert.equal(after.b, before.b);
  assert.equal(after.c, before.c);
});

test("clip com filhos sai inteiro, e o referenciador mantém o início", () => {
  const nested = `<div data-composition-id="main" data-root="true" data-duration="8">
  <div data-clip-id="host" data-composition-id="card" data-start="0" data-duration="2">
    <div data-clip-id="inner" data-start="0" data-duration="1">x</div>
  </div>
  <div data-clip-id="after" data-start="host" data-duration="1">y</div>
</div>
`;
  const before = startsOf(nested);
  const out = deleteClip(nested, { clipId: "host" });
  assert.ok(!out.includes("inner") && !out.includes("host"), out);
  assert.equal(startsOf(out).after, before.after);
});

test("referência de fora para um filho do clip excluído é recusada (atravessaria escopos)", () => {
  const nested = `<div data-composition-id="main" data-root="true" data-duration="8">
  <div data-clip-id="host" data-composition-id="card" data-start="0" data-duration="2">
    <div data-clip-id="inner" data-start="0" data-duration="1">x</div>
  </div>
  <div data-clip-id="after" data-start="inner" data-duration="1">y</div>
</div>
`;
  const error = deleteError(nested, "host");
  assert.equal(error.code, "E_DELETE_UNSUPPORTED");
  assert.match(error.message, /after/);
});

test("referenciador dentro de sub-composição apontando para clip da raiz é recusado", () => {
  const nested = `<div data-composition-id="main" data-root="true" data-duration="8">
  <div data-clip-id="a" data-start="0" data-duration="2">a</div>
  <div data-clip-id="host" data-composition-id="card" data-start="0" data-duration="4">
    <div data-clip-id="inner" data-start="a" data-duration="1">x</div>
  </div>
</div>
`;
  assert.equal(deleteError(nested, "a").code, "E_DELETE_UNSUPPORTED");
});

test("excluir clip de dentro de sub-composição é E_DELETE_UNSUPPORTED com dica", () => {
  const nested = `<div data-composition-id="main" data-root="true" data-duration="8">
  <div data-clip-id="host" data-composition-id="card" data-start="0" data-duration="2">
    <div data-clip-id="inner" data-start="0" data-duration="1">x</div>
  </div>
</div>
`;
  const error = deleteError(nested, "inner");
  assert.equal(error.code, "E_DELETE_UNSUPPORTED");
  assert.match(error.message, /sub-composição/);
});

test("referenciador sem data-clip-id é E_DELETE_UNSUPPORTED", () => {
  const anonymous = CHAIN.replace(`<div data-clip-id="c" data-start="b + 0.5"`, `<div data-start="b + 0.5"`);
  const error = deleteError(anonymous, "b");
  assert.equal(error.code, "E_DELETE_UNSUPPORTED");
  assert.match(error.message, /data-clip-id/);
});

test("id inexistente é E_CLIP_NOT_FOUND", () => {
  assert.equal(deleteError(CHAIN, "nope").code, "E_CLIP_NOT_FOUND");
});

test("transição: excluir A tira a transição de B e B não se move; excluir B só remove B", () => {
  const withTransition = CHAIN.replace(
    `<div data-clip-id="c" data-start="b + 0.5"`,
    `<div data-clip-id="c" data-start="b - 0.5" data-transition="dissolver"`,
  );
  const before = startsOf(withTransition);
  const outA = deleteClip(withTransition, { clipId: "b" });
  assert.ok(!/data-transition/.test(outA), "a transição saiu junto com o parceiro");
  const after = startsOf(outA);
  assert.equal(after.c, before.c, "c continua no mesmo instante");
  assert.equal(loadComposition(outA).ok, true);

  const outB = deleteClip(withTransition, { clipId: "c" });
  assert.ok(!outB.includes('data-clip-id="c"'));
  assert.equal(loadComposition(outB).ok, true);
  assert.equal(startsOf(outB).d, before.d, "d referenciava c e ganhou início absoluto igual ao de antes");
});
