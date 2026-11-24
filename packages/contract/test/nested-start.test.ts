// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-73: `data-start` aninhado num clip comum não vira clip (§7b.2) e precisa avisar em vez de sumir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODES, loadComposition } from "../src/index.ts";
import type { Composition } from "../src/index.ts";

const root = (inner: string): string =>
  `<html><body><div data-composition-id="main" data-root="true" data-width="1080" data-height="1920" data-fps="30" data-duration="4">${inner}</div></body></html>`;

// Código literal de propósito: os testes negativos não podem passar só porque a constante não existe.
const nested = (c: Composition) => c.diagnostics.filter((d) => d.code === "W_NESTED_START_IGNORED");

// Trecho do vertical-chart antes do EDT-56 (d069bb9^): as barras tinham data-start dentro do clip `plot`.
const VERTICAL_CHART_ANTIGO = `
  <div class="plot" data-clip-id="plot" data-start="0.12" data-duration="3.88">
    <div class="bars">
      <div class="col"><div class="bar" data-clip-id="bar-q1" data-start="0.15" data-duration="3.85"><span class="value">42%</span></div></div>
      <div class="col"><div class="bar" data-clip-id="bar-q2" data-start="0.27" data-duration="3.73"><span class="value">67%</span></div></div>
      <div class="col"><div class="bar" data-clip-id="bar-q3" data-start="0.39" data-duration="3.61"><span class="value">58%</span></div></div>
      <div class="col"><div class="bar hot" data-clip-id="bar-q4" data-start="0.51" data-duration="3.49"><span class="value">88%</span></div></div>
    </div>
  </div>`;

test("W_NESTED_START_IGNORED: um aviso por barra do vertical-chart antigo, sem bloquear o render", () => {
  const c = loadComposition(root(VERTICAL_CHART_ANTIGO));
  const found = nested(c);
  assert.equal(CODES.NESTED_START_IGNORED, "W_NESTED_START_IGNORED");
  assert.equal(found.length, 4, "um aviso por elemento");
  for (const d of found) {
    assert.equal(d.severity, "warning");
    assert.equal(d.clipId, "plot", "o clip dono, não a barra");
    assert.ok((d.hint ?? "").length > 0, "hint acionável");
  }
  assert.equal(
    found[0]!.message,
    'data-start="0.15" em <div data-clip-id="bar-q1"> dentro do clip "plot" é ignorado: ele não vira clip e o motion dele usa o início do clip dono',
  );
  assert.deepEqual(
    found.map((d) => /data-clip-id="([^"]+)"/.exec(d.message)?.[1]),
    ["bar-q1", "bar-q2", "bar-q3", "bar-q4"],
  );
  assert.match(found[0]!.hint ?? "", /delay/);
  assert.match(found[0]!.hint ?? "", /sub-composição/);
  // Só avisa: nenhum erro, e a barra continua sem virar clip.
  assert.equal(c.diagnostics.filter((d) => d.severity === "error").length, 0);
  assert.deepEqual(c.clips.map((clip) => clip.id), ["plot"]);
});

test("data-start sem data-clip-id e em template também avisa; o rótulo cai para a tag", () => {
  const c = loadComposition(
    root(`<div data-clip-id="box" data-start="0" data-duration="3"><p data-start="1">oi</p><template><b data-start="2">x</b></template></div>`),
  );
  const found = nested(c);
  assert.equal(found.length, 2);
  assert.ok(found[0]!.message.startsWith('data-start="1" em <p> dentro do clip "box"'));
  assert.ok(found[1]!.message.startsWith('data-start="2" em <b> dentro do clip "box"'));
});

test("o mesmo data-start dentro de um host de sub-composição é clip do escopo: nenhum aviso", () => {
  const c = loadComposition(
    root(`
      <div data-clip-id="host" data-start="0" data-duration="4" data-composition-id="cena">
        <div class="bar" data-clip-id="bar-q1" data-start="0.15" data-duration="3.85"></div>
        <div class="bar" data-clip-id="bar-q2" data-start="0.27" data-duration="3.73"></div>
      </div>`),
  );
  assert.deepEqual(nested(c), []);
  assert.equal(c.diagnostics.filter((d) => d.severity === "error").length, 0);

  // Controle: as mesmas barras num clip comum (sem data-composition-id) avisam, então a ausência acima é mérito do host.
  const comum = loadComposition(
    root(`
      <div data-clip-id="host" data-start="0" data-duration="4">
        <div class="bar" data-clip-id="bar-q1" data-start="0.15" data-duration="3.85"></div>
        <div class="bar" data-clip-id="bar-q2" data-start="0.27" data-duration="3.73"></div>
      </div>`),
  );
  assert.equal(nested(comum).length, 2);
});

test("host aninhado num clip comum: o data-start dele avisa, mas o conteúdo do host não é atravessado", () => {
  const c = loadComposition(
    root(`
      <div data-clip-id="plot" data-start="0" data-duration="4">
        <div data-composition-id="cena" data-start="1">
          <div data-clip-id="interno" data-start="0.5" data-duration="1"></div>
        </div>
      </div>`),
  );
  const found = nested(c);
  assert.equal(found.length, 1, "o interno do host não conta");
  assert.ok(found[0]!.message.includes("<div>"), found[0]!.message);
  assert.equal(found[0]!.clipId, "plot");
});

test("clip comum com descendente só com data-enter (sem data-start): nenhum aviso", () => {
  const c = loadComposition(
    root(`
      <div data-clip-id="plot" data-start="0" data-duration="4">
        <div class="bar" data-enter="fade" ><span data-exit="fade" data-keyframes='[{"time":0,"opacity":0},{"time":1,"opacity":1}]'>42%</span></div>
        <img src="x.png" alt="">
        <audio src="x.wav"></audio>
      </div>`),
  );
  assert.deepEqual(nested(c), []);

  // Controle: o mesmo descendente com data-start avisa; é o atributo que decide, não o motion nem a mídia.
  const comStart = loadComposition(
    root(`<div data-clip-id="plot" data-start="0" data-duration="4"><div class="bar" data-start="0.2" data-enter="fade"></div></div>`),
  );
  assert.equal(nested(comStart).length, 1);
});
