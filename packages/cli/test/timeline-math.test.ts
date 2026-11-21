// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { frameCount, lastFrameTime, roundToFrame } from "../src/studio/timeline-math.js";

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
