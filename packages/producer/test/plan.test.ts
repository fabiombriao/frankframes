// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadComposition } from "@frankframes/contract";
import { frameCountFor, timedClips } from "../src/render.ts";

test("frameCountFor inclui o frame parcial do fim", () => {
  assert.equal(frameCountFor(1.5, { num: 30, den: 1 }), 45);
  assert.equal(frameCountFor(4, { num: 30, den: 1 }), 120);
  assert.equal(frameCountFor(4.016, { num: 30, den: 1 }), 121, "120,48 frames precisam de 121 capturas");
  assert.equal(frameCountFor(0.0001, { num: 30, den: 1 }), 1);
  assert.equal(frameCountFor(1, { num: 30000, den: 1001 }), 30);
});

test("timedClips devolve início absoluto para mídia dentro de sub-composição", () => {
  const composition = loadComposition(`<div data-composition-id="main" data-root="true" data-duration="6">
    <div data-clip-id="a" data-start="0.5" data-duration="1"></div>
    <div data-composition-id="card" data-start="2" data-duration="3">
      <video data-clip-id="v" data-start="0.5" data-duration="1" src="v.mp4"></video>
    </div>
  </div>`);
  assert.equal(composition.ok, true);

  const timed = timedClips(composition);
  assert.deepEqual(timed.map((item) => [item.clip.id, item.start]), [["a", 0.5], ["card", 2], ["v", 2.5]]);
});
