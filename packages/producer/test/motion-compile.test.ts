// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "parse5";
import { loadComposition } from "@frankframes/contract";
import { annotateTiming, compileComposition } from "../src/compile.ts";
import { annotateMotion, toRuntimeSpec } from "../src/motion.ts";
import type { MotionRuntimeSpec } from "../src/motion.ts";
import { EditError, splitClip } from "../src/edit.ts";
import { RENDER_ERROR_CODES, toErrorPayload } from "../src/errors.ts";

const wrap = (body: string, root = 'data-composition-id="main" data-root="true" data-fps="30" data-duration="6"'): string =>
  `<!doctype html><html><body><div ${root}>${body}</div></body></html>`;

/** Lê `data-ff-motion` de cada elemento com id, em ordem de documento. */
function specs(html: string): Record<string, MotionRuntimeSpec> {
  const out: Record<string, MotionRuntimeSpec> = {};
  const document = parse(html) as unknown as { childNodes: Array<Record<string, unknown>> };
  const visit = (nodes: Array<Record<string, unknown>> | undefined): void => {
    for (const node of nodes ?? []) {
      const attrs = (node["attrs"] as Array<{ name: string; value: string }> | undefined) ?? [];
      const spec = attrs.find((a) => a.name === "data-ff-motion");
      const id = attrs.find((a) => a.name === "id")?.value;
      if (spec && id) out[id] = JSON.parse(spec.value) as MotionRuntimeSpec;
      visit(node["childNodes"] as Array<Record<string, unknown>> | undefined);
    }
  };
  visit(document.childNodes);
  return out;
}

test("o compilador grava data-ff-motion: entrada, saída e atraso relativo ao escopo", async () => {
  const entryHtml = wrap(`
    <div id="a" data-clip-id="a" data-start="2" data-duration="3" data-enter="surgir" data-exit="apagar dur=1"></div>`);
  const compiled = await compileComposition({ entryHtml, entryDir: "." });
  assert.equal(compiled.composition.ok, true, JSON.stringify(compiled.composition.diagnostics));
  const spec = specs(compiled.html)["a"]!;
  assert.equal(spec.v, 1);
  assert.equal(spec.a.length, 1, "uma trilha por propriedade: entrada e saída viram uma só");
  const track = spec.a[0]!;
  assert.equal(track.p, "opacity");
  assert.equal(track.d, 2000, "começa no início do clip (escopo da raiz = 0)");
  assert.equal(track.n, 3000, "da entrada ao fim da saída");
  assert.deepEqual(track.k.map((key) => key[0]), [0, 0.166667, 0.666667, 1], "entrada em [0,0,5s], saída em [2s,3s]");
  assert.deepEqual(track.k.map((key) => key[1]), [0, 1, 1, 0]);
  assert.deepEqual(spec.s, [], "opacity não precisa de ligação");
});

test("pulsar liga scale e escreve as duas variáveis", async () => {
  const entryHtml = wrap(`<div id="p" data-clip-id="p" data-start="0" data-duration="4" data-emphasis="pulsar at=1 repeat=2"></div>`);
  const compiled = await compileComposition({ entryHtml, entryDir: "." });
  assert.equal(compiled.composition.ok, true, JSON.stringify(compiled.composition.diagnostics));
  const spec = specs(compiled.html)["p"]!;
  assert.deepEqual(spec.a.map((item) => item.p).sort(), ["--ff-sx", "--ff-sy"]);
  assert.deepEqual(spec.s, [["scale", "var(--ff-sx) var(--ff-sy)"]]);
  assert.equal(spec.a[0]!.d, 1000);
});

test("descendente: o atraso usa o data-ff-comp-start do escopo real do elemento", async () => {
  const entryHtml = wrap(`
    <div data-clip-id="outer" data-start="1" data-duration="4">
      <p id="inner" data-enter="surgir at=0.5"></p>
    </div>`);
  const compiled = await compileComposition({ entryHtml, entryDir: "." });
  assert.equal(compiled.composition.ok, true, JSON.stringify(compiled.composition.diagnostics));
  const track = specs(compiled.html)["inner"]!.a[0]!;
  assert.equal(track.d, 1500, "1s do clip + 0,5s de at, escopo 0");
});

test("clip dentro de sub-composição: escopo é o início do host", async () => {
  const entryHtml = wrap(`
    <div data-composition-id="host" data-clip-id="host" data-start="2" data-duration="3">
      <div data-composition-id="host-root" data-duration="3">
        <div id="c" data-clip-id="c" data-start="1" data-duration="2" data-enter="surgir"></div>
      </div>
    </div>`);
  const compiled = await compileComposition({ entryHtml, entryDir: "." });
  assert.equal(compiled.composition.ok, true, JSON.stringify(compiled.composition.diagnostics));
  const spec = specs(compiled.html)["c"];
  assert.ok(spec, "alvo anotado");
  // início absoluto 3s; escopo do clip (data-ff-comp-start) = início do host = 2000 ms.
  assert.equal(spec.a[0]!.d, 1000);
});

test("entrada antes de 0 vira atraso negativo", async () => {
  const entryHtml = wrap(`<div id="n" data-clip-id="n" data-start="0" data-duration="3" data-enter="surgir at=-0.2"></div>`);
  const compiled = await compileComposition({ entryHtml, entryDir: "." });
  assert.equal(compiled.composition.ok, true, JSON.stringify(compiled.composition.diagnostics));
  assert.equal(specs(compiled.html)["n"]!.a[0]!.d, -200);
});

test("sem atributos de motion o resultado é idêntico ao de antes", async () => {
  const entryHtml = wrap(`<div data-clip-id="a" data-start="0" data-duration="3"></div><div data-clip-id="b" data-start="a" data-duration="2"></div>`);
  const compiled = await compileComposition({ entryHtml, entryDir: "." });
  assert.ok(!compiled.html.includes("data-ff-motion"));
  assert.deepEqual(compiled.composition.motion, {});
  const legacy = annotateTiming(compiled.html, compiled.composition);
  assert.equal(legacy.html, compiled.html, "mesmo documento depois de reanotar com o caminho antigo");
});

test("annotateMotion recusa documento que não bate com o contrato", () => {
  const html = wrap(`<div id="a" data-clip-id="a" data-start="0" data-duration="3" data-enter="surgir"></div>`);
  const composition = loadComposition(html);
  assert.equal(composition.ok, true);
  const other = parse(wrap(`<div data-clip-id="a" data-start="0" data-duration="3"></div>`)) as unknown as { childNodes: never[] };
  assert.throws(() => annotateMotion(other, composition), /não bate com o documento/);
});

test("toRuntimeSpec: duração mínima de 1 ms e atraso em 3 casas", () => {
  const spec = toRuntimeSpec(
    { ordinal: 0, tag: "div", tracks: [{ prop: "opacity", start: 0.0004, duration: 0.0001, keys: [{ offset: 0, value: 0, easing: "linear" }, { offset: 1, value: 1, easing: null }] }] },
    1.23456,
    1000,
  );
  assert.equal(spec.a[0]!.n, 1);
  assert.equal(spec.a[0]!.d, 234.96);
});

test("dividir clip com motion é recusado com E_SPLIT_UNSUPPORTED", () => {
  const source = wrap(`<div data-clip-id="t" data-start="1" data-duration="4" data-enter="surgir"></div>`);
  assert.throws(
    () => splitClip(source, { clipId: "t", at: 3, newId: "t-2" }),
    (error: unknown) => error instanceof EditError && error.code === "E_SPLIT_UNSUPPORTED" && /motion/.test(error.message),
  );
  const plain = source.replace(' data-enter="surgir"', "");
  assert.doesNotThrow(() => splitClip(plain, { clipId: "t", at: 3, newId: "t-2" }));
});

test("E_MOTION_RUNTIME é um código de render publicado", () => {
  assert.ok(RENDER_ERROR_CODES.includes("E_MOTION_RUNTIME"));
  const payload = toErrorPayload({ code: "E_MOTION_RUNTIME", stage: "capture", message: "x" });
  assert.equal(payload.code, "E_MOTION_RUNTIME");
});
