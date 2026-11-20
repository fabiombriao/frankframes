import { test } from "node:test";
import assert from "node:assert/strict";
import { CODES, frameOfTime, loadComposition, timeOfFrame } from "../src/index.ts";

const root = (inner: string, attrs = ""): string =>
  `<html><body><div data-composition-id="main" data-root="true" ${attrs}>${inner}</div></body></html>`;

test("clips absolutos: duração derivada do maior fim", () => {
  const c = loadComposition(
    root(`
      <div data-clip-id="a" data-start="0" data-duration="2" class="clip"></div>
      <div data-clip-id="b" data-start="1.5" data-duration="1" class="clip"></div>
    `),
  );
  assert.equal(c.ok, true);
  assert.deepEqual(c.duration, { kind: "derived", seconds: 2.5 });
  assert.deepEqual(
    c.clips.map((x) => [x.id, x.start, x.end]),
    [
      ["a", 0, 2],
      ["b", 1.5, 2.5],
    ],
  );
});

test("referência aponta para o FIM do alvo, não para o início", () => {
  const c = loadComposition(
    root(`
      <div data-clip-id="a" data-start="1" data-duration="2" class="clip"></div>
      <div data-clip-id="b" data-start="a" data-duration="1" class="clip"></div>
      <div data-clip-id="c" data-start="a + 0.5" data-duration="1" class="clip"></div>
      <div data-clip-id="d" data-start="a-0.25" data-duration="1" class="clip"></div>
    `),
  );
  assert.equal(c.ok, true);
  const start = Object.fromEntries(c.clips.map((x) => [x.id, x.start]));
  assert.equal(start.a, 1);
  assert.equal(start.b, 3);
  assert.equal(start.c, 3.5);
  assert.equal(start.d, 2.75);
});

test("ciclo em data-start falha com E_REF_CYCLE", () => {
  const c = loadComposition(
    root(`
      <div data-clip-id="a" data-start="b" data-duration="1" class="clip"></div>
      <div data-clip-id="b" data-start="a" data-duration="1" class="clip"></div>
    `),
  );
  assert.equal(c.ok, false);
  assert.ok(c.diagnostics.some((d) => d.code === CODES.REF_CYCLE));
});

test("referência a alvo sem duração falha em vez de adivinhar", () => {
  const c = loadComposition(
    root(`
      <video data-clip-id="v" data-start="0" src="a.mp4"></video>
      <div data-clip-id="x" data-start="v" data-duration="1" class="clip"></div>
    `),
  );
  assert.equal(c.ok, false);
  assert.ok(c.diagnostics.some((d) => d.code === CODES.REF_UNRESOLVED));
});

test("mídia sem duração deixa a composição pendente e nomeia o que falta", () => {
  const html = root(`<video data-clip-id="v" data-start="0" src="a.mp4"></video>`);
  const c = loadComposition(html);
  assert.equal(c.ok, false);
  assert.deepEqual(c.duration, { kind: "unresolved", reason: "pending-clips", pending: ["v"] });
  assert.ok(c.diagnostics.some((d) => d.code === CODES.DURATION_UNRESOLVED));

  const measured = loadComposition(html, { mediaDurations: { v: 4.2 } });
  assert.equal(measured.ok, true);
  assert.deepEqual(measured.duration, { kind: "derived", seconds: 4.2 });
});

test("duração autoral da raiz vence a derivação", () => {
  const c = loadComposition(root(`<div data-clip-id="a" data-start="0" data-duration="1" class="clip"></div>`, 'data-duration="10"'));
  assert.deepEqual(c.duration, { kind: "authored", seconds: 10 });
});

test("sub-composição inline não vaza clips internos para a raiz", () => {
  const c = loadComposition(
    root(`
      <div data-composition-id="card" data-start="0">
        <template id="card-template">
          <div data-composition-id="card-inner" data-duration="2">
            <div data-clip-id="inner-1" data-start="0" data-duration="1" class="clip"></div>
          </div>
        </template>
      </div>
    `),
  );
  assert.equal(c.ok, true);
  assert.deepEqual(c.clips.map((x) => x.id), ["card"]);
  assert.equal(c.clips[0]!.isSubComposition, true);
  assert.equal(c.clips[0]!.authoredDuration, 2);
  assert.deepEqual(c.clips[0]!.children.map((x) => x.id), ["inner-1"]);
  assert.deepEqual(c.duration, { kind: "derived", seconds: 2 });
});

test("wrapper sem tempo é atravessado; track sem duration não é clip", () => {
  const c = loadComposition(
    root(`
      <section class="wrap">
        <div data-track="2"><div data-clip-id="deep" data-start="0" data-duration="1" class="clip"></div></div>
      </section>
    `),
  );
  assert.deepEqual(c.clips.map((x) => x.id), ["deep"]);
});

test("data-start inválido e id duplicado são erros, não fallbacks", () => {
  const invalidStart = loadComposition(root(`<div data-clip-id="a" data-start="2,5s" data-duration="1"></div>`));
  assert.equal(invalidStart.ok, false);
  assert.ok(invalidStart.diagnostics.some((d) => d.code === CODES.START_INVALID));

  // Um identificador válido inexistente é referência quebrada, não número inválido.
  const unknownRef = loadComposition(root(`<div data-clip-id="a" data-start="ontem" data-duration="1"></div>`));
  assert.ok(unknownRef.diagnostics.some((d) => d.code === CODES.REF_UNKNOWN));

  const dup = loadComposition(
    root(`
      <div data-clip-id="x" data-start="0" data-duration="1"></div>
      <div data-clip-id="x" data-start="1" data-duration="1"></div>
    `),
  );
  assert.equal(dup.ok, false);
  assert.ok(dup.diagnostics.some((d) => d.code === CODES.DUPLICATE_ID));
});

test("data-offset negativo é erro e rate fora de faixa é aviso com clamp", () => {
  const c = loadComposition(
    root(`
      <div data-clip-id="a" data-start="0" data-duration="1" data-offset="-2" data-playback-rate="50"></div>
    `),
  );
  assert.ok(c.diagnostics.some((d) => d.code === CODES.OFFSET_INVALID && d.severity === "error"));
  const rate = c.diagnostics.find((d) => d.code === CODES.RATE_CLAMPED);
  assert.equal(rate?.severity, "warning");
  assert.equal(c.clips[0]!.playbackRate, 10);
});

test("fps racional exato e grade de frames sem erro de float", () => {
  const c = loadComposition(root(`<div data-clip-id="a" data-start="0" data-duration="1"></div>`, 'data-fps="30000/1001"'));
  assert.deepEqual(c.fps, { num: 30000, den: 1001 });

  const fps = { num: 30, den: 1 };
  assert.equal(timeOfFrame(90, fps), 3.000000001);
  assert.equal(frameOfTime(3, fps), 90);
  assert.equal(frameOfTime(timeOfFrame(89, fps), fps), 89);

  const ntsc = { num: 30000, den: 1001 };
  for (const f of [0, 1, 29, 30, 299, 1000]) assert.equal(frameOfTime(timeOfFrame(f, ntsc), ntsc), f);

  const bad = loadComposition(root("", 'data-fps="29.97"'));
  assert.equal(bad.ok, false);
  assert.ok(bad.diagnostics.some((d) => d.code === CODES.FPS_INVALID));
});

test("sem raiz: E_NO_ROOT", () => {
  const c = loadComposition("<html><body><div></div></body></html>");
  assert.equal(c.ok, false);
  assert.equal(c.diagnostics[0]!.code, CODES.NO_ROOT);
});
