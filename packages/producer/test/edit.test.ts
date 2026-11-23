// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatches, applyTransition, deleteClip, duplicateClip, EditError, splitClip, trimClipStart } from "../src/edit.ts";
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

// ---- EDT-42: aparar pela borda esquerda ----

const TRIM = `<!doctype html>
<html><body>
  <div data-composition-id="main" data-root="true" data-duration="10">
    <video data-clip-id="v" src="assets/v.mp4" data-start="1" data-duration="4" data-offset="0.5" data-playback-rate="2" data-fade-in="0.5"></video>
    <div data-clip-id="after" data-start="v" data-duration="1">fim</div>
    <div data-clip-id="a" data-start="6" data-duration="2">a</div>
    <div data-clip-id="r" data-start="a + 0.5" data-duration="1.5">r</div>
  </div>
</body></html>
`;

function clipsOf(source: string) {
  const composition = loadComposition(source);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  return new Map(composition.clips.map((clip) => [clip.id, clip]));
}

function trimError(source: string, clipId: string, start: number): EditError {
  try {
    trimClipStart(source, { clipId, start });
  } catch (error) {
    assert.ok(error instanceof EditError, String(error));
    return error;
  }
  assert.fail("esperava EditError");
}

test("aparar vídeo: início, duração e offset (× taxa) mudam e o fim fica parado", () => {
  const before = clipsOf(TRIM);
  const out = trimClipStart(TRIM, { clipId: "v", start: 2 });
  const after = clipsOf(out);
  const v = after.get("v")!;
  assert.equal(v.start, 2);
  assert.equal(v.end, before.get("v")!.end, "o fim não se move");
  assert.equal(v.end, 5);
  assert.equal(v.authoredDuration, 3);
  // 1 s de timeline a 2× = 2 s de fonte a mais: 0,5 + 2.
  assert.equal(v.offset, 2.5);
  assert.equal(v.fadeIn, 0.5, "fade de entrada continua");
  // Só os três atributos mudam, no mesmo lugar.
  assert.equal(out, TRIM.replace(`data-start="1" data-duration="4" data-offset="0.5"`, `data-start="2" data-duration="3" data-offset="2.5"`));
});

test("aparar não move ninguém: quem começa no fim do clip e quem referencia outro clip ficam onde estavam", () => {
  const before = clipsOf(TRIM);
  const after = clipsOf(trimClipStart(TRIM, { clipId: "v", start: 3 }));
  for (const id of ["after", "a", "r"]) {
    assert.equal(after.get(id)!.start, before.get(id)!.start, id);
    assert.equal(after.get(id)!.end, before.get(id)!.end, id);
  }
  // Cadeia por referência: b termina em 3, c = b + 0,5 e d = c continuam iguais.
  const chainBefore = startsOf(CHAIN);
  const chainAfter = startsOf(trimClipStart(CHAIN, { clipId: "b", start: 2.5 }));
  assert.deepEqual(chainAfter, { ...chainBefore, b: 2.5 });
});

test("aparar clip com início por referência soma o deslocamento ao offset da referência", () => {
  const out = trimClipStart(TRIM, { clipId: "r", start: 9.5 });
  assert.match(out, /data-clip-id="r" data-start="a \+ 1\.5" data-duration="0\.5"/);
  const r = clipsOf(out).get("r")!;
  assert.equal(r.start, 9.5);
  assert.equal(r.end, 10);
  // Voltando o início para antes, o deslocamento diminui e some quando zera.
  const back = trimClipStart(TRIM, { clipId: "r", start: 8 });
  assert.match(back, /data-clip-id="r" data-start="a" data-duration="2"/);
});

test("aparar para a esquerda devolve material à mídia (offset diminui) até a borda da fonte", () => {
  const source = TRIM.replace(`data-offset="0.5"`, `data-offset="1"`);
  const out = trimClipStart(source, { clipId: "v", start: 0.75 });
  const v = clipsOf(out).get("v")!;
  assert.equal(v.start, 0.75);
  assert.equal(v.end, 5);
  assert.equal(v.offset, 0.5);
  // Limite exato: 1 s de offset a 2× libera 0,5 s de timeline.
  const edge = clipsOf(trimClipStart(source, { clipId: "v", start: 0.5 })).get("v")!;
  assert.equal(edge.offset, 0);
  assert.equal(edge.end, 5);
});

test("aparar além do começo da fonte, abaixo de zero ou sem duração mínima é E_TRIM_OUT_OF_RANGE", () => {
  // offset 0,5 a 2× só libera 0,25 s antes do início atual.
  const early = trimError(TRIM, "v", 0.5);
  assert.equal(early.code, "E_TRIM_OUT_OF_RANGE");
  assert.match(early.message, /0\.75/, "diz o início mais cedo possível");
  assert.equal(trimError(TRIM, "a", -1).code, "E_TRIM_OUT_OF_RANGE");
  assert.equal(trimError(TRIM, "v", 5).code, "E_TRIM_OUT_OF_RANGE");
  assert.equal(trimError(TRIM, "v", 4.999).code, "E_TRIM_OUT_OF_RANGE");
  assert.equal(trimError(TRIM, "v", Number.NaN).code, "E_TRIM_OUT_OF_RANGE");
  // O mínimo (1/60 s) ainda passa.
  assert.equal(clipsOf(trimClipStart(TRIM, { clipId: "v", start: 5 - 1 / 60 })).get("v")!.end, 5);
});

test("aparar clip com data-keyframes é E_TRIM_UNSUPPORTED", () => {
  const source = TRIM.replace(`data-fade-in="0.5"`, `data-keyframes='[{"time":0,"volume":1}]'`);
  assert.equal(trimError(source, "v", 2).code, "E_TRIM_UNSUPPORTED");
});

test("aparar clip com data-transition é E_TRIM_UNSUPPORTED com dica", () => {
  const withTransition = CHAIN.replace(
    `<div data-clip-id="c" data-start="b + 0.5"`,
    `<div data-clip-id="c" data-start="b - 0.5" data-transition="dissolver"`,
  );
  const error = trimError(withTransition, "c", 3.5);
  assert.equal(error.code, "E_TRIM_UNSUPPORTED");
  assert.match(error.message, /remova a transição antes de aparar/);
});

test("aparar clip aninhado, clip com filhos ou clip sem fim resolvido é E_TRIM_UNSUPPORTED", () => {
  const nested = `<div data-composition-id="main" data-root="true" data-duration="8">
  <div data-clip-id="host" data-composition-id="card" data-start="0" data-duration="4">
    <div data-clip-id="inner" data-start="0" data-duration="2">x</div>
  </div>
</div>
`;
  assert.equal(trimError(nested, "inner", 1).code, "E_TRIM_UNSUPPORTED");
  assert.equal(trimError(nested, "host", 1).code, "E_TRIM_UNSUPPORTED");
  const open = `<div data-composition-id="main" data-root="true" data-duration="8">
  <video data-clip-id="m" src="assets/m.mp4" data-start="1"></video>
</div>
`;
  const unresolved = trimError(open, "m", 2);
  assert.equal(unresolved.code, "E_TRIM_UNSUPPORTED");
  assert.match(unresolved.message, /data-duration/);
  assert.equal(trimError(TRIM, "nope", 2).code, "E_CLIP_NOT_FOUND");
});

test("aparar clip com movimento próprio é permitido e não mexe nos atributos de movimento", () => {
  const source = TRIM.replace(`<div data-clip-id="a" data-start="6"`, `<div data-clip-id="a" data-enter="surgir" data-start="6"`);
  const out = trimClipStart(source, { clipId: "a", start: 7 });
  assert.match(out, /data-clip-id="a" data-enter="surgir" data-start="7" data-duration="1"/);
  assert.equal(clipsOf(out).get("a")!.end, 8);
});

test("aparar sem mudar nada devolve o arquivo idêntico", () => {
  assert.equal(trimClipStart(TRIM, { clipId: "v", start: 1 }), TRIM);
});

// ---- EDT-75: ids hifenizados (clip-N) nas edições que escrevem referência sem deslocamento ----

test("split de clip-3 com referenciador de deslocamento 0 mantém a composição válida e o referenciador parado", () => {
  const source = `<div data-composition-id="main" data-root="true" data-duration="8">
  <div data-clip-id="clip-3" data-start="0" data-duration="4">x</div>
  <div data-clip-id="clip-5" data-start="clip-3" data-duration="1">y</div>
</div>
`;
  const before = startsOf(source);
  assert.equal(before["clip-5"], 4);
  const out = splitClip(source, { clipId: "clip-3", at: 2, newId: "clip-4" });
  assert.match(out, /data-clip-id="clip-5" data-start="clip-4"/);
  const after = startsOf(out);
  assert.equal(after["clip-5"], 4, "o referenciador continua no mesmo instante");
  assert.equal(after["clip-4"], 2);
});

test("aparar clip com data-start=\"clip-1 + 1\" até deslocamento 0 grava clip-1 e o fim fica parado", () => {
  const source = `<div data-composition-id="main" data-root="true" data-duration="8">
  <div data-clip-id="clip-1" data-start="0" data-duration="2">a</div>
  <div data-clip-id="clip-2" data-start="clip-1 + 1" data-duration="2">b</div>
</div>
`;
  const out = trimClipStart(source, { clipId: "clip-2", start: 2 });
  assert.match(out, /data-clip-id="clip-2" data-start="clip-1" data-duration="3"/);
  const clip = clipsOf(out).get("clip-2")!;
  assert.equal(clip.start, 2);
  assert.equal(clip.end, 5);
});

// ---- EDT-43: copiar, colar e duplicar ----

const DUP = `<!doctype html>
<html><body>
  <div data-composition-id="main" data-root="true" data-duration="10">
    <div data-clip-id="t" data-start="1" data-duration="2" data-enter="surgir">título</div>
    <div data-clip-id="u" data-start="t" data-duration="1">u</div>
  </div>
</body></html>
`;

function duplicateError(source: string, clipId: string, at: number, newId = "clip-9"): EditError {
  try {
    duplicateClip(source, { clipId, at, newId });
  } catch (error) {
    assert.ok(error instanceof EditError, String(error));
    return error;
  }
  assert.fail("era para falhar");
}

test("duplicar insere a cópia logo depois do original, com início absoluto e sem tocar no resto", () => {
  const { source, warnings } = duplicateClip(DUP, { clipId: "t", at: 3, newId: "clip-9" });
  assert.deepEqual(warnings, []);
  const original = `    <div data-clip-id="t" data-start="1" data-duration="2" data-enter="surgir">título</div>\n`;
  const copy = `    <div data-clip-id="clip-9" data-start="3" data-duration="2" data-enter="surgir">título</div>\n`;
  assert.ok(source.includes(original + copy), source);
  assert.equal(source.replace(copy, ""), DUP, "fora da cópia o arquivo é idêntico");
  const clips = clipsOf(source);
  assert.equal(clips.get("clip-9")!.start, 3);
  assert.equal(clips.get("clip-9")!.end, 5);
  assert.equal(clips.get("t")!.start, 1);
  assert.equal(clips.get("u")!.start, 3, "quem referenciava o original continua onde estava");
});

const GROUP = `<div data-composition-id="main" data-root="true" data-duration="12">
  <div data-clip-id="a" data-start="0" data-duration="1">a</div>
  <div data-clip-id="g" data-composition-id="card" data-start="a" data-duration="4">
    <div data-clip-id="g1" data-start="0" data-duration="1">um</div>
    <div data-clip-id="g2" data-start="g1 + 0.5" data-duration="1">dois</div>
    <div data-clip-id="g3" data-start="a" data-duration="1">fora</div>
  </div>
</div>
`;

test("container: ids internos viram <novo>-<antigo>, referências internas seguem e as externas ficam", () => {
  const { source } = duplicateClip(GROUP, { clipId: "g", at: 6, newId: "clip-9" });
  assert.match(source, /data-clip-id="clip-9" data-composition-id="card" data-start="6" data-duration="4"/);
  assert.match(source, /data-clip-id="clip-9-g1" data-start="0"/);
  assert.match(source, /data-clip-id="clip-9-g2" data-start="clip-9-g1 \+ 0.5"/);
  assert.match(source, /data-clip-id="clip-9-g3" data-start="a"/, "referência para fora da cópia não muda");
  const composition = loadComposition(source);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  const copy = composition.clips.find((clip) => clip.id === "clip-9")!;
  const [g1, g2] = copy.children;
  assert.equal(g1!.id, "clip-9-g1");
  assert.equal(g2!.start, g1!.end! + 0.5, "id hifenizado resolve pelo id exato (EDT-75)");
  assert.equal(composition.clips.find((clip) => clip.id === "g")!.start, 1, "original intacto");
});

test("referência interna sem deslocamento a um irmão com id hifenizado continua resolvendo", () => {
  const source = GROUP.replace('data-start="g1 + 0.5"', 'data-start="g1"');
  const { source: out } = duplicateClip(source, { clipId: "g", at: 6, newId: "clip-9" });
  assert.match(out, /data-clip-id="clip-9-g2" data-start="clip-9-g1"/);
  const composition = loadComposition(out);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  const [g1, g2] = composition.clips.find((clip) => clip.id === "clip-9")!.children;
  assert.equal(g2!.start, g1!.end);
});

test("transição entre dois filhos continua válida na cópia", () => {
  const source = GROUP.replace(
    'data-clip-id="g2" data-start="g1 + 0.5"',
    'data-clip-id="g2" data-start="g1 - 0.4" data-transition="dissolver"',
  );
  assert.equal(loadComposition(source).ok, true, JSON.stringify(loadComposition(source).diagnostics));
  const { source: out, warnings } = duplicateClip(source, { clipId: "g", at: 6, newId: "clip-9" });
  assert.deepEqual(warnings, []);
  assert.match(out, /data-clip-id="clip-9-g2" data-start="clip-9-g1 - 0.4" data-transition="dissolver"/);
  const composition = loadComposition(out);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
});

test("data-transition da raiz não é copiado e vira aviso", () => {
  const source = CHAIN.replace(`data-start="b + 0.5"`, `data-start="b - 0.5" data-transition="dissolver"`);
  const { source: out, warnings } = duplicateClip(source, { clipId: "c", at: 6, newId: "clip-9" });
  assert.deepEqual(warnings, ["transição não copiada"]);
  assert.ok(out.includes(`data-clip-id="clip-9" data-start="6" data-duration="1">c<`), out);
  assert.equal(out.match(/data-transition/g)?.length, 1, "só o original mantém a transição");
  assert.equal(loadComposition(out).ok, true);
  assert.equal(clipsOf(out).get("clip-9")!.start, 6);
});

test("id HTML dentro da cópia vira aviso e continua igual", () => {
  const source = DUP.replace(`data-enter="surgir">título`, `data-enter="surgir"><img id="logo" src="x.png">título`);
  const { source: out, warnings } = duplicateClip(source, { clipId: "t", at: 3, newId: "clip-9" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /logo/);
  assert.equal(out.match(/id="logo"/g)?.length, 2);
  assert.equal(loadComposition(out).ok, true);
});

test("data-keyframes e movimento vêm junto, com os mesmos pontos", () => {
  const source = DUP.replace(
    `data-enter="surgir">título`,
    `data-enter="surgir" data-volume="0.8" data-keyframes='[{"time":0,"volume":1},{"time":1,"volume":0.2}]'>título`,
  );
  const { source: out } = duplicateClip(source, { clipId: "t", at: 5, newId: "clip-9" });
  const composition = loadComposition(out);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  const original = composition.clips.find((clip) => clip.id === "t")!;
  const copy = composition.clips.find((clip) => clip.id === "clip-9")!;
  assert.deepEqual(copy.keyframes, original.keyframes);
  assert.equal(copy.volume, 0.8);
  assert.ok(out.includes(`data-clip-id="clip-9" data-start="5" data-duration="2" data-enter="surgir"`));
});

test("clip aninhado é E_COPY_UNSUPPORTED; clip inexistente é E_CLIP_NOT_FOUND", () => {
  assert.equal(duplicateError(GROUP, "g1", 6).code, "E_COPY_UNSUPPORTED");
  assert.equal(duplicateError(GROUP, "nada", 6).code, "E_CLIP_NOT_FOUND");
});

test("início negativo ou não finito é E_COPY_OUT_OF_RANGE", () => {
  assert.equal(duplicateError(DUP, "t", -1).code, "E_COPY_OUT_OF_RANGE");
  assert.equal(duplicateError(DUP, "t", Number.NaN).code, "E_COPY_OUT_OF_RANGE");
  assert.equal(duplicateError(DUP, "t", Number.POSITIVE_INFINITY).code, "E_COPY_OUT_OF_RANGE");
});

test("id novo já existente (da raiz ou de um descendente) é E_AMBIGUOUS_CLIP", () => {
  assert.equal(duplicateError(DUP, "t", 3, "u").code, "E_AMBIGUOUS_CLIP");
  const clash = GROUP.replace("</div>\n</div>\n", `</div>\n  <div data-clip-id="clip-9-g1" data-start="0" data-duration="1">z</div>\n</div>\n`);
  assert.equal(duplicateError(clash, "g", 6, "clip-9").code, "E_AMBIGUOUS_CLIP");
});

test("sub-composição por arquivo: a cópia leva a referência, não o outro arquivo", () => {
  const source = `<div data-composition-id="main" data-root="true" data-duration="8">
  <div data-clip-id="sub" data-composition-src="parts/card.html" data-start="0" data-duration="3"></div>
</div>
`;
  const { source: out } = duplicateClip(source, { clipId: "sub", at: 3, newId: "clip-9" });
  assert.equal(out.match(/data-composition-src="parts\/card.html"/g)?.length, 2);
  assert.match(out, /data-clip-id="clip-9" data-composition-src="parts\/card.html" data-start="3" data-duration="3"/);
});
