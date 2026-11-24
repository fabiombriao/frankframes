// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChrome } from "../src/launch.ts";
import { startServer } from "../src/server.ts";
import { captureFramesInParallel, orderedFeeder, splitIntoBatches } from "../src/parallel.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FPS = { num: 30, den: 1 };
const VIEWPORT = { width: 1280, height: 720 };

test("splitIntoBatches: deduplica, ordena e fatia em lotes contíguos", () => {
  assert.deepEqual(splitIntoBatches([], 8), []);
  assert.deepEqual(splitIntoBatches([0], 8), [[0]]);
  assert.deepEqual(splitIntoBatches([5, 1, 3, 3, 0, 2, 4], 3), [[0, 1, 2], [3, 4, 5]]);
  const frames = [...Array(1000).keys()];
  const batches = splitIntoBatches(frames, 8);
  assert.equal(batches.length, 125);
  assert.deepEqual(batches.flat(), frames, "os lotes não cobrem a entrada em ordem");
  assert.deepEqual(splitIntoBatches([0, 1, 2], 0), [[0], [1], [2]], "tamanho inválido vira 1");
});

/** Pausa que deixa microtarefas e timers pendentes rodarem. */
const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("orderedFeeder: empurra em ordem mesmo com chegada embaralhada", async () => {
  const pushed: number[] = [];
  const feeder = orderedFeeder<string>(async (index, data) => {
    assert.equal(data, `d${index}`);
    pushed.push(index);
  }, 6, { maxBuffered: 6 });
  for (const index of [3, 1, 0, 5, 2, 4]) await feeder.add(index, `d${index}`);
  await feeder.finish();
  assert.deepEqual(pushed, [0, 1, 2, 3, 4, 5]);
});

test("orderedFeeder: o que está à frente da janela espera até a cauda andar (buffer limitado)", async () => {
  const release: Array<() => void> = [];
  const pushed: number[] = [];
  const feeder = orderedFeeder<number>(
    (index) =>
      new Promise<void>((resolve) => {
        pushed.push(index);
        release.push(resolve);
      }),
    10,
    { maxBuffered: 3 },
  );
  await feeder.add(0, 0); // entra e já vai para o push (em voo, ainda conta na janela)
  await feeder.add(2, 2);
  let admitted = false;
  const far = feeder.add(3, 3).then(() => {
    admitted = true;
  });
  await tick();
  assert.equal(admitted, false, "índice 3 com próximo=0 e janela 3 deveria esperar");
  release.shift()?.(); // o push do 0 termina: próximo=1, janela cobre até 3
  await far;
  assert.equal(admitted, true);
  await feeder.add(1, 1);
  // o resto sai em ordem, um push por vez
  for (let i = 0; i < 3; i += 1) {
    await tick();
    release.shift()?.();
  }
  await tick();
  assert.deepEqual(pushed, [0, 1, 2, 3]);
});

test("orderedFeeder: falha do push derruba add, finish e quem esperava", async () => {
  const boom = new Error("pipe quebrou");
  const feeder = orderedFeeder<number>(async () => {
    throw boom;
  }, 4, { maxBuffered: 2 });
  await feeder.add(0, 0);
  await tick();
  await assert.rejects(feeder.add(1, 1), (error) => error === boom);
  await assert.rejects(feeder.finish(), (error) => error === boom);

  const waiting = orderedFeeder<number>(() => new Promise<void>(() => undefined), 8, { maxBuffered: 2 });
  await waiting.add(0, 0);
  const blocked = waiting.add(5, 5);
  await tick();
  waiting.fail(new Error("capturou mal"));
  await assert.rejects(blocked, /capturou mal/);
});

test("orderedFeeder: valida faixa, repetido e frame que nunca chega", async () => {
  const feeder = orderedFeeder<number>(() => new Promise<void>(() => undefined), 3, { maxBuffered: 8 });
  await assert.rejects(feeder.add(3, 3), RangeError);
  await assert.rejects(feeder.add(-1, 0), RangeError);
  await feeder.add(2, 2);
  await assert.rejects(feeder.add(2, 2), /duas vezes/);

  const missing = orderedFeeder<number>(async () => undefined, 3, { maxBuffered: 8 });
  await missing.add(0, 0);
  await missing.add(2, 2);
  await assert.rejects(missing.finish(), /faltou o frame 1/);
});

test("orderedFeeder: com lotes pegos em ordem por vários workers não trava e respeita a janela", async () => {
  const total = 200;
  const batches = splitIntoBatches([...Array(total).keys()], 8);
  const pushed: number[] = [];
  let slowest = 0;
  const feeder = orderedFeeder<number>(
    async (index) => {
      slowest = Math.max(slowest, index);
      pushed.push(index);
      if (index % 13 === 0) await tick(1);
    },
    total,
    { maxBuffered: 16 },
  );
  let claimed = 0;
  const worker = async (id: number): Promise<void> => {
    while (claimed < batches.length) {
      const batch = batches[claimed++] as number[];
      for (const frame of batch) {
        await tick(id % 3); // ritmos diferentes embaralham a chegada
        await feeder.add(frame, frame);
      }
    }
  };
  await Promise.all([0, 1, 2, 3, 4, 5].map(worker));
  await feeder.finish();
  assert.deepEqual(pushed, [...Array(total).keys()]);
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
      batchSize: 4,
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

test("workers padrão respeitam CPU, memória e o teto de 8", async () => {
  const { defaultWorkerCount } = await import("../src/parallel.ts");
  assert.equal(defaultWorkerCount(64, 64 * 1024 ** 3), 8, "muitos núcleos: teto 8");
  assert.equal(defaultWorkerCount(8, 64 * 1024 ** 3), 4);
  assert.equal(defaultWorkerCount(4, 64 * 1024 ** 3), 2, "mínimo 2");
  assert.equal(defaultWorkerCount(32, 2 * 1024 ** 3), 2, "memória limita a 2");
  assert.equal(defaultWorkerCount(2, 1 * 1024 ** 3), 2);
});
