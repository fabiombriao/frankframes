// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseStep, clampZoom, floorMs, frameCount, isFrameLevel, lastFrameTime, nextTrack, packLanes, peakSlice, roundToFrame, snap, snapToFrame, snapMove, tickLabel, trackRows, zoomAround } from "../src/studio/timeline-math.js";

test("frameCount arredonda para cima e nunca devolve menos de 1", () => {
  assert.equal(frameCount(3, 30), 90);
  assert.equal(frameCount(0.5, 30), 15);
  assert.equal(frameCount(0, 30), 1);
});

test("lastFrameTime é o início do último frame, não o fim da composição", () => {
  assert.equal(lastFrameTime(3, 30), 89 / 30);
  assert.equal(lastFrameTime(1 / 30, 30), 0);
});

test("roundToFrame alinha ao frame mais próximo", () => {
  assert.equal(roundToFrame(1.01, 30), 30 / 30);
  assert.equal(roundToFrame(0.5, 30), 15 / 30);
});

test("chooseStep no zoom máximo dá passos múltiplos de 1/fps e marca frames", () => {
  const { major, minor } = chooseStep(30 * 48, 30);
  assert.equal(isFrameLevel(30 * 48, 30), true);
  for (const step of [major, minor]) {
    const frames = step * 30;
    assert.ok(Math.abs(frames - Math.round(frames)) < 1e-9, `${step}s não é múltiplo de 1/30`);
  }
  assert.ok(major >= minor && Math.abs(major / minor - Math.round(major / minor)) < 1e-9, "major múltiplo de minor");
  assert.equal(tickLabel(65 / 30, 30, true), "2:05");
  assert.equal(tickLabel(1.5, 30, false), "1,5s");
});

test("chooseStep afastado dá major de pelo menos 1 s e traço menor só quando cabe", () => {
  const far = chooseStep(10, 30);
  assert.ok(far.major >= 1, `major ${far.major}`);
  assert.equal(isFrameLevel(10, 30), false);
  const near = chooseStep(100, 30);
  assert.ok(near.major * 100 >= 80);
  assert.ok(near.minor <= near.major);
});

test("chooseStep em todo o intervalo mantém o espaçamento legível e frames inteiros no nível de frame", () => {
  for (const fps of [24, 30, 60]) {
    for (let pps = 2; pps <= fps * 48; pps *= 1.37) {
      const { major, minor } = chooseStep(pps, fps);
      assert.ok(major > 0 && minor > 0 && minor <= major, `pps ${pps} fps ${fps}`);
      if (isFrameLevel(pps, fps)) {
        assert.ok(Math.abs(major * fps - Math.round(major * fps)) < 1e-9, `major ${major} @ ${fps}`);
        assert.ok(Math.abs(minor * fps - Math.round(minor * fps)) < 1e-9, `minor ${minor} @ ${fps}`);
        assert.ok(Math.abs(major / minor - Math.round(major / minor)) < 1e-9, "major múltiplo de minor");
      }
    }
  }
});

test("clampZoom fica entre ajustar e 1 frame = 48 px, mesmo com composição curta", () => {
  assert.equal(clampZoom(1, { fitPps: 20, fps: 30 }), 20);
  assert.equal(clampZoom(5000, { fitPps: 20, fps: 30 }), 1440);
  assert.equal(clampZoom(300, { fitPps: 20, fps: 30 }), 300);
  assert.equal(clampZoom(10, { fitPps: 4000, fps: 30 }), 1440, "ajustar acima do máximo não inverte os limites");
});

test("zoomAround mantém o instante sob o ponteiro parado", () => {
  const pps = 60;
  const scrollLeft = 200;
  const pointerX = 340;
  const anchorTime = (scrollLeft + pointerX) / pps;
  const result = zoomAround(pps, 1.15, anchorTime, pointerX);
  assert.ok(Math.abs(result.pps - 69) < 1e-9);
  assert.ok(Math.abs(anchorTime * result.pps - result.scrollLeft - (anchorTime * pps - scrollLeft)) < 1e-9);
  assert.equal(zoomAround(60, 0.01, 1, 500).scrollLeft, 0, "scrollLeft nunca fica negativo");
});

test("peakSlice recorta a janela do clip na fonte, com offset e velocidade", () => {
  const peaks = Array.from({ length: 500 }, (_, index) => index % 256);
  const waveform = { peaksPerSecond: 100, peaks };
  const slice = peakSlice(waveform, 1, 2, 1.5);
  assert.equal(slice.length, 300, "índices 100…400");
  assert.equal(slice[0], peaks[100]);
  assert.equal(slice.at(-1), peaks[399]);
  assert.deepEqual(peakSlice(waveform, 4.9, 5, 1), peaks.slice(490), "corta no fim da fonte");
  assert.deepEqual(peakSlice(waveform, 9, 1, 1), [], "além da fonte não sobra nada");
});

test("EDT-44: snap gruda no candidato dentro do limiar e só nele", () => {
  assert.deepEqual(snap(1.03, [1, 2], 0.05), { t: 1, guide: 1 });
  assert.deepEqual(snap(1.2, [1], 0.05), { t: 1.2, guide: null });
  assert.deepEqual(snap(1.5, [], 0.05), { t: 1.5, guide: null });
  // Escolhe o mais próximo quando há dois ao alcance.
  assert.deepEqual(snap(1.04, [1, 1.05], 0.1), { t: 1.05, guide: 1.05 });
});

test("EDT-44: o limiar de 8 px vale no zoom máximo e no ajustar", () => {
  const max = 30 * 48; // 1 frame = 48 px
  const thresholdMax = 8 / max;
  assert.ok(thresholdMax < 1 / 30, "no zoom máximo o ímã é menor que um frame");
  assert.deepEqual(snap(1 + 4 / max, [1], thresholdMax), { t: 1, guide: 1 }, "4 px do alvo gruda");
  assert.deepEqual(snap(1 + 9 / max, [1], thresholdMax), { t: 1 + 9 / max, guide: null }, "9 px do alvo solta");
  const fit = 10; // composição longa: 10 px/s
  assert.deepEqual(snap(30.5, [30], 8 / fit), { t: 30, guide: 30 }, "5 px do alvo gruda");
  assert.deepEqual(snap(31, [30], 8 / fit), { t: 31, guide: null }, "10 px do alvo solta");
});

test("EDT-44: snapMove usa a borda direita quando ela é a mais próxima", () => {
  // Clip de 1 s começando em 2.97: a esquerda está a 0.03 de 3 e a direita (3.97) a 0.03 de 4.
  assert.deepEqual(snapMove(2.97, 1, [3], 0.05), { t: 3, guide: 3 });
  assert.deepEqual(snapMove(2.98, 1, [4], 0.05), { t: 3, guide: 4 });
  assert.deepEqual(snapMove(2.5, 1, [4], 0.05), { t: 2.5, guide: null });
});

test("EDT-44: packLanes abre sub-raia só quando há sobreposição de verdade", () => {
  const a = { id: "a", start: 0, end: 2 };
  const b = { id: "b", start: 1, end: 3 };
  assert.equal(packLanes([a, b]).length, 2);
  assert.deepEqual(packLanes([a, b]).map((lane) => lane.map((clip) => clip.id)), [["a"], ["b"]]);
  assert.equal(packLanes([{ start: 0, end: 1 }, { start: 1, end: 2 }]).length, 1, "encostar não é sobrepor");
  assert.equal(packLanes([]).length, 0);
  // Reaproveita a raia livre: a, b sobrepostos e c depois do fim de a volta para a raia 0.
  const lanes = packLanes([a, b, { id: "c", start: 2, end: 4 }]);
  assert.deepEqual(lanes.map((lane) => lane.map((clip) => clip.id)), [["a", "c"], ["b"]]);
});

test("EDT-44: trackRows ordena V0,T1,T0,A0,A1 como T1,T0,V0,A0,A1", () => {
  const clips = [
    { id: "v0", kind: "video", track: 0, start: 0, end: 1 },
    { id: "t1", kind: "text", track: 1, start: 0, end: 1 },
    { id: "t0", kind: "text", track: 0, start: 0, end: 1 },
    { id: "a1", kind: "audio", track: 1, start: 0, end: 1 },
    { id: "a0", kind: "audio", track: 0, start: 0, end: 1 },
  ];
  const rows = trackRows(clips);
  assert.deepEqual(rows.map((row) => row.label), ["T1", "T0", "V0", "A0", "A1"]);
  assert.deepEqual(rows.map((row) => row.group), ["visual", "visual", "visual", "audio", "audio"]);
  // Vídeo em faixa maior fica acima de texto em faixa menor.
  assert.deepEqual(trackRows([clips[0]!, { kind: "video", track: 2 }, clips[2]!]).map((row) => row.label), ["V2", "T0", "V0"]);
});

test("EDT-44: trackRows junta clips do mesmo par e separa em sub-raias", () => {
  const rows = trackRows([
    { id: "a", kind: "video", track: 1, start: 0, end: 2 },
    { id: "b", kind: "video", track: 1, start: 1, end: 3 },
    { id: "c", kind: "video", track: 1, start: 5, end: 6 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.clips.length, 3);
  assert.equal(rows[0]!.lanes.length, 2);
});

test("EDT-44: nextTrack é maxVisual + 1 (ou maxAudio + 1) e 0 em grupo vazio", () => {
  const clips = [
    { kind: "video", track: 1 },
    { kind: "text", track: 3 },
    { kind: "audio", track: 4 },
  ];
  assert.equal(nextTrack(clips, "visual"), 4);
  assert.equal(nextTrack(clips, "audio"), 5);
  assert.equal(nextTrack([], "visual"), 0);
  assert.equal(nextTrack([{ kind: "audio", track: 2 }], "visual"), 0);
});

test("EDT-44: sem ímã o tempo vai ao frame, truncado em ms para não cortar o primeiro frame", () => {
  assert.equal(floorMs(2 / 30), 0.066);
  assert.equal(snapToFrame(0.07, 30), 0.066); // frame 2 = 0,0667 s
  assert.equal(snapToFrame(1.01, 30), 1);
  assert.equal(snapToFrame(0.5, 30), 0.5);
  // Em 60 fps o frame 1 (0,01667 s) vira 0,016: o clip ainda começa dentro do frame 1.
  assert.ok(snapToFrame(0.0167, 60) <= 1 / 60);
});
