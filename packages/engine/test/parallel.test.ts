// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChrome } from "../src/launch.ts";
import { startServer } from "../src/server.ts";
import { captureFramesInParallel, splitIntoChunks } from "../src/parallel.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FPS = { num: 30, den: 1 };
const VIEWPORT = { width: 1280, height: 720 };

function assertBalancedChunks(frames: number[], chunks: number[][], workers: number): void {
  assert.ok(chunks.length <= workers, "usou mais blocos que workers");
  assert.deepEqual(chunks.flat(), frames, "blocos não são contíguos ou não cobrem a entrada");
  for (const chunk of chunks) assert.ok(chunk.length > 0, "bloco vazio");
  const sizes = chunks.map((chunk) => chunk.length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, "blocos desequilibrados");
}

test("splitIntoChunks: 1 frame", () => {
  const frames = [0];
  const chunks = splitIntoChunks(frames, 1);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks, [[0]]);
});

test("splitIntoChunks: 30 frames com 7 workers", () => {
  const frames = [...Array(30).keys()];
  const chunks = splitIntoChunks(frames, 7);
  assertBalancedChunks(frames, chunks, 7);
});

test("splitIntoChunks: 1000 frames com 7 workers", () => {
  const frames = [...Array(1000).keys()];
  const chunks = splitIntoChunks(frames, 7);
  assertBalancedChunks(frames, chunks, 7);
  assert.equal(chunks.length, 7);
});

test("captureFramesInParallel: 1 worker e 3 workers produzem os mesmos hashes", { timeout: 900_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    t.skip("Chrome não encontrado");
    return;
  }

  const frames = [...Array(30).keys()];
  const server = await startServer(FIXTURES);
  try {
    const serial = await captureFramesInParallel({
      url: server.url,
      viewport: VIEWPORT,
      gpu: "software",
      fps: FPS,
      frames,
      workers: 1,
    });

    // `onFrame` deve entregar cada frame pedido uma única vez, com PNG válido.
    const seen = new Map<number, number>();
    const parallel = await captureFramesInParallel({
      url: server.url,
      viewport: VIEWPORT,
      gpu: "software",
      fps: FPS,
      frames: [...frames].reverse(),
      workers: 3,
      onFrame: (frame, png) => {
        seen.set(frame, (seen.get(frame) ?? 0) + 1);
        assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `PNG inválido no frame ${frame}`);
      },
    });

    assert.equal(serial.size, frames.length, "faltou frame no modo serial");
    assert.equal(parallel.size, frames.length, "faltou frame no modo paralelo");
    assert.deepEqual([...seen.keys()].sort((a, b) => a - b), frames, "onFrame não recebeu os frames pedidos");
    assert.deepEqual([...seen.values()], Array(frames.length).fill(1), "onFrame chamado mais de uma vez por frame");
    const divergent = frames.filter((frame) => serial.get(frame) !== parallel.get(frame));
    assert.deepEqual(divergent, [], "hash divergente entre 1 e 3 workers");
    assert.equal(new Set(serial.values()).size, frames.length, "todos os frames iguais — fixture não animou");
  } finally {
    await server.close();
  }
});
