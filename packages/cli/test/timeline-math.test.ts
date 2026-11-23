// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseStep, clampZoom, frameCount, isFrameLevel, lastFrameTime, peakSlice, roundToFrame, tickLabel, zoomAround } from "../src/studio/timeline-math.js";

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
