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
