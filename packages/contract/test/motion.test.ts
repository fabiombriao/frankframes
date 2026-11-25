// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "parse5";
import { CODES, emitEasing, evaluateCurve, listPresets, loadComposition, mergeSegments, motionElements, parseCurve, parseMotionValue, resolveCurve, sampleTracks, splitText, springMinSeconds, unitRanks } from "../src/index.ts";
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
  for (const curve of ["molinha", "cubic-bezier(2,0,0.5,1)", "cubic-bezier(0.3,0,0.2,9)", "cubic-bezier(0.3, 0, 0.2, 1)", "xyz"]) {
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
  assert.equal(parseCurve("molinha"), undefined);
  assert.equal(parseCurve("mola")?.css, "spring(0.45, 18)");
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

// ---------- EDT-50: keyframes visuais (§7b.7) e mola ----------

/** Clip `c` de 3 s com `data-keyframes` (JSON). */
const kf = (points: unknown, extra = "", duration = 3): Composition =>
  loadComposition(
    root(
      `<div data-clip-id="c" data-start="0" data-duration="${duration}" ${extra} data-keyframes='${typeof points === "string" ? points : JSON.stringify(points)}'></div>`,
    ),
  );

test("keyframes: só volume continua igual e não gera motion", () => {
  const c = kf([
    { time: 0, volume: 1 },
    { time: 2, volume: 0.2 },
  ]);
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.deepEqual(c.clips[0]?.keyframes, [
    { time: 0, volume: 1 },
    { time: 2, volume: 0.2 },
  ]);
  assert.deepEqual(c.motion, {});
  assert.deepEqual(c.diagnostics, []);
});

test("keyframes: opacidade em dois pontos com curva e x em um ponto (constante)", () => {
  const c = kf([
    { time: 0, opacity: 0, curve: "freio" },
    { time: 1, opacity: 1, x: "10%" },
  ]);
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.equal(c.clips[0]?.keyframes, undefined, "sem volume, clip.keyframes não existe");
  const opacity = trackOf(c, "opacity");
  assert.equal(opacity.keys.length, 2);
  assert.equal(opacity.keys[0]?.easing, "cubic-bezier(0.18, 0.72, 0.28, 1)");
  assert.equal(opacity.keys[1]?.easing, null);
  assert.deepEqual(
    opacity.keys.map((k) => k.value),
    [0, 1],
  );
  const x = trackOf(c, "--ff-x");
  assert.equal(x.keys.length, 1);
  assert.equal(x.keys[0]?.value, "10%");
  assert.equal(x.duration, 0);
});

test("keyframes: trecho por propriedade usa a curva do ponto de partida", () => {
  const c = kf([
    { time: 0, x: 0, opacity: 0 },
    { time: 1, x: 100, curve: "freio" },
    { time: 2, x: 200, opacity: 1 },
  ]);
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const x = trackOf(c, "--ff-x");
  assert.deepEqual(
    x.keys.map((k) => [k.offset, k.value, k.easing]),
    [
      [0, 0, "linear"],
      [0.5, 100, "cubic-bezier(0.18, 0.72, 0.28, 1)"],
      [1, 200, null],
    ],
  );
  // opacity pula o ponto do meio: um trecho 0→2 s com a curva do ponto 0
  const opacity = trackOf(c, "opacity");
  assert.equal(opacity.duration, 2);
  assert.equal(opacity.keys.length, 2);
});

test("keyframes: scale expande para scaleX e scaleY; clip inset normaliza", () => {
  const c = kf([
    { time: 0, scale: 1, clip: "inset(0 100% 0 0)" },
    { time: 1, scale: 2, clip: "inset(0% 0% 0% 0%)" },
  ]);
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.deepEqual(
    trackOf(c, "--ff-sx").keys.map((k) => k.value),
    [1, 2],
  );
  assert.deepEqual(
    trackOf(c, "--ff-sy").keys.map((k) => k.value),
    [1, 2],
  );
  assert.deepEqual(
    trackOf(c, "clip-path").keys.map((k) => k.value),
    ["inset(0% 100% 0% 0%)", "inset(0% 0% 0% 0%)"],
  );
});

test("keyframes: cada tipo de ponto inválido dá E_KEYFRAME_INVALID", () => {
  const cases: Record<string, unknown> = {
    "chave desconhecida": [{ time: 0, brilho: 1 }],
    "opacity fora de faixa": [{ time: 0, opacity: 2 }],
    "blur negativo": [{ time: 0, blur: -1 }],
    "scale junto com scaleX": [{ time: 0, scale: 1, scaleX: 2 }],
    "mesmo time duas vezes": [
      { time: 1, opacity: 0 },
      { time: 1, opacity: 1 },
    ],
    "ponto sem propriedade": [{ time: 0 }],
    "clip inset e circle": [
      { time: 0, clip: "inset(0% 0% 0% 0%)" },
      { time: 1, clip: "circle(50% at 50% 50%)" },
    ],
    "zoom em div": [{ time: 0, zoom: 1.2 }],
    "focusX em div": [{ time: 0, focusX: 0.5 }],
    "x com unidade inválida": [{ time: 0, x: "3em" }],
  };
  for (const [name, points] of Object.entries(cases)) {
    const c = kf(points);
    assert.equal(c.ok, false, name);
    assert.ok(codes(c).includes("E_KEYFRAME_INVALID"), `${name}: ${JSON.stringify(codes(c))}`);
  }
});

test("keyframes: volume em descendente é E_KEYFRAME_INVALID", () => {
  const c = loadComposition(
    root(
      `<div data-clip-id="c" data-start="0" data-duration="3"><span data-keyframes='[{"time":0,"volume":1}]'></span></div>`,
    ),
  );
  assert.equal(c.ok, false);
  assert.ok(codes(c).includes("E_KEYFRAME_INVALID"));
});

test("keyframes: 257 pontos dão E_KEYFRAME_LIMIT, 256 passam", () => {
  const points = (n: number) => Array.from({ length: n }, (_, i) => ({ time: i * 0.01, opacity: i % 2 }));
  const over = kf(points(257), "", 10);
  assert.equal(over.ok, false);
  assert.ok(codes(over).includes("E_KEYFRAME_LIMIT"));
  const at = kf(points(256), "", 10);
  assert.ok(!codes(at).includes("E_KEYFRAME_LIMIT"), JSON.stringify(at.diagnostics));
});

test("keyframes: JSON quebrado mantém E_NUMBER_INVALID", () => {
  const c = kf("[{time:0}]");
  assert.ok(codes(c).includes("E_NUMBER_INVALID"));
  const nonFinite = kf([{ time: "x", opacity: 1 }]);
  assert.ok(codes(nonFinite).includes("E_NUMBER_INVALID"));
});

test("keyframes: ponto além do fim do clip dá W_KEYFRAME_OUT_OF_RANGE", () => {
  const c = kf([
    { time: 0, opacity: 0 },
    { time: 9, opacity: 1 },
  ]);
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const warn = c.diagnostics.find((d) => d.code === "W_KEYFRAME_OUT_OF_RANGE");
  assert.ok(warn, JSON.stringify(c.diagnostics));
  assert.match(warn.hint ?? "", /t=9 s/);
});

test("keyframes: curva em ponto só de volume dá W_KEYFRAME_CURVE_IGNORED", () => {
  const c = kf([{ time: 0, volume: 1, curve: "freio" }]);
  assert.ok(codes(c).includes("W_KEYFRAME_CURVE_IGNORED"), JSON.stringify(c.diagnostics));
});

test("keyframes: opacity junto com data-enter na mesma janela é E_MOTION_OVERLAP", () => {
  const c = kf(
    [
      { time: 0, opacity: 0 },
      { time: 1, opacity: 1 },
    ],
    'data-enter="surgir"',
  );
  assert.equal(c.ok, false);
  assert.ok(codes(c).includes("E_MOTION_OVERLAP"), JSON.stringify(c.diagnostics));
});

test("keyframes: curva desconhecida em ponto vira E_CURVE_INVALID", () => {
  const c = kf([
    { time: 0, opacity: 0, curve: "molinha" },
    { time: 1, opacity: 1 },
  ]);
  assert.equal(c.ok, false);
  assert.ok(codes(c).includes("E_CURVE_INVALID"));
});

test("mola: avaliação, overshoot e monotonia", () => {
  assert.equal(evaluateCurve("mola", 0), 0);
  assert.equal(evaluateCurve("mola", 1), 1);
  let peak = 0;
  for (let i = 0; i <= 200; i++) peak = Math.max(peak, evaluateCurve("spring(0.45,18)", i / 200, 0.8));
  assert.ok(peak > 1.15 && peak < 1.25, `pico ${peak}`);
  // ζ = 1: sem overshoot, monotônica
  let previous = -1;
  for (let i = 0; i <= 100; i++) {
    const v = evaluateCurve("spring(1,18)", i / 100, 1);
    assert.ok(v <= 1 + 1e-9 && v >= previous - 1e-9, `ζ=1 não monotônica em ${i}: ${v}`);
    previous = v;
  }
});

test("mola: emissão linear() com 64 amostras e valor conferido à mão", () => {
  const css = emitEasing(resolveCurve("spring(0.45,18)").curve!, 0.8);
  assert.ok(css !== null && css.startsWith("linear(0, "));
  assert.equal(css.slice("linear(".length, -1).split(", ").length, 64);
  // Conferido à mão: p=1/63 → τ=0,8/63 s; x = 1 − e^(−8,1τ)(cos(ω_d τ) + 0,5039·sen(ω_d τ)), ω_d = 16,0745 → 0,0243.
  assert.equal(
    css,
    "linear(0, 0.0243, 0.09, 0.1862, 0.3028, 0.4305, 0.5613, 0.6883, 0.8064, 0.9116, 1.0015, 1.0745, 1.1305, 1.1699, 1.194, 1.2045, 1.2034, 1.193, 1.1754, 1.1529, 1.1273, 1.1006, 1.074, 1.049, 1.0262, 1.0065, 0.9901, 0.9773, 0.9679, 0.9617, 0.9585, 0.9579, 0.9593, 0.9624, 0.9667, 0.9718, 0.9772, 0.9827, 0.988, 0.9929, 0.9972, 1.0008, 1.0037, 1.0059, 1.0074, 1.0083, 1.0087, 1.0085, 1.008, 1.0072, 1.0062, 1.0051, 1.004, 1.0029, 1.0018, 1.0009, 1.0001, 0.9995, 0.9989, 0.9986, 0.9983, 0.9982, 0.9982, 1)",
  );
});

test("mola: trecho curto demais não assenta e o hint traz a duração mínima (0,59 s)", () => {
  assert.equal(emitEasing(resolveCurve("spring(0.45,18)").curve!, 0.3), null);
  const c = kf([
    { time: 0, x: 0, curve: "mola" },
    { time: 0.3, x: 100 },
  ]);
  assert.equal(c.ok, false);
  const error = c.diagnostics.find((d) => d.code === "E_CURVE_INVALID");
  assert.ok(error, JSON.stringify(c.diagnostics));
  assert.match(error.hint ?? "", /0\.59/);

  const preset = clip('data-enter="surgir dur=0.3 curve=spring(0.45,18)"');
  assert.equal(preset.ok, false);
  assert.match(preset.diagnostics.find((d) => d.code === "E_CURVE_INVALID")?.hint ?? "", /0\.59/);
});

test("mola em preset: surgir dur=1 curve=mola emite linear() na chave", () => {
  const c = clip('data-enter="surgir dur=1 curve=mola"');
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.ok(trackOf(c, "opacity").keys[0]?.easing?.startsWith("linear(0, "));
});

// ---------- EDT-51: 26 presets próprios (docs/motion.md) ----------

const ATTR_OF_KIND = { enter: "data-enter", exit: "data-exit", emphasis: "data-emphasis", camera: "data-camera" } as const;
/** Câmera só vale em img/video: os testes de preset usam <img> para ela. */
const tagOf = (kind: string): string => (kind === "camera" ? "img" : "div");
const NEUTRAL: Record<string, number | string> = {
  opacity: 1,
  "--ff-x": 0,
  "--ff-y": 0,
  "--ff-sx": 1,
  "--ff-sy": 1,
  "--ff-rot": 0,
  "--ff-blur": 0,
  "clip-path": "inset(0% 0% 0% 0%)",
};

test("presets: 12 de entrada, 8 de saída, 6 de ênfase, 5 de câmera, 5 de transição; nomes únicos e ASCII", () => {
  assert.equal(listPresets("enter").length, 12);
  assert.equal(listPresets("exit").length, 8);
  assert.equal(listPresets("emphasis").length, 6);
  assert.equal(listPresets("camera").length, 5);
  assert.equal(listPresets("transition").length, 5);
  assert.equal(listPresets().length, 36);
  const names = listPresets().map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^[a-z][a-z0-9-]*$/);
  for (const preset of listPresets()) assert.ok(preset.label.length > 0, preset.name);
});

test("presets: todos com parâmetros padrão montam trilhas sem diagnóstico", () => {
  // Transição precisa de parceiro: tem teste próprio (abaixo).
  for (const preset of listPresets().filter((p) => p.kind !== "transition")) {
    const attr = ATTR_OF_KIND[preset.kind as keyof typeof ATTR_OF_KIND];
    const c = clip(`${attr}="${preset.name}"`, 5, tagOf(preset.kind));
    assert.equal(c.ok, true, `${preset.name}: ${JSON.stringify(c.diagnostics)}`);
    assert.deepEqual(c.diagnostics, [], preset.name);
    assert.ok((c.motion["c"]?.[0]?.tracks.length ?? 0) > 0, `${preset.name} sem trilhas`);
  }
});

test("presets: entrada termina no neutro, saída começa nele, ênfase começa e termina nele", () => {
  for (const preset of listPresets().filter((p) => p.kind !== "camera" && p.kind !== "transition")) {
    const attr = ATTR_OF_KIND[preset.kind as keyof typeof ATTR_OF_KIND];
    const c = clip(`${attr}="${preset.name}"`);
    for (const track of c.motion["c"]![0]!.tracks) {
      const neutral = NEUTRAL[track.prop];
      assert.notEqual(neutral, undefined, `${preset.name}: propriedade sem neutro ${track.prop}`);
      const first = track.keys[0]!;
      const last = track.keys[track.keys.length - 1]!;
      assert.equal(last.easing, null, `${preset.name} ${track.prop}: última chave sem easing`);
      if (preset.kind === "enter") assert.equal(last.value, neutral, `${preset.name} ${track.prop} termina`);
      else if (preset.kind === "exit") assert.equal(first.value, neutral, `${preset.name} ${track.prop} começa`);
      else {
        assert.equal(first.value, neutral, `${preset.name} ${track.prop} começa`);
        assert.equal(last.value, neutral, `${preset.name} ${track.prop} termina`);
      }
    }
  }
});

test("presets: entrada parte do deslocamento e saída termina nele (valores da tabela)", () => {
  const first = (attrs: string, prop: string) => trackOf(clip(attrs), prop).keys[0]?.value;
  const last = (attrs: string, prop: string) => {
    const keys = trackOf(clip(attrs), prop).keys;
    return keys[keys.length - 1]?.value;
  };
  assert.equal(first('data-enter="subir"', "--ff-y"), 32);
  assert.equal(first('data-enter="descer"', "--ff-y"), -32);
  assert.equal(first('data-enter="chegar-esquerda"', "--ff-x"), -48);
  assert.equal(first('data-enter="chegar-direita"', "--ff-x"), 48);
  assert.equal(first('data-enter="crescer"', "--ff-sx"), 0.8);
  assert.equal(first('data-enter="assentar"', "--ff-sy"), 1.12);
  assert.equal(first('data-enter="focar"', "--ff-blur"), 12);
  assert.equal(first('data-enter="girar"', "--ff-rot"), -12);
  assert.equal(first('data-enter="girar"', "--ff-sx"), 0.9);
  assert.equal(first('data-enter="erguer"', "--ff-y"), 24);
  assert.equal(first('data-enter="saltar"', "--ff-sx"), 0.6);
  assert.equal(last('data-exit="partir-cima"', "--ff-y"), -32);
  assert.equal(last('data-exit="partir-baixo"', "--ff-y"), 32);
  assert.equal(last('data-exit="partir-esquerda"', "--ff-x"), -48);
  assert.equal(last('data-exit="partir-direita"', "--ff-x"), 48);
  assert.equal(last('data-exit="recuar"', "--ff-sx"), 0.85);
  assert.equal(last('data-exit="desfocar"', "--ff-blur"), 12);
});

test("presets: distance aceita px, % e sinal; fora da faixa ou com unidade inválida dá E_MOTION_PARAM", () => {
  assert.equal(trackOf(clip('data-enter="subir distance=10%"'), "--ff-y").keys[0]?.value, "10%");
  assert.equal(trackOf(clip('data-enter="subir distance=-20px"'), "--ff-y").keys[0]?.value, -20);
  assert.equal(trackOf(clip('data-enter="subir distance=0"'), "--ff-y").keys[0]?.value, 0);
  assert.equal(trackOf(clip('data-enter="subir distance=2000"'), "--ff-y").keys[0]?.value, 2000);
  assert.equal(trackOf(clip('data-enter="subir distance=200%"'), "--ff-y").keys[0]?.value, "200%");
  for (const bad of ["2001", "201%", "3em", "abc"]) {
    const c = clip(`data-enter="subir distance=${bad}"`);
    assert.equal(c.ok, false, JSON.stringify(bad));
    assert.ok(codes(c).includes("E_MOTION_PARAM"), `${bad}: ${JSON.stringify(codes(c))}`);
  }
});

test("presets: amount fora da faixa de cada preset dá E_MOTION_PARAM com a faixa no hint", () => {
  const cases = [
    'data-enter="crescer amount=0"',
    'data-enter="crescer amount=6"',
    'data-enter="focar amount=101"',
    'data-enter="girar amount=181"',
    'data-exit="recuar amount=-1"',
    'data-emphasis="piscar amount=2"',
    'data-emphasis="balancar amount=-3"',
    'data-emphasis="tremer repeat=21"',
  ];
  for (const attrs of cases) {
    const c = clip(attrs);
    assert.equal(c.ok, false, attrs);
    const error = c.diagnostics.find((d) => d.code === "E_MOTION_PARAM");
    assert.ok(error, `${attrs}: ${JSON.stringify(c.diagnostics)}`);
    assert.match(error.hint ?? "", /\[/, attrs);
  }
});

test("abrir e fechar: dir escolhe o recorte; valor inválido dá E_MOTION_PARAM", () => {
  const open = (dir: string) => trackOf(clip(`data-enter="abrir dir=${dir}"`), "clip-path").keys[0]?.value;
  assert.equal(open("up"), "inset(100% 0% 0% 0%)");
  assert.equal(open("down"), "inset(0% 0% 100% 0%)");
  assert.equal(open("left"), "inset(0% 0% 0% 100%)");
  assert.equal(open("right"), "inset(0% 100% 0% 0%)");
  assert.equal(trackOf(clip('data-enter="abrir"'), "clip-path").keys[0]?.value, "inset(0% 100% 0% 0%)");
  const closeKeys = trackOf(clip('data-exit="fechar"'), "clip-path").keys;
  assert.equal(closeKeys[closeKeys.length - 1]?.value, "inset(0% 0% 0% 100%)");
  const closeUp = trackOf(clip('data-exit="fechar dir=up"'), "clip-path").keys;
  assert.equal(closeUp[closeUp.length - 1]?.value, "inset(100% 0% 0% 0%)");
  const bad = clip('data-enter="abrir dir=diagonal"');
  assert.equal(bad.ok, false);
  assert.ok(codes(bad).includes("E_MOTION_PARAM"));
});

test("presets de ênfase: ciclos repetem e a duração total é dur × repeat", () => {
  const once = clip('data-emphasis="tremer"').motion["c"]![0]!.tracks[0]!;
  const thrice = clip('data-emphasis="tremer repeat=3"').motion["c"]![0]!.tracks[0]!;
  assert.equal(once.keys.length, 6);
  assert.equal(thrice.keys.length, 3 * 5 + 1);
  assert.equal(once.duration, 0.4);
  assert.equal(thrice.duration, 1.2);
  assert.deepEqual(
    once.keys.map((k) => k.value),
    [0, 6, -6, 3, -3, 0],
  );
  assert.deepEqual(
    trackOf(clip('data-emphasis="balancar"'), "--ff-rot").keys.map((k) => k.value),
    [0, 4, -4, 0],
  );
  assert.deepEqual(
    trackOf(clip('data-emphasis="piscar"'), "opacity").keys.map((k) => k.value),
    [1, 0.2, 1],
  );
});

test("curvas mistas: saltar e quicar usam duas curvas e curve= do autor vale para todas", () => {
  const saltar = clip('data-enter="saltar"');
  assert.equal(saltar.ok, true, JSON.stringify(saltar.diagnostics));
  assert.equal(trackOf(saltar, "opacity").keys[0]?.easing, SUAVE);
  assert.ok(trackOf(saltar, "--ff-sx").keys[0]?.easing?.startsWith("linear(0, "), "escala usa a mola");

  const quicar = trackOf(clip('data-emphasis="quicar"'), "--ff-y").keys;
  assert.notEqual(quicar[0]?.easing, quicar[1]?.easing, "sobe com freio e volta com arranque");
  assert.deepEqual(
    quicar.map((k) => k.value),
    [0, -16, 0],
  );

  const forced = clip('data-enter="saltar curve=linear"');
  assert.equal(trackOf(forced, "opacity").keys[0]?.easing, "linear");
  assert.equal(trackOf(forced, "--ff-sx").keys[0]?.easing, "linear");
  const forcedBounce = trackOf(clip('data-emphasis="quicar curve=linear"'), "--ff-y").keys;
  assert.equal(forcedBounce[0]?.easing, "linear");
  assert.equal(forcedBounce[1]?.easing, "linear");
});

test("saltar dur=0.3 dá E_CURVE_INVALID (mola não assenta) e o padrão assenta", () => {
  const c = clip('data-enter="saltar dur=0.3"');
  assert.equal(c.ok, false);
  const error = c.diagnostics.find((d) => d.code === "E_CURVE_INVALID");
  assert.ok(error, JSON.stringify(c.diagnostics));
  assert.match(error.hint ?? "", /0\.59/);
  assert.equal(clip('data-enter="saltar"').ok, true);
  // meio ciclo curto demais para a mola
  assert.equal(clip('data-emphasis="quicar curve=mola"').ok, false);
  assert.equal(clip('data-emphasis="quicar curve=mola dur=2"').ok, true);
});

test("springMinSeconds é a mesma fronteira do E_CURVE_INVALID em todo preset com mola (EDT-95)", () => {
  assert.equal(springMinSeconds(listPresets("enter").find((p) => p.name === "saltar")!), 0.59);
  assert.equal(springMinSeconds(listPresets("enter").find((p) => p.name === "subir")!), 0);
  let checked = 0;
  for (const preset of [...listPresets("enter"), ...listPresets("exit"), ...listPresets("emphasis")]) {
    const min = Number(springMinSeconds(preset, "mola").toFixed(6));
    assert.ok(min >= 0.59, `${preset.name}: ${min}`);
    const repeat = preset.kind === "emphasis" ? " repeat=3" : "";
    const planned = (dur: number): Composition => clip(`data-${preset.kind}="${preset.name} curve=mola dur=${dur}${repeat}"`, 100);
    assert.deepEqual(codes(planned(min)), [], `${preset.name} em ${min} s`);
    assert.deepEqual(codes(planned(Number((min - 0.01).toFixed(6)))), ["E_CURVE_INVALID"], `${preset.name} abaixo de ${min} s`);
    checked++;
  }
  assert.ok(checked > 20, `${checked} presets`);
});

test("presets: parâmetro de outro preset é rejeitado", () => {
  const c = clip('data-enter="surgir distance=10"');
  assert.equal(c.ok, false);
  assert.ok(codes(c).includes("E_MOTION_PARAM"));
  assert.equal(clip('data-enter="subir amount=2"').ok, false);
  assert.equal(clip('data-enter="focar dir=left"').ok, false);
});

// ---- Tipografia cinética: data-split (§7b.8) ----

const textOf = (pieces: Array<{ text: string }>): string => pieces.map((p) => p.text).join("");
const unitsOf = (text: string, mode: "word" | "letter"): string[] => splitText(text, mode).filter((p) => p.unit).map((p) => p.text);

test("splitText word: pontuação gruda, espaço fica solto e byte a byte", () => {
  assert.deepEqual(splitText("Olá, mundo!", "word"), [
    { text: "Olá,", unit: true },
    { text: " ", unit: false },
    { text: "mundo!", unit: true },
  ]);
  const spaced = splitText("ação  já", "word");
  assert.deepEqual(spaced.map((p) => p.text), ["ação", "  ", "já"]);
  assert.deepEqual(unitsOf("“Sim”", "word"), ["“Sim”"]);
  assert.deepEqual(unitsOf("¿Qué tal?", "word"), ["¿Qué", "tal?"]);
  // emoji isolado entre espaços anima com o resto
  assert.deepEqual(unitsOf("ok 👍🏽 já", "word"), ["ok", "👍🏽", "já"]);
});

test("splitText letter: grafema por unidade e índice de palavra", () => {
  const info = `Node ${process.versions.node}, ICU ${process.versions.icu}`;
  const units = unitsOf("é 👍🏽 👨‍👩‍👧", "letter");
  assert.equal(units.length, 3, `Intl.Segmenter("und") deu ${units.length} unidades (${info}): ${JSON.stringify(units)}`);
  const pieces = splitText("ab c", "letter");
  assert.deepEqual(pieces.map((p) => p.word), [0, 0, undefined, 1]);
  assert.equal(textOf(pieces), "ab c");
});

test("splitText: a soma dos pedaços reconstrói a entrada (50 strings com seed fixa)", () => {
  // xorshift32 determinístico: nada de Math.random
  let state = 0x9e3779b9;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const alphabet = ["a", "Z", "é", "é", "ç", "ã", " ", " ", "  ", "\t", "\n", ",", ".", "!", "“", "”", "¿", "-", "—", "1", "42", "👍🏽", "👨‍👩‍👧", "🇧🇷", "ا", "漢"];
  for (let i = 0; i < 50; i++) {
    const length = 1 + (next() % 24);
    let text = "";
    for (let j = 0; j < length; j++) text += alphabet[next() % alphabet.length]!;
    for (const mode of ["word", "letter"] as const) {
      assert.equal(textOf(splitText(text, mode)), text, `${mode}: ${JSON.stringify(text)} (Node ${process.versions.node}, ICU ${process.versions.icu})`);
    }
  }
});

test("unitRanks: forward, reverse e center", () => {
  assert.deepEqual(unitRanks(3, "forward"), { ranks: [0, 1, 2], max: 2 });
  assert.deepEqual(unitRanks(3, "reverse"), { ranks: [2, 1, 0], max: 2 });
  assert.deepEqual(unitRanks(4, "center"), { ranks: [1, 0, 0, 1], max: 1 });
  assert.deepEqual(unitRanks(0, "center"), { ranks: [], max: 0 });
});

const splitClip = (attrs: string, inner = "um dois três", duration = 5): Composition =>
  loadComposition(root(`<h1 data-clip-id="c" data-start="0" data-duration="${duration}" ${attrs}>${inner}</h1>`));

/** Início da trilha `prop` de cada unidade do primeiro alvo de `c`. */
const unitStarts = (c: Composition, prop = "opacity"): number[] =>
  (c.motion["c"]?.[0]?.units ?? []).map((tracks) => tracks.find((t) => t.prop === prop)!.start);

test("split: 3 palavras com stagger=0.1 entram em 0, 0.1 e 0.2", () => {
  const c = splitClip('data-split="word stagger=0.1" data-enter="surgir"');
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.deepEqual(unitStarts(c), [0, 0.1, 0.2]);
  const target = c.motion["c"]![0]!;
  assert.deepEqual(target.tracks, []);
  assert.deepEqual(target.split, { mode: "word", explicit: false });
});

test("split: order=reverse e center; padrão de stagger por modo", () => {
  assert.deepEqual(unitStarts(splitClip('data-split="word stagger=0.1 order=reverse" data-enter="surgir"')), [0.2, 0.1, 0]);
  assert.deepEqual(unitStarts(splitClip('data-split="word stagger=0.1 order=center" data-enter="surgir"', "a b c d")), [0.1, 0, 0, 0.1]);
  assert.deepEqual(unitStarts(splitClip('data-split="word" data-enter="surgir"')), [0, 0.06, 0.12]);
  assert.deepEqual(unitStarts(splitClip('data-split="letter" data-enter="surgir"', "abc")), [0, 0.03, 0.06]);
});

test("split: saída termina em D na última unidade e a ênfase começa depois da última entrada", () => {
  const exit = splitClip('data-split="word stagger=0.1" data-exit="apagar"');
  assert.equal(exit.ok, true, JSON.stringify(exit.diagnostics));
  const ends = (exit.motion["c"]![0]!.units ?? []).map((tracks) => tracks[0]!.start + tracks[0]!.duration);
  assert.deepEqual(ends.map((n) => Number(n.toFixed(6))), [4.8, 4.9, 5]);
  const both = splitClip('data-split="word stagger=0.1" data-enter="surgir" data-emphasis="pulsar"');
  assert.equal(both.ok, true, JSON.stringify(both.diagnostics));
  // entrada termina em 0.5 + 0.2 na última unidade; a ênfase da unidade 0 começa aí
  assert.equal(unitStarts(both, "--ff-sx")[0], 0.7);
  assert.equal(unitStarts(both, "--ff-sx")[2], 0.9);
});

test("split: stagger que estoura a duração dá E_MOTION_OUT_OF_RANGE com a unidade", () => {
  const c = splitClip('data-split="word stagger=1" data-enter="surgir at=4"', "um dois três", 5);
  assert.equal(c.ok, false);
  const error = c.diagnostics.find((d) => d.code === "E_MOTION_OUT_OF_RANGE");
  assert.ok(error, JSON.stringify(c.diagnostics));
  assert.match(error.message, /unidade 2 de 3/);
  assert.match(error.hint ?? "", /stagger/);
});

test("split: unidades explícitas usam data-unit; vazio segue o stagger", () => {
  const c = splitClip(
    'data-split="word stagger=0.2" data-enter="surgir"',
    '<span data-unit="1.5">a</span> <span data-unit>b</span> <span data-unit="0.25">c</span>',
  );
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  // sem âncora: posto 1 × 0.2
  assert.deepEqual(unitStarts(c), [1.5, 0.2, 0.25]);
  assert.deepEqual(c.motion["c"]![0]!.split, { mode: "word", explicit: true });
});

test("split: erros de uso", () => {
  const sem = splitClip('data-split="word"');
  assert.equal(sem.ok, false);
  assert.equal(sem.diagnostics.find((d) => d.code === "E_MOTION_TARGET")?.hint, "data-split precisa de data-enter, data-exit ou data-emphasis");

  const vazio = splitClip('data-split="word" data-enter="surgir"', "  ");
  assert.ok(vazio.diagnostics.some((d) => d.code === "E_MOTION_TARGET" && /data-split sem texto/.test(d.hint ?? "")));

  const interno = splitClip('data-split="word" data-enter="surgir"', 'um <b data-enter="surgir">dois</b>');
  assert.ok(interno.diagnostics.some((d) => d.code === "E_MOTION_TARGET" && /<b>/.test(d.message)));

  const modo = splitClip('data-split="linha" data-enter="surgir"');
  assert.ok(modo.diagnostics.some((d) => d.code === "E_MOTION_SYNTAX"));
  assert.ok(splitClip('data-split="word stagger=x" data-enter="surgir"').diagnostics.some((d) => d.code === "E_MOTION_PARAM"));
  assert.ok(splitClip('data-split="word order=meio" data-enter="surgir"').diagnostics.some((d) => d.code === "E_MOTION_PARAM"));
  assert.ok(splitClip('data-split="word ritmo=1" data-enter="surgir"').diagnostics.some((d) => d.code === "E_MOTION_PARAM"));

  const unit = splitClip('data-split="word" data-enter="surgir"', '<span data-unit="x">a</span>');
  assert.ok(unit.diagnostics.some((d) => d.code === "E_MOTION_PARAM" && /data-unit/.test(d.message)));

  const orfa = splitClip('data-enter="surgir"', '<span data-unit="1">a</span>');
  assert.ok(orfa.diagnostics.some((d) => d.code === "E_MOTION_TARGET" && /fora de data-split/.test(d.message)));

  const camera = splitClip('data-split="word" data-enter="surgir" data-transition="surgir"');
  assert.equal(camera.ok, false);
});

test("split: data-keyframes no mesmo elemento fica no elemento; style inline de unidade explícita conflita", () => {
  const c = splitClip('data-split="word" data-enter="surgir" data-keyframes=\'[{"time":0,"x":0},{"time":1,"x":10}]\'');
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const target = c.motion["c"]![0]!;
  assert.deepEqual(target.tracks.map((t) => t.prop), ["--ff-x"]);
  assert.equal(target.units?.length, 3);

  const conflito = splitClip('data-split="word" data-enter="subir"', '<span data-unit style="translate: 3px">a</span>');
  assert.equal(conflito.ok, false);
  assert.ok(conflito.diagnostics.some((d) => d.code === "E_MOTION_CONFLICT" && /unidade 1/.test(d.message)));
});

// ---------- EDT-53: câmera em imagem e vídeo (docs/contract.md §7b.9) ----------

const cameraClip = (attrs: string, duration = 4, tag = "img"): Composition => clip(attrs, duration, tag);
const zoomKeys = (c: Composition): Array<number | string> => trackOf(c, "--ff-zoom").keys.map((k) => k.value);

test("câmera: aproximar numa <img> de 4 s dá zoom 1 em 0 s e 1.15 em 4 s", () => {
  const c = cameraClip('data-camera="aproximar"');
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const track = trackOf(c, "--ff-zoom");
  assert.equal(track.start, 0);
  assert.equal(track.duration, 4);
  assert.deepEqual(zoomKeys(c), [1, 1.15]);
  // Foco padrão (0.5) é o valor registrado: não gera trilha, para não disputar com data-keyframes.
  assert.deepEqual(c.motion["c"]![0]!.tracks.map((t) => t.prop), ["--ff-zoom"]);
});

test("câmera: sem dur= ocupa de at até o fim do clip; dur= explícito vale", () => {
  const late = trackOf(cameraClip('data-camera="aproximar at=1"'), "--ff-zoom");
  assert.equal(late.start, 1);
  assert.equal(late.duration, 3);
  const short = trackOf(cameraClip('data-camera="aproximar dur=2"'), "--ff-zoom");
  assert.equal(short.duration, 2);
  const tail = trackOf(cameraClip('data-camera="aproximar at=end-1"'), "--ff-zoom");
  assert.equal(tail.start, 3);
  assert.equal(tail.duration, 1);
});

test("câmera: at no fim do clip ou depois dele dá E_MOTION_OUT_OF_RANGE", () => {
  for (const at of ["4", "5", "end"]) {
    const c = cameraClip(`data-camera="aproximar at=${at}"`);
    assert.equal(c.ok, false, at);
    assert.ok(codes(c).includes("E_MOTION_OUT_OF_RANGE"), `${at}: ${JSON.stringify(codes(c))}`);
  }
});

test("câmera: afastar inverte o zoom; fx e fy fora de 0.5 viram trilhas constantes", () => {
  const out = cameraClip('data-camera="afastar amount=2 fx=0.2 fy=0.9"');
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.deepEqual(zoomKeys(out), [2, 1]);
  assert.deepEqual(trackOf(out, "--ff-fx").keys.map((k) => k.value), [0.2, 0.2]);
  assert.deepEqual(trackOf(out, "--ff-fy").keys.map((k) => k.value), [0.9, 0.9]);
});

test("câmera: panorâmicas mantêm o zoom e percorrem o foco horizontal", () => {
  const left = cameraClip('data-camera="panoramica-esquerda"');
  assert.deepEqual(zoomKeys(left), [1.12, 1.12]);
  assert.deepEqual(trackOf(left, "--ff-fx").keys.map((k) => k.value), [0.75, 0.25]);
  const right = cameraClip('data-camera="panoramica-direita amount=1.3"');
  assert.deepEqual(zoomKeys(right), [1.3, 1.3]);
  assert.deepEqual(trackOf(right, "--ff-fx").keys.map((k) => k.value), [0.25, 0.75]);
  assert.equal(trackOf(right, "--ff-fx").keys[0]!.easing, "linear");
});

test("câmera: deriva tem três trilhas lineares", () => {
  const c = cameraClip('data-camera="deriva"', 6);
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.deepEqual(c.motion["c"]![0]!.tracks.map((t) => t.prop), ["--ff-zoom", "--ff-fx", "--ff-fy"]);
  assert.deepEqual(zoomKeys(c), [1.06, 1.1]);
  assert.deepEqual(trackOf(c, "--ff-fx").keys.map((k) => k.value), [0.45, 0.55]);
  assert.deepEqual(trackOf(c, "--ff-fy").keys.map((k) => k.value), [0.48, 0.52]);
});

test("câmera: vale em <video>; em <div> dá E_MOTION_TARGET com hint", () => {
  const video = cameraClip('data-camera="aproximar"', 4, "video");
  assert.equal(video.ok, true, JSON.stringify(video.diagnostics));
  const div = cameraClip('data-camera="aproximar"', 4, "div");
  assert.equal(div.ok, false);
  const error = div.diagnostics.find((d) => d.code === "E_MOTION_TARGET");
  assert.ok(error?.hint, JSON.stringify(div.diagnostics));
});

test("câmera: amount e foco fora da faixa dão E_MOTION_PARAM", () => {
  for (const bad of ["amount=0.9", "amount=4.1", "fx=1.1", "fy=-0.1"]) {
    const c = cameraClip(`data-camera="aproximar ${bad}"`);
    assert.equal(c.ok, false, bad);
    assert.ok(codes(c).includes("E_MOTION_PARAM"), `${bad}: ${JSON.stringify(codes(c))}`);
  }
  // panorâmica não tem fx: o foco horizontal é o próprio movimento.
  assert.ok(codes(cameraClip('data-camera="panoramica-direita fx=0.5"')).includes("E_MOTION_PARAM"));
});

test("câmera: zoom e foco em data-keyframes valem em <img>/<video> e têm faixa própria", () => {
  const points = [
    { time: 0, zoom: 1, focusX: 0.2, focusY: 0.8 },
    { time: 2, zoom: 2.5, focusX: 0.8, focusY: 0.2 },
  ];
  for (const tag of ["img", "video"]) {
    const c = cameraClip(`data-keyframes='${JSON.stringify(points)}'`, 3, tag);
    assert.equal(c.ok, true, `${tag}: ${JSON.stringify(c.diagnostics)}`);
    assert.deepEqual(zoomKeys(c), [1, 2.5]);
    assert.deepEqual(trackOf(c, "--ff-fx").keys.map((k) => k.value), [0.2, 0.8]);
  }
  const bad: Record<string, object> = { "zoom 0.5": { zoom: 0.5 }, "zoom 4.5": { zoom: 4.5 }, "focusX 1.2": { focusX: 1.2 }, "focusY -0.1": { focusY: -0.1 } };
  for (const [name, point] of Object.entries(bad)) {
    const c = cameraClip(`data-keyframes='${JSON.stringify([{ time: 0, ...point }])}'`, 3);
    assert.equal(c.ok, false, name);
    assert.ok(codes(c).includes("E_KEYFRAME_INVALID"), `${name}: ${JSON.stringify(codes(c))}`);
  }
});

test('câmera: zoom em <div> dá E_KEYFRAME_INVALID com o hint "zoom e foco só valem em img ou video"', () => {
  const c = kf([{ time: 0, zoom: 1.2 }]);
  assert.equal(c.ok, false);
  const error = c.diagnostics.find((d) => d.code === "E_KEYFRAME_INVALID");
  assert.ok(error?.hint?.includes("zoom e foco só valem em img ou video"), JSON.stringify(c.diagnostics));
});

test("câmera: data-camera e keyframes de zoom no mesmo alvo se sobrepõem (E_MOTION_OVERLAP)", () => {
  const c = cameraClip(`data-camera="aproximar" data-keyframes='[{"time":0,"zoom":1},{"time":1,"zoom":2}]'`);
  assert.equal(c.ok, false);
  assert.ok(codes(c).includes("E_MOTION_OVERLAP"), JSON.stringify(codes(c)));
});

test("câmera: object-view-box no style inline com câmera é E_MOTION_CONFLICT", () => {
  const c = cameraClip('data-camera="aproximar" style="object-view-box:inset(10%)"');
  assert.equal(c.ok, false);
  assert.ok(codes(c).includes("E_MOTION_CONFLICT"), JSON.stringify(codes(c)));
});

test("câmera: uma <img> pode ter entrada e câmera ao mesmo tempo", () => {
  const c = cameraClip('data-enter="surgir" data-camera="aproximar"');
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.deepEqual(c.motion["c"]![0]!.tracks.map((t) => t.prop).sort(), ["--ff-zoom", "opacity"]);
});

test("motion em <video> deixou de ser recusado (EDT-53)", () => {
  const c = cameraClip('data-enter="surgir"', 4, "video");
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
});

// ---------------------------------------------------------------------------------------------
// Transições entre clips adjacentes (EDT-54, §7b.10)
// ---------------------------------------------------------------------------------------------

/** A (0–3 s) e B com `data-start` e atributos dados. */
const pair = (bAttrs: string, start = "a - 0.5", aAttrs = "", bDuration = 3): Composition =>
  loadComposition(
    root(
      `<div data-clip-id="a" data-start="0" data-duration="3" ${aAttrs}></div>` +
        `<div data-clip-id="b" data-start="${start}" data-duration="${bDuration}" ${bAttrs}></div>`,
    ),
  );

function plainTrack(c: Composition, clipId: string, prop: string) {
  const track = c.motion[clipId]?.flatMap((t) => t.tracks).find((t) => t.prop === prop);
  assert.ok(track, `faltou ${clipId}/${prop}: ${JSON.stringify(c.motion)} ${JSON.stringify(c.diagnostics)}`);
  return track;
}

test("transição dissolver: B ganha opacidade 0→1 nos primeiros 0,5 s e A não muda", () => {
  const c = pair('data-transition="dissolver"');
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const track = plainTrack(c, "b", "opacity");
  assert.equal(track.start, 0);
  assert.equal(track.duration, 0.5);
  assert.equal(track.keys[0]!.value, 0);
  assert.equal(track.keys[track.keys.length - 1]!.value, 1);
  assert.equal(c.motion["a"], undefined);
});

test("transição empurrar: A sai para a esquerda em [D_A−d, D_A] e B chega da direita em [0, d]", () => {
  const c = pair('data-transition="empurrar"');
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const a = plainTrack(c, "a", "--ff-x");
  assert.equal(a.start, 2.5);
  assert.equal(a.duration, 0.5);
  assert.equal(a.keys[0]!.value, 0);
  assert.equal(a.keys[a.keys.length - 1]!.value, "-100%");
  const b = plainTrack(c, "b", "--ff-x");
  assert.equal(b.start, 0);
  assert.equal(b.duration, 0.5);
  assert.equal(b.keys[0]!.value, "100%");
  assert.equal(b.keys[b.keys.length - 1]!.value, 0);
  // A não tinha atributo de motion: o alvo é sintético e aponta o próprio elemento.
  assert.equal(c.motion["a"]![0]!.own, true);
});

test("transição empurrar dir=up: eixo y, B chega de baixo", () => {
  const c = pair('data-transition="empurrar dir=up"');
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.equal(plainTrack(c, "b", "--ff-y").keys[0]!.value, "100%");
  const a = plainTrack(c, "a", "--ff-y");
  assert.equal(a.keys[a.keys.length - 1]!.value, "-100%");
});

test("transição cortina e iris usam clip-path; zoom combina opacidade e escala", () => {
  const cortina = pair('data-transition="cortina"');
  assert.equal(cortina.ok, true, JSON.stringify(cortina.diagnostics));
  assert.equal(plainTrack(cortina, "b", "clip-path").keys[0]!.value, "inset(0% 100% 0% 0%)");
  const iris = pair('data-transition="iris"');
  assert.equal(iris.ok, true, JSON.stringify(iris.diagnostics));
  const keys = plainTrack(iris, "b", "clip-path").keys;
  assert.equal(keys[0]!.value, "circle(0% at 50% 50%)");
  assert.equal(keys[keys.length - 1]!.value, "circle(75% at 50% 50%)");
  const zoom = pair('data-transition="zoom"');
  assert.equal(zoom.ok, true, JSON.stringify(zoom.diagnostics));
  assert.deepEqual(zoom.motion["b"]![0]!.tracks.map((t) => t.prop).sort(), ["--ff-sx", "--ff-sy", "opacity"]);
});

test("transição iris com foco deslocado usa raio 150%", () => {
  const c = pair('data-transition="iris fx=0 fy=0"');
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const keys = plainTrack(c, "b", "clip-path").keys;
  assert.equal(keys[0]!.value, "circle(0% at 0% 0%)");
  assert.equal(keys[keys.length - 1]!.value, "circle(150% at 0% 0%)");
});

test("transição: B começando em 2.5 (absoluto) é E_TRANSITION_PARTNER", () => {
  const c = pair('data-transition="dissolver"', "2.5");
  assert.equal(c.ok, false);
  const d = c.diagnostics.find((x) => x.code === "E_TRANSITION_PARTNER");
  assert.ok(d?.hint, JSON.stringify(c.diagnostics));
});

test("transição: B depois do fim de A (deslocamento positivo) é E_TRANSITION_PARTNER", () => {
  const c = pair('data-transition="dissolver"', "a + 0.5");
  assert.equal(c.ok, false);
  assert.ok(codes(c).includes("E_TRANSITION_PARTNER"), JSON.stringify(c.diagnostics));
});

test("transição: A fora do escopo de B ou depois dele é E_TRANSITION_PARTNER", () => {
  const nested = loadComposition(
    root(
      `<div data-clip-id="outer" data-start="0" data-duration="4"><div data-clip-id="a" data-start="0" data-duration="3"></div></div>` +
        `<div data-clip-id="b" data-start="a - 0.5" data-duration="3" data-transition="dissolver"></div>`,
    ),
  );
  assert.ok(codes(nested).includes("E_TRANSITION_PARTNER"), JSON.stringify(nested.diagnostics));
  const after = loadComposition(
    root(
      `<div data-clip-id="b" data-start="a - 0.5" data-duration="3" data-transition="dissolver"></div>` +
        `<div data-clip-id="a" data-start="0" data-duration="3"></div>`,
    ),
  );
  assert.equal(after.ok, false);
});

test("transição: d maior que a duração de um dos clips é E_MOTION_OUT_OF_RANGE", () => {
  const c = pair('data-transition="dissolver"', "a - 4");
  assert.equal(c.ok, false);
  assert.ok(codes(c).includes("E_MOTION_OUT_OF_RANGE"), JSON.stringify(c.diagnostics));
});

test("transição: dur e at não valem (a duração é a sobreposição)", () => {
  const dur = pair('data-transition="dissolver dur=1"');
  assert.equal(dur.ok, false);
  const d = dur.diagnostics.find((x) => x.code === "E_MOTION_PARAM");
  assert.ok(d?.hint?.includes("sobreposição"), JSON.stringify(dur.diagnostics));
  const at = pair('data-transition="dissolver at=0.2"');
  assert.equal(at.ok, false);
  assert.ok(codes(at).includes("E_MOTION_PARAM"), JSON.stringify(at.diagnostics));
});

test("transição: curve vale e vira o easing dos dois lados", () => {
  const c = pair('data-transition="empurrar curve=linear"');
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.equal(plainTrack(c, "a", "--ff-x").keys[0]!.easing, "linear");
  assert.equal(plainTrack(c, "b", "--ff-x").keys[0]!.easing, "linear");
});

test("transição empurrar: data-exit em A sobreposto a [D_A−d, D_A] é E_MOTION_OVERLAP", () => {
  const c = pair('data-transition="empurrar"', "a - 0.5", 'data-exit="partir-esquerda"');
  assert.equal(c.ok, false);
  assert.ok(codes(c).includes("E_MOTION_OVERLAP"), JSON.stringify(c.diagnostics));
});

test("transição empurrar: A com data-enter próprio convive (trilhas em intervalos diferentes)", () => {
  const c = pair('data-transition="empurrar"', "a - 0.5", 'data-enter="surgir"');
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const target = c.motion["a"]![0]!;
  assert.equal(target.own, undefined);
  assert.deepEqual(target.tracks.map((t) => t.prop).sort(), ["--ff-x", "opacity"]);
});

test("transição: preset desconhecido e sintaxe inválida mantêm os códigos de motion", () => {
  assert.ok(codes(pair('data-transition="surgir"')).includes("E_MOTION_PRESET_UNKNOWN"));
  assert.ok(codes(pair('data-transition=""')).includes("E_MOTION_SYNTAX"));
});

test("transição: a duração total encurta d (B e quem depende dele andam d antes)", () => {
  const c = pair('data-transition="dissolver"');
  assert.deepEqual(c.duration, { kind: "derived", seconds: 5.5 });
});

test("sampleTracks: valor por propriedade CSS em qualquer tempo do clip", () => {
  const c = clip(`data-enter="surgir" data-keyframes='[{"time":2,"x":0},{"time":4,"x":100,"curve":"linear"}]'`);
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const own = c.motion["c"]!.find((target) => target.ordinal === 0)!;
  const at = (time: number) => sampleTracks(own, time);
  // Entrada: opacidade com a curva suave; antes do começo vale a primeira chave, depois do fim a última.
  assert.equal(at(0)["opacity"], 0);
  assert.ok(Math.abs(Number(at(0.25)["opacity"]) - evaluateCurve(SUAVE, 0.5, 0.5)) < 1e-6);
  assert.equal(at(3)["opacity"], 1);
  // Keyframes lineares: 2 s → 4 s vai de 0 a 100; fora do trecho fica parado.
  assert.equal(at(1)["--ff-x"], 0);
  assert.equal(at(3)["--ff-x"], 50);
  assert.equal(at(5)["--ff-x"], 100);
  // Propriedade que nada anima não aparece.
  assert.equal(at(1)["--ff-y"], undefined);
});

test("transição com parceiro de id hifenizado (EDT-75) acha o clip clip-1", () => {
  const c = loadComposition(
    root(
      `<div data-clip-id="clip-1" data-start="0" data-duration="3"></div>` +
        `<div data-clip-id="clip-2" data-start="clip-1 - 0.5" data-duration="3" data-transition="dissolver"></div>`,
    ),
  );
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.equal(c.clips.find((x) => x.id === "clip-2")!.start, 2.5);
  assert.ok(c.motion["clip-2"], "B ganhou a trilha da transição");
});
