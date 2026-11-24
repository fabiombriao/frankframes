// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSession, openSessionFor, resolveChrome, startServer } from "../src/index.ts";
import type { GpuMode, ResolvedGpuMode } from "../src/args.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FPS = { num: 30, den: 1 };
const FRAMES = Number(process.env.FF_FRAMES ?? 60);

interface Run {
  hashes: Map<number, string>;
  gpu: ResolvedGpuMode;
  renderer: string;
}

async function captureRun(order: number[], gpu: GpuMode): Promise<Run> {
  const server = await startServer(FIXTURES);
  const session = await openSessionFor(server, { url: server.url, viewport: { width: 1280, height: 720 }, gpu });
  const hashes = new Map<number, string>();
  try {
    for (const frame of order) {
      await session.seekFrame(frame, FPS);
      const { sha256 } = await session.capture();
      hashes.set(frame, sha256);
    }
    assert.deepEqual(session.pageErrors(), [], "a página lançou erro durante a captura");
    return { hashes, gpu: session.gpu, renderer: session.renderer };
  } finally {
    await session.close();
    await server.close();
  }
}

async function gate(mode: GpuMode): Promise<void> {
  const order = [...Array(FRAMES).keys()];
  const first = await captureRun(order, mode);
  const second = await captureRun(order, mode);
  const reversed = await captureRun([...order].reverse(), mode);

  const divergent = order.filter(
    (f) => first.hashes.get(f) !== second.hashes.get(f) || first.hashes.get(f) !== reversed.hashes.get(f),
  );
  assert.deepEqual(divergent.slice(0, 10), [], `${mode}: frames divergentes entre execuções`);
  assert.equal(
    new Set(first.hashes.values()).size,
    FRAMES,
    `${mode}: todos os frames iguais — a composição não animou, o teste não prova nada`,
  );
  process.stdout.write(`\n  ${mode} -> ${first.gpu} · ${first.renderer}\n`);
}

test("determinismo no caminho padrão (auto): 2 execuções + ordem invertida", { timeout: 900_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    t.skip("Chrome não encontrado");
    return;
  }
  await gate("auto");
});

test("determinismo em software: garantia entre máquinas", { timeout: 900_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    t.skip("Chrome não encontrado");
    return;
  }
  await gate("software");
});

test("determinismo em hardware forçado", { timeout: 900_000, skip: process.env.FF_GPU !== "1" }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    t.skip("Chrome não encontrado");
    return;
  }
  await gate("hardware");
});

/** Esperas de paint por frame, frames 1..5, com o contador de `FRANKFRAMES_CAPTURE_PROFILE=1`. */
async function settlesPerFrame(gpu: GpuMode): Promise<{ settles: number[]; resolved: string }> {
  // O contador em `__ff.settleCount` só existe com FRANKFRAMES_CAPTURE_PROFILE=1.
  const previous = process.env.FRANKFRAMES_CAPTURE_PROFILE;
  process.env.FRANKFRAMES_CAPTURE_PROFILE = "1";
  const server = await startServer(FIXTURES);
  try {
    const session = await openSessionFor(server, { url: server.url, viewport: { width: 640, height: 360 }, gpu });
    try {
      const settles: number[] = [];
      for (let frame = 0; frame < 6; frame += 1) {
        const before = await session.evaluate<number>("globalThis.__ff.settleCount");
        await session.seekFrame(frame, FPS);
        await session.capture();
        settles.push((await session.evaluate<number>("globalThis.__ff.settleCount")) - before);
      }
      // Frame 0 é a primeira captura da sessão (aquece e exige 3 leituras iguais): fica fora da regra.
      return { settles: settles.slice(1), resolved: session.gpu };
    } finally {
      await session.close();
    }
  } finally {
    if (previous === undefined) delete process.env.FRANKFRAMES_CAPTURE_PROFILE;
    else process.env.FRANKFRAMES_CAPTURE_PROFILE = previous;
    await server.close();
  }
}

test("captura em software: uma espera de paint por frame (o seek assenta; capture não repete)", { timeout: 120_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    t.skip("Chrome não encontrado");
    return;
  }
  const { settles, resolved } = await settlesPerFrame("software");
  assert.equal(resolved, "software");
  assert.deepEqual(settles, [1, 1, 1, 1, 1], `esperas de paint por frame (frames 1..5): ${settles.join(",")}`);
});

test("captura em hardware: uma espera de paint por frame (EDT-77)", { timeout: 120_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    t.skip("Chrome não encontrado");
    return;
  }
  // `auto` resolve para hardware quando existe GPU utilizável; sem ela o teste não tem o que provar.
  const result = await settlesPerFrame("auto");
  if (result.resolved !== "hardware") {
    t.skip(`GPU resolvida como ${result.resolved}: não há hardware nesta máquina`);
    return;
  }
  assert.deepEqual(result.settles, [1, 1, 1, 1, 1], `esperas de paint por frame (frames 1..5): ${result.settles.join(",")}`);
});
