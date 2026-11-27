// FrankFrames — proprietário. Ver LICENSE na raiz.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadComposition } from "@frankframes/contract";
import { faceComposition, trackFaces } from "../src/face-tracks.ts";

const face = (x: number, y = 0.2) => ({ x, y, width: 0.12, height: 0.25, score: 0.9 });

test("rastreio conserva os lados e mantém o recorte durante uma detecção perdida", () => {
  const tracks = trackFaces([
    { time: 0, faces: [face(0.2), face(0.72)] },
    { time: 0.25, faces: [face(0.69)] },
    { time: 0.5, faces: [face(0.34, 0.34), face(0.65)] },
  ], 16 / 9);
  assert.equal(tracks.left.found, 2);
  assert.equal(tracks.right.found, 3);
  assert.equal(tracks.left.keys[0]!.focusX, tracks.left.keys[1]!.focusX);
  assert.ok(tracks.left.keys[2]!.focusX > tracks.left.keys[1]!.focusX);
  assert.ok(tracks.left.keys.every(({ focusX }) => focusX < tracks.right.keys[0]!.focusX));
  assert.ok(tracks.right.keys[2]!.focusX < tracks.right.keys[0]!.focusX);
});

test("rastreio não adivinha um segundo participante ausente", () => {
  assert.throws(() => trackFaces([{ time: 0, faces: [face(0.15)] }], 16 / 9), /lado direita/);
});

test("reframe gera um retrato válido com as duas trilhas e áudio único", () => {
  const tracks = trackFaces([{ time: 0, faces: [face(0.15), face(0.72)] }], 16 / 9);
  const html = faceComposition("assets/source.mp4", 15.25, 2, tracks, true);
  const composition = loadComposition(html);
  assert.ok(composition.ok, JSON.stringify(composition.diagnostics));
  assert.equal(composition.width, 1080);
  assert.equal(composition.height, 1920);
  assert.match(html, /id="rosto-superior"[^>]*object-position:100% 50%/);
  assert.equal(html.match(/data-has-audio="false"/g)?.length, 1);
  assert.equal(html.match(/data-offset="15.25"/g)?.length, 2);
});
