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

test("fades de áudio são lidos e valores negativos falham", () => {
  const ok = loadComposition(root(`<audio data-clip-id="a" data-start="0" data-duration="2" data-fade-in="0.5" data-fade-out="0.75" src="a.wav"></audio>`));
  assert.equal(ok.ok, true);
  assert.equal(ok.clips[0]!.fadeIn, 0.5);
  assert.equal(ok.clips[0]!.fadeOut, 0.75);

  const bad = loadComposition(root(`<div data-clip-id="b" data-start="0" data-duration="1" data-fade-in="-1"></div>`));
  assert.equal(bad.ok, false);
  assert.ok(bad.diagnostics.some((d) => d.code === CODES.FADE_INVALID && d.severity === "error"));
});

test("<img> não tem áudio; clip interno sem duração deixa a composição pendente", () => {
  const img = loadComposition(root(`<img data-clip-id="p" data-start="0" data-duration="1" src="a.png">`));
  assert.equal(img.ok, true);
  assert.equal(img.clips[0]!.hasAudio, false, "img nunca entra no mixer");

  const nested = loadComposition(
    root(`
      <div data-composition-id="a" data-start="0" data-duration="2">
        <div data-clip-id="child" data-start="0"></div>
      </div>
    `),
  );
  assert.equal(nested.ok, false, "filho de sub-composição sem duração precisa bloquear");
  assert.deepEqual(nested.duration, { kind: "unresolved", reason: "pending-clips", pending: ["child"] });
});

test("ids gerados não colidem entre sub-composições irmãs", () => {
  const c = loadComposition(
    root(`
      <div data-composition-id="a" data-start="0" data-duration="2"><div data-start="0" data-duration="1"></div></div>
      <div data-composition-id="b" data-start="2" data-duration="2"><div data-start="0" data-duration="1"></div></div>
    `),
  );
  assert.equal(c.ok, true);
  assert.ok(!c.diagnostics.some((d) => d.code === CODES.DUPLICATE_ID));
  const ids = [c.clips[0]!.children[0]!.id, c.clips[1]!.children[0]!.id];
  assert.notEqual(ids[0], ids[1]);
});

test("atributo numérico inválido é erro, não fallback", () => {
  for (const attr of ['data-volume="50%"', 'data-offset="1,5"', 'data-playback-rate="1.5x"']) {
    const c = loadComposition(root(`<div data-clip-id="x" data-start="0" data-duration="1" ${attr}></div>`));
    assert.equal(c.ok, false, `${attr} deveria falhar`);
    assert.ok(c.diagnostics.some((d) => d.code === CODES.NUMBER_INVALID), `${attr} sem E_NUMBER_INVALID`);
  }
});

// ---- EDT-75: data-start com id hifenizado ----

test("id hifenizado: clip-1 é o fim do clip clip-1, não clip − 1", () => {
  const c = loadComposition(
    root(`
      <div data-clip-id="clip-1" data-start="0" data-duration="2"></div>
      <div data-clip-id="b" data-start="clip-1" data-duration="1"></div>
      <div data-clip-id="c" data-start="clip-1 + 0.5" data-duration="1"></div>
      <div data-clip-id="d" data-start="clip-1-0.5" data-duration="1"></div>
    `),
  );
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const byId = new Map(c.clips.map((x) => [x.id, x]));
  assert.equal(byId.get("b")!.start, 2);
  assert.deepEqual(byId.get("b")!.startExpr, { kind: "reference", refId: "clip-1", offset: 0 });
  assert.equal(byId.get("c")!.start, 2.5);
  // `clip-1-0.5` não é id existente: vale `clip-1` − 0,5.
  assert.equal(byId.get("d")!.start, 1.5);
  assert.deepEqual(byId.get("d")!.startExpr, { kind: "reference", refId: "clip-1", offset: -0.5 });
});

test("sem clip com o id inteiro, id-n continua sendo o fim de id menos n", () => {
  const c = loadComposition(
    root(`
      <div data-clip-id="a" data-start="0" data-duration="2"></div>
      <div data-clip-id="b" data-start="a-0.25" data-duration="1"></div>
    `),
  );
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.equal(c.clips.find((x) => x.id === "b")!.start, 1.75);
});

test("clip e clip-1 existindo: clip-1 é o fim de clip-1 (id exato vence)", () => {
  const c = loadComposition(
    root(`
      <div data-clip-id="clip" data-start="0" data-duration="5"></div>
      <div data-clip-id="clip-1" data-start="0" data-duration="2"></div>
      <div data-clip-id="b" data-start="clip-1" data-duration="1"></div>
    `),
  );
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.equal(c.clips.find((x) => x.id === "b")!.start, 2);
});

test("id hifenizado dentro de sub-composição também resolve pelo id exato", () => {
  const c = loadComposition(
    root(`
      <div data-clip-id="host" data-composition-id="card" data-start="0" data-duration="4">
        <div data-clip-id="clip-1" data-start="0" data-duration="1"></div>
        <div data-clip-id="clip-2" data-start="clip-1" data-duration="1"></div>
      </div>
    `),
  );
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const inner = c.clips[0]!.children.find((x) => x.id === "clip-2")!;
  assert.equal(inner.start, 1);
});

test("id hifenizado inexistente continua sendo E_REF_UNKNOWN", () => {
  const c = loadComposition(root(`<div data-clip-id="a" data-start="clip-9" data-duration="1"></div>`));
  assert.equal(c.ok, false);
  const unknown = c.diagnostics.find((d) => d.code === CODES.REF_UNKNOWN);
  assert.ok(unknown);
  assert.match(unknown.message, /"clip-9"/, "cita o valor inteiro, não o id da leitura id − n");
  assert.match(unknown.hint ?? "", /nenhum clip "clip-9" nem "clip"; para deslocar, use espaços: "clip - 9"/);
});

// EDT-84: data-duration da raiz corta; clip de topo que passa do fim autoral avisa em vez de sumir calado.
test("clip de topo além do fim autoral gera W_CLIP_PAST_END com o id e os dois instantes", () => {
  const c = loadComposition(
    root(
      `
      <div data-clip-id="curto" data-start="0" data-duration="2" class="clip"></div>
      <div data-clip-id="longo" data-start="1" data-duration="67" class="clip"></div>
    `,
      'data-duration="4"',
    ),
  );
  assert.deepEqual(c.duration, { kind: "authored", seconds: 4 });
  const past = c.diagnostics.filter((d) => d.code === CODES.CLIP_PAST_END);
  assert.equal(past.length, 1, "só o clip que passa do fim avisa");
  const d = past[0]!;
  assert.equal(d.code, "W_CLIP_PAST_END");
  assert.equal(d.severity, "warning");
  assert.equal(d.clipId, "longo");
  assert.match(d.message, /68 s/, "fim do clip");
  assert.match(d.message, /\b4 s/, "fim da composição");
  assert.ok(d.hint, "hint acionável");
  assert.equal(c.ok, true, "aviso não bloqueia o render");
});

test("W_CLIP_PAST_END não dispara no limite, com tolerância de ponto flutuante, sem data-duration nem em clip aninhado", () => {
  const exact = loadComposition(
    root('<div data-clip-id="a" data-start="1" data-duration="3" class="clip"></div>', 'data-duration="4"'),
  );
  assert.equal(exact.diagnostics.some((d) => d.code === CODES.CLIP_PAST_END), false, "fim == fim da composição");

  const noise = loadComposition(
    root('<div data-clip-id="a" data-start="0.1" data-duration="3.9000000001" class="clip"></div>', 'data-duration="4"'),
  );
  assert.equal(noise.diagnostics.some((d) => d.code === CODES.CLIP_PAST_END), false, "folga de 1 µs");

  const derived = loadComposition(root('<div data-clip-id="a" data-start="0" data-duration="68" class="clip"></div>'));
  assert.deepEqual(derived.duration, { kind: "derived", seconds: 68 });
  assert.equal(derived.diagnostics.some((d) => d.code === CODES.CLIP_PAST_END), false, "derivada nunca passa do fim");

  const nested = loadComposition(
    root(
      `<div data-clip-id="host" data-start="0" data-duration="3" class="clip">
         <div data-clip-id="filho" data-start="0" data-duration="30" class="clip"></div>
       </div>`,
      'data-duration="4"',
    ),
  );
  assert.equal(nested.diagnostics.some((d) => d.code === CODES.CLIP_PAST_END), false, "filho de sub-composição fica de fora");
});
