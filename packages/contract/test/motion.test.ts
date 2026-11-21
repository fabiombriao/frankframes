// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "parse5";
import { CODES, evaluateCurve, loadComposition, mergeSegments, motionElements, parseCurve, parseMotionValue } from "../src/index.ts";
import type { Composition } from "../src/index.ts";

const SUAVE = "cubic-bezier(0.34, 0.1, 0.18, 1)";

const root = (inner: string, attrs = ""): string =>
  `<html><body><div data-composition-id="main" data-root="true" ${attrs}>${inner}</div></body></html>`;

/** Um clip `c` de 5 s com os atributos de motion dados. */
const clip = (attrs: string, duration = 5, tag = "div"): Composition =>
  loadComposition(root(`<${tag} data-clip-id="c" data-start="0" data-duration="${duration}" ${attrs}></${tag}>`));

const codes = (c: Composition): string[] => c.diagnostics.map((d) => d.code);

function trackOf(c: Composition, prop: string) {
  const track = c.motion["c"]?.[0]?.tracks.find((t) => t.prop === prop);
  assert.ok(track, `faltou a trilha ${prop}: ${JSON.stringify(c.motion)} ${JSON.stringify(c.diagnostics)}`);
  return track;
}

test("composição sem motion: mapa vazio e nenhum diagnóstico novo", () => {
  const c = clip("");
  assert.equal(c.ok, true);
  assert.deepEqual(c.motion, {});
  assert.deepEqual(c.diagnostics, []);
});

test("surgir: opacidade 0→1 em 0,5 s com a curva suave", () => {
  const c = clip('data-enter="surgir"');
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const track = trackOf(c, "opacity");
  assert.equal(track.start, 0);
  assert.equal(track.duration, 0.5);
  assert.deepEqual(track.keys, [
    { offset: 0, value: 0, easing: SUAVE },
    { offset: 1, value: 1, easing: null },
  ]);
});

test("surgir com dur, at e curve explícitos", () => {
  const c = clip('data-enter="surgir dur=0.8 at=0.2 curve=linear"');
  const track = trackOf(c, "opacity");
  assert.equal(track.start, 0.2);
  assert.equal(track.duration, 0.8);
  assert.equal(track.keys[0]!.easing, "linear");
});

test("entrada pode começar antes de 0; saída e ênfase não", () => {
  assert.equal(trackOf(clip('data-enter="surgir at=-0.2"'), "opacity").start, -0.2);
  const bad = clip('data-exit="apagar at=-1"');
  assert.equal(bad.ok, false);
  assert.ok(codes(bad).includes("E_MOTION_PARAM"));
});

test("apagar: o fim é a âncora; padrão end", () => {
  const track = trackOf(clip('data-exit="apagar"'), "opacity");
  assert.equal(track.start, 4.5);
  assert.equal(track.duration, 0.5);
  assert.deepEqual(
    track.keys.map((k) => k.value),
    [1, 0],
  );
  assert.equal(trackOf(clip('data-exit="apagar at=end-1"'), "opacity").start, 3.5);
});

test("âncora em porcentagem usa a duração do clip", () => {
  assert.equal(trackOf(clip('data-enter="surgir at=50%"', 4), "opacity").start, 2);
});

test("pulsar: escala X e Y com ciclos e amount", () => {
  const c = clip('data-emphasis="pulsar amount=1.2 repeat=2"');
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const sx = trackOf(c, "--ff-sx");
  assert.equal(sx.start, 0);
  assert.equal(sx.duration, 1.2);
  assert.deepEqual(
    sx.keys.map((k) => [k.offset, k.value]),
    [
      [0, 1],
      [0.25, 1.2],
      [0.5, 1],
      [0.75, 1.2],
      [1, 1],
    ],
  );
  assert.deepEqual(trackOf(c, "--ff-sy").keys, sx.keys);
});

test("ênfase começa no fim da entrada do mesmo alvo", () => {
  const c = clip('data-enter="surgir dur=1" data-emphasis="pulsar"');
  assert.equal(trackOf(c, "--ff-sx").start, 1);
});

test("entrada e saída no mesmo alvo viram uma trilha só, parada no meio", () => {
  const c = clip('data-enter="surgir" data-exit="apagar"');
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const track = trackOf(c, "opacity");
  assert.equal(c.motion["c"]![0]!.tracks.filter((t) => t.prop === "opacity").length, 1);
  assert.equal(track.start, 0);
  assert.equal(track.duration, 5);
  assert.deepEqual(
    track.keys.map((k) => [k.offset, k.value]),
    [
      [0, 0],
      [0.1, 1],
      [0.9, 1],
      [1, 0],
    ],
  );
  assert.equal(track.keys[1]!.easing, null, "trecho parado é linear");
  assert.equal(track.keys[2]!.easing, SUAVE);
});

test("movimentos da mesma propriedade que se sobrepõem: E_MOTION_OVERLAP; encostar é permitido", () => {
  const over = clip('data-enter="surgir dur=1" data-exit="apagar at=1.5 dur=1"', 2);
  assert.equal(over.ok, false);
  assert.ok(codes(over).includes("E_MOTION_OVERLAP"));
  const touch = clip('data-enter="surgir dur=1" data-exit="apagar at=2 dur=1"', 2);
  assert.equal(touch.ok, true, JSON.stringify(touch.diagnostics));
});

test("fora da duração do clip: E_MOTION_OUT_OF_RANGE com a faixa no hint", () => {
  for (const attrs of ['data-enter="surgir dur=6"', 'data-exit="apagar dur=6"', 'data-enter="surgir at=4.8"']) {
    const c = clip(attrs);
    assert.equal(c.ok, false, attrs);
    const d = c.diagnostics.find((x) => x.code === "E_MOTION_OUT_OF_RANGE");
    assert.ok(d, attrs);
    assert.equal(d.clipId, "c");
    assert.match(d.hint ?? "", /5/);
  }
});

test("duração do clip desconhecida: composição não resolvida não gera erro de motion", () => {
  const c = loadComposition(root('<div data-clip-id="c" data-start="0" data-exit="apagar"></div>'));
  assert.ok(codes(c).includes("E_DURATION_UNRESOLVED"));
  assert.ok(!codes(c).some((code) => code.startsWith("E_MOTION")), JSON.stringify(c.diagnostics));
});

test("raiz com duração mas clip sem fim: o que depende de D vira E_MOTION_OUT_OF_RANGE", () => {
  const c = loadComposition(root('<div data-clip-id="c" data-start="0" data-exit="apagar"></div>', 'data-duration="5"'));
  const d = c.diagnostics.find((x) => x.code === "E_MOTION_OUT_OF_RANGE");
  assert.ok(d, JSON.stringify(c.diagnostics));
  assert.match(d.hint ?? "", /data-duration/);
});

test("sintaxe: valor vazio, token sem '=' e chave repetida", () => {
  for (const attrs of ['data-enter=""', 'data-enter="surgir dur"', 'data-enter="surgir dur=1 dur=2"', 'data-enter="Surgir"']) {
    const c = clip(attrs);
    assert.equal(c.ok, false, attrs);
    const d = c.diagnostics.find((x) => x.code === "E_MOTION_SYNTAX");
    assert.ok(d, attrs);
    assert.ok(d.hint, attrs);
    assert.equal(d.clipId, "c");
  }
});

test("preset inexistente para o atributo lista os válidos", () => {
  for (const attrs of ['data-enter="voar"', 'data-enter="apagar"', 'data-exit="surgir"', 'data-camera="surgir"', 'data-transition="surgir"']) {
    const c = clip(attrs, 5, attrs.startsWith("data-camera") ? "img" : "div");
    assert.equal(c.ok, false, attrs);
    const d = c.diagnostics.find((x) => x.code === "E_MOTION_PRESET_UNKNOWN");
    assert.ok(d, `${attrs}: ${JSON.stringify(c.diagnostics)}`);
    assert.ok(d.hint, attrs);
  }
  const enter = clip('data-enter="voar"').diagnostics.find((x) => x.code === "E_MOTION_PRESET_UNKNOWN")!;
  assert.match(enter.hint!, /surgir/);
});

test("parâmetros: chave desconhecida, dur<=0 e fora da faixa do preset", () => {
  for (const attrs of [
    'data-enter="surgir foo=1"',
    'data-enter="surgir dur=-1"',
    'data-enter="surgir dur=0"',
    'data-enter="surgir at=xyz"',
    'data-emphasis="pulsar amount=9"',
    'data-emphasis="pulsar repeat=0"',
    'data-emphasis="pulsar repeat=1.5"',
  ]) {
    const c = clip(attrs);
    assert.equal(c.ok, false, attrs);
    const d = c.diagnostics.find((x) => x.code === "E_MOTION_PARAM");
    assert.ok(d, `${attrs}: ${JSON.stringify(c.diagnostics)}`);
    assert.ok(d.hint, attrs);
  }
});

test("curvas inválidas: E_CURVE_INVALID", () => {
  for (const curve of ["mola", "cubic-bezier(2,0,0.5,1)", "cubic-bezier(0.3,0,0.2,9)", "cubic-bezier(0.3, 0, 0.2, 1)", "xyz"]) {
    const c = clip(`data-enter="surgir curve=${curve}"`);
    assert.equal(c.ok, false, curve);
    assert.ok(codes(c).includes("E_CURVE_INVALID") || codes(c).includes("E_MOTION_SYNTAX"), curve);
  }
  const bezier = clip('data-enter="surgir curve=cubic-bezier(2,0,0.5,1)"');
  assert.ok(codes(bezier).includes("E_CURVE_INVALID"));
  assert.ok(bezier.diagnostics.find((d) => d.code === "E_CURVE_INVALID")!.hint);
  assert.equal(clip('data-enter="surgir curve=cubic-bezier(0.3,0,0.2,1)"').ok, true);
  assert.equal(clip('data-enter="surgir curve=vaivem"').ok, true);
});

test("alvos inválidos: E_MOTION_TARGET", () => {
  const cases: Array<[string, string]> = [
    ["raiz", `<html><body><div data-composition-id="main" data-root="true" data-enter="surgir"><div data-start="0" data-duration="2"></div></div></body></html>`],
    ["fora de clip", root('<section data-enter="surgir"></section><div data-start="0" data-duration="2"></div>')],
    ["áudio", root('<audio src="a.mp3" data-start="0" data-duration="2" data-enter="surgir"></audio>')],
    ["vídeo", root('<video src="a.mp4" data-start="0" data-duration="2" data-enter="surgir"></video>')],
    ["câmera em div", root('<div data-start="0" data-duration="2" data-camera="x"></div>')],
    ["transição em descendente", root('<div data-start="0" data-duration="2"><p data-transition="x"></p></div>')],
  ];
  for (const [name, html] of cases) {
    const c = loadComposition(html);
    assert.equal(c.ok, false, name);
    const d = c.diagnostics.find((x) => x.code === "E_MOTION_TARGET");
    assert.ok(d, `${name}: ${JSON.stringify(c.diagnostics)}`);
    assert.ok(d.hint, name);
  }
});

test("descendente: o tempo é relativo ao clip dono; clip e descendentes na ordem do documento", () => {
  const c = loadComposition(
    root(`
      <div data-clip-id="c" data-start="2" data-duration="4" data-enter="surgir">
        <h1 data-enter="surgir dur=1">a</h1>
        <div><p data-exit="apagar">b</p></div>
        <span>sem motion</span>
      </div>`),
  );
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const targets = c.motion["c"]!;
  assert.deepEqual(
    targets.map((t) => t.ordinal),
    [0, 1, 2],
  );
  assert.deepEqual(
    targets.map((t) => t.tag),
    ["div", "h1", "p"],
  );
  assert.equal(targets[1]!.tracks[0]!.duration, 1);
  assert.equal(targets[2]!.tracks[0]!.start, 3.5, "saída relativa ao clip (4 s), não à composição");
});

test("elemento temporizado dentro de clip comum não é clip: o motion pertence ao clip de fora", () => {
  const c = loadComposition(
    root(`
      <div data-clip-id="a" data-start="0" data-duration="4">
        <div data-start="1" data-duration="2" data-enter="surgir"></div>
      </div>`),
  );
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.equal(c.motion["a"]?.length, 1);
  assert.equal(c.motion["a"]?.[0]?.ordinal, 0);
});

test("host de sub-composição: clips filhos têm o próprio motion", () => {
  const c = loadComposition(
    root(`
      <div data-clip-id="h" data-composition-id="sub" data-start="0" data-duration="4">
        <div data-clip-id="b" data-start="1" data-duration="2" data-enter="surgir"></div>
      </div>`),
  );
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.ok(c.motion["b"]);
  assert.equal(c.motion["h"], undefined);
});

test("motionElements devolve os elementos na ordem canônica", () => {
  interface N {
    nodeName: string;
    attrs?: Array<{ name: string; value: string }>;
    childNodes?: N[];
  }
  const document = parse(
    '<div id="r"><div data-composition-id="h" data-start="0" data-enter="x" id="clip"><i data-exit="y" id="i"></i><b><u data-emphasis="z" id="u"></u></b><div data-start="1" data-enter="x" id="inner"><s data-enter="x" id="s"></s></div></div></div>',
  ) as unknown as N;
  const find = (node: N, id: string): N | undefined => {
    if (node.attrs?.some((a) => a.name === "id" && a.value === id)) return node;
    for (const child of node.childNodes ?? []) {
      const hit = find(child, id);
      if (hit) return hit;
    }
    return undefined;
  };
  const ids = motionElements(find(document, "clip")!).map((n) => n.attrs?.find((a) => a.name === "id")?.value);
  assert.deepEqual(ids, ["clip", "i", "u"], "num host, não atravessa clip temporizado interno");
  const plain = parse(
    '<div id="c" data-start="0" data-enter="x"><div data-start="1" data-enter="x" id="inner"></div></div>',
  ) as unknown as N;
  assert.equal(motionElements(find(plain, "c")!).length, 2, "clip comum: tudo é descendente");
});

test("conflito de posse: propriedade possuída declarada no style inline", () => {
  const bad = clip('data-emphasis="pulsar" style="scale: 2"');
  assert.equal(bad.ok, false);
  assert.ok(codes(bad).includes("E_MOTION_CONFLICT"));
  assert.ok(bad.diagnostics.find((d) => d.code === "E_MOTION_CONFLICT")!.hint);
  // opacity inline é permitida; transform do autor também.
  assert.equal(clip('data-enter="surgir" style="opacity:0"').ok, true);
  assert.equal(clip('data-emphasis="pulsar" style="transform: rotate(3deg)"').ok, true);
});

test("curvas: nomes, bezier e avaliação determinística", () => {
  assert.equal(parseCurve("linear")?.css, "linear");
  assert.equal(parseCurve("ease-in-out")?.css, "ease-in-out");
  assert.equal(parseCurve("suave")?.css, SUAVE);
  assert.equal(parseCurve("freio")?.css, "cubic-bezier(0.18, 0.72, 0.28, 1)");
  assert.equal(parseCurve("cubic-bezier(0.3,0,0.2,1)")?.css, "cubic-bezier(0.3, 0, 0.2, 1)");
  assert.equal(parseCurve("mola"), undefined);
  assert.equal(parseCurve("cubic-bezier(0.3,0,0.2)"), undefined);

  assert.equal(evaluateCurve("linear", 0.3), 0.3);
  for (const name of ["ease", "ease-in", "ease-out", "ease-in-out", SUAVE]) {
    assert.equal(evaluateCurve(name, 0), 0, name);
    assert.equal(evaluateCurve(name, 1), 1, name);
    let previous = -1;
    for (let i = 0; i <= 20; i++) {
      const y = evaluateCurve(name, i / 20);
      assert.ok(y >= previous - 1e-12, `${name} não decresce em ${i / 20}`);
      previous = y;
    }
  }
  assert.equal(evaluateCurve(SUAVE, 0.37), evaluateCurve(SUAVE, 0.37), "mesma entrada, mesma saída");
  assert.ok(evaluateCurve("ease-in", 0.5) < 0.5 && evaluateCurve("ease-out", 0.5) > 0.5);
});

test("gramática do valor", () => {
  assert.deepEqual(parseMotionValue("  surgir   dur=0.6 at=end-1 "), { ok: true, preset: "surgir", params: { dur: "0.6", at: "end-1" } });
  assert.equal(parseMotionValue("").ok, false);
  assert.equal(parseMotionValue("surgir dur").ok, false);
  assert.equal(parseMotionValue("surgir a=1 a=2").ok, false);
  assert.equal(parseMotionValue("surgir =1").ok, false);
});

test("mergeSegments: salto entre o valor parado e o início do próximo vira chave dupla + aviso", () => {
  const seg = (start: number, from: number, to: number) => ({
    start,
    duration: 1,
    keys: [
      { offset: 0, value: from, easing: "linear" as string | null },
      { offset: 1, value: to, easing: null },
    ],
  });
  const merged = mergeSegments("opacity", [seg(0, 0, 1), seg(2, 0.5, 0)]);
  assert.ok(merged.ok);
  assert.deepEqual(merged.jumps, [2]);
  assert.equal(merged.track.start, 0);
  assert.equal(merged.track.duration, 3);
  const at2 = merged.track.keys.filter((k) => Math.abs(k.offset - 2 / 3) < 1e-6);
  assert.deepEqual(
    at2.map((k) => k.value),
    [1, 0.5],
    "o valor parado fecha antes do salto",
  );

  const overlap = mergeSegments("opacity", [seg(0, 0, 1), seg(0.5, 1, 0)]);
  assert.equal(overlap.ok, false);
});

test("códigos de motion estão no contrato", () => {
  assert.equal(CODES.MOTION_JUMP, "W_MOTION_JUMP");
  assert.equal(CODES.MOTION_SYNTAX, "E_MOTION_SYNTAX");
  assert.equal(CODES.CURVE_INVALID, "E_CURVE_INVALID");
});
