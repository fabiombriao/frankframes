// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCurve, loadComposition } from "@frankframes/contract";
import { keyframeExpression } from "../src/audio.ts";
import { EditError } from "../src/edit.ts";
import { editKeyframes, mergeKeyframePoints } from "../src/keyframes-edit.ts";

const page = (clips: string): string => `<!doctype html>
<html><body>
  <div data-composition-id="main" data-root="true" data-duration="4">
${clips}
  </div>
</body></html>`;

const PLAIN = page(`    <div data-clip-id="t" data-start="0" data-duration="2" class="clip">olá</div>`);

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EditError) return error.code;
    throw error;
  }
  return undefined;
};

const keyframesAttr = (source: string, clipId: string): string | undefined => {
  const tag = new RegExp(`<[a-z]+ [^>]*data-clip-id="${clipId}"[^>]*>`).exec(source)?.[0] ?? "";
  return /data-keyframes='([^']*)'/.exec(tag)?.[1];
};

test("add opacity em clip sem keyframes cria o atributo canônico", () => {
  const out = editKeyframes(PLAIN, { clipId: "t", op: "add", time: 1, prop: "opacity", value: 1 });
  assert.equal(keyframesAttr(out, "t"), '[{"time":1,"opacity":1}]');
  assert.equal(loadComposition(out).ok, true);
});

test("add sem value usa o valor que o preset de entrada dá naquele tempo", () => {
  const source = page(`    <div data-clip-id="t" data-start="0" data-duration="2" data-enter="surgir">olá</div>`);
  const out = editKeyframes(source, { clipId: "t", op: "add", time: 0.25, prop: "opacity" });
  const value = JSON.parse(keyframesAttr(out, "t") ?? "[]")[0].opacity as number;
  // `surgir`: opacidade 0 → 1 em 0,5 s com cubic-bezier(0.34, 0.1, 0.18, 1); 0,25 s é metade do trecho.
  const expected = evaluateCurve("cubic-bezier(0.34, 0.1, 0.18, 1)", 0.5, 0.5);
  assert.ok(Math.abs(value - expected) <= 0.001, `esperado ~${expected}, veio ${value}`);
});

test("add de volume em clip com automação mantém os pontos e acrescenta o novo", () => {
  const source = page(
    `    <audio data-clip-id="m" data-start="0" data-duration="2" src="m.mp3" data-keyframes='[{"time":0,"volume":1}]'></audio>`,
  );
  const out = editKeyframes(source, { clipId: "m", op: "add", time: 1, prop: "volume", value: 0.4 });
  assert.equal(keyframesAttr(out, "m"), '[{"time":0,"volume":1},{"time":1,"volume":0.4}]');
  assert.equal(loadComposition(out).ok, true);
});

test("add de volume sem value interpola a automação existente", () => {
  const source = page(
    `    <audio data-clip-id="m" data-start="0" data-duration="2" src="m.mp3" data-keyframes='[{"time":0,"volume":1},{"time":2,"volume":0}]'></audio>`,
  );
  const out = editKeyframes(source, { clipId: "m", op: "add", time: 1, prop: "volume" });
  assert.equal(keyframesAttr(out, "m"), '[{"time":0,"volume":1},{"time":1,"volume":0.5},{"time":2,"volume":0}]');
});

test("keyframe visual não muda a expressão de volume do áudio", () => {
  const source = page(
    `    <video data-clip-id="v" data-start="0" data-duration="2" src="v.mp4" data-keyframes='[{"time":0,"volume":1},{"time":1,"volume":0.5}]'></video>`,
  );
  const volumes = (text: string): Array<{ time: number; volume: number }> => {
    const clip = loadComposition(text).clips.find((item) => item.id === "v");
    assert.ok(clip?.keyframes, "volume lido pelo contrato");
    return clip.keyframes;
  };
  const before = keyframeExpression(volumes(source), 2);
  const out = editKeyframes(source, { clipId: "v", op: "add", time: 0.5, prop: "opacity", value: 0.8 });
  assert.deepEqual(keyframeExpression(volumes(out), 2), before);
  assert.equal(keyframesAttr(out, "v"), '[{"time":0,"volume":1},{"time":0.5,"opacity":0.8},{"time":1,"volume":0.5}]');
});

test("move leva o ponto inteiro e recusa tempo ocupado", () => {
  const source = page(
    `    <div data-clip-id="t" data-start="0" data-duration="2" data-keyframes='[{"time":0.5,"opacity":0.2,"curve":"suave"},{"time":1,"opacity":1}]'>x</div>`,
  );
  const moved = editKeyframes(source, { clipId: "t", op: "move", time: 0.5, to: 1.5 });
  assert.equal(keyframesAttr(moved, "t"), '[{"time":1,"opacity":1},{"time":1.5,"opacity":0.2,"curve":"suave"}]');
  assert.equal(codeOf(() => editKeyframes(source, { clipId: "t", op: "move", time: 0.5, to: 1 })), "E_KEYFRAME_EXISTS");
  assert.equal(editKeyframes(source, { clipId: "t", op: "move", time: 0.5, to: 0.5 }), source);
  assert.equal(codeOf(() => editKeyframes(source, { clipId: "t", op: "move", time: 0.7, to: 1.5 })), "E_KEYFRAME_NOT_FOUND");
});

test("remove da última propriedade tira o atributo; sem prop apaga o ponto", () => {
  const one = editKeyframes(PLAIN, { clipId: "t", op: "add", time: 1, prop: "opacity", value: 0.5 });
  const gone = editKeyframes(one, { clipId: "t", op: "remove", time: 1, prop: "opacity" });
  assert.ok(!gone.includes("data-keyframes"), "atributo some com o último ponto");

  const two = editKeyframes(one, { clipId: "t", op: "add", time: 1, prop: "x", value: 40 });
  assert.equal(keyframesAttr(two, "t"), '[{"time":1,"opacity":0.5,"x":40}]');
  const lessOne = editKeyframes(two, { clipId: "t", op: "remove", time: 1, prop: "x" });
  assert.equal(keyframesAttr(lessOne, "t"), '[{"time":1,"opacity":0.5}]');
  assert.ok(!editKeyframes(two, { clipId: "t", op: "remove", time: 1 }).includes("data-keyframes"));
  assert.equal(codeOf(() => editKeyframes(two, { clipId: "t", op: "remove", time: 1, prop: "blur" })), "E_KEYFRAME_NOT_FOUND");
});

test("add e remove devolvem o arquivo original byte a byte", () => {
  for (const source of [PLAIN, page(`    <img data-clip-id="i" data-start="0" data-duration="2" src="a.png" />`)]) {
    const id = source.includes('data-clip-id="i"') ? "i" : "t";
    const added = editKeyframes(source, { clipId: id, op: "add", time: 1, prop: "opacity", value: 0.5 });
    assert.notEqual(added, source);
    assert.equal(editKeyframes(added, { clipId: id, op: "remove", time: 1 }), source);
  }
});

test("edit troca valor e curva; curve:null remove a curva", () => {
  const source = editKeyframes(PLAIN, { clipId: "t", op: "add", time: 1, prop: "opacity", value: 0.5 });
  const valued = editKeyframes(source, { clipId: "t", op: "edit", time: 1, prop: "opacity", value: 0.9 });
  assert.equal(keyframesAttr(valued, "t"), '[{"time":1,"opacity":0.9}]');
  const curved = editKeyframes(valued, { clipId: "t", op: "edit", time: 1, curve: "suave" });
  assert.equal(keyframesAttr(curved, "t"), '[{"time":1,"opacity":0.9,"curve":"suave"}]');
  assert.equal(editKeyframes(curved, { clipId: "t", op: "edit", time: 1, curve: null }), valued);
  assert.equal(codeOf(() => editKeyframes(valued, { clipId: "t", op: "edit", time: 1 })), "E_ATTRIBUTE_INVALID");
  assert.equal(
    codeOf(() => editKeyframes(valued, { clipId: "t", op: "edit", time: 1, prop: "blur", value: 2 })),
    "E_KEYFRAME_NOT_FOUND",
  );
});

test("curva mola num trecho curto é aceita na edição mas reprovada pelo contrato", () => {
  let source = editKeyframes(PLAIN, { clipId: "t", op: "add", time: 0, prop: "opacity", value: 0 });
  source = editKeyframes(source, { clipId: "t", op: "add", time: 0.2, prop: "opacity", value: 1 });
  const out = editKeyframes(source, { clipId: "t", op: "edit", time: 0, curve: "mola" });
  const composition = loadComposition(out);
  assert.equal(composition.ok, false);
  assert.ok(
    composition.diagnostics.some((item) => item.code === "E_CURVE_INVALID"),
    JSON.stringify(composition.diagnostics),
  );
});

test("propriedades que o elemento não aceita dão E_KEYFRAME_PROP", () => {
  assert.equal(codeOf(() => editKeyframes(PLAIN, { clipId: "t", op: "add", time: 1, prop: "volume", value: 1 })), "E_KEYFRAME_PROP");
  assert.equal(codeOf(() => editKeyframes(PLAIN, { clipId: "t", op: "add", time: 1, prop: "zoom", value: 1.2 })), "E_KEYFRAME_PROP");
  assert.equal(
    codeOf(() => editKeyframes(PLAIN, { clipId: "t", op: "add", time: 1, prop: "bogus" as never, value: 1 })),
    "E_KEYFRAME_PROP",
  );
  const image = page(`    <img data-clip-id="i" data-start="0" data-duration="2" src="a.png" />`);
  const out = editKeyframes(image, { clipId: "i", op: "add", time: 1, prop: "zoom", value: 1.5 });
  assert.equal(keyframesAttr(out, "i"), '[{"time":1,"zoom":1.5}]');
  assert.equal(loadComposition(out).ok, true);
});

test("tempo fora do clip, clip inexistente e ponto repetido falham alto", () => {
  assert.equal(codeOf(() => editKeyframes(PLAIN, { clipId: "t", op: "add", time: -0.1, prop: "opacity", value: 1 })), "E_KEYFRAME_OUT_OF_RANGE");
  assert.equal(codeOf(() => editKeyframes(PLAIN, { clipId: "t", op: "add", time: 2.5, prop: "opacity", value: 1 })), "E_KEYFRAME_OUT_OF_RANGE");
  assert.equal(codeOf(() => editKeyframes(PLAIN, { clipId: "zzz", op: "add", time: 1, prop: "opacity", value: 1 })), "E_CLIP_NOT_FOUND");
  const one = editKeyframes(PLAIN, { clipId: "t", op: "add", time: 1, prop: "opacity", value: 0.5 });
  assert.equal(codeOf(() => editKeyframes(one, { clipId: "t", op: "add", time: 1.0001, prop: "opacity", value: 1 })), "E_KEYFRAME_EXISTS");
});

test("JSON quebrado no arquivo é recusado, não sobrescrito", () => {
  const broken = page(`    <div data-clip-id="t" data-start="0" data-duration="2" data-keyframes='[oops'>x</div>`);
  assert.equal(codeOf(() => editKeyframes(broken, { clipId: "t", op: "add", time: 1, prop: "opacity", value: 1 })), "E_ATTRIBUTE_INVALID");
});

test("mergeKeyframePoints junta volume e visuais por tempo", () => {
  const merged = mergeKeyframePoints(
    [{ time: 0, volume: 1 }],
    [
      { time: 0, values: { opacity: 0 }, curve: "linear" },
      { time: 1, values: { scaleX: 1.2, scaleY: 1.2, x: 10 }, curve: "suave" },
    ],
  );
  assert.deepEqual(merged, [
    { time: 0, volume: 1, opacity: 0 },
    { time: 1, scale: 1.2, x: 10, curve: "suave" },
  ]);
});
