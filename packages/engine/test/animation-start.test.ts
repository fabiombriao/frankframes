// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession, resolveChrome, startServer } from "../src/index.ts";

const FPS = { num: 30, den: 1 };
const VIEWPORT = { width: 640, height: 360 };
// Animações CSS com atrasos e durações diferentes: no meio do carregamento umas já
// terminaram e outras não. Os frames amostrados caem depois do fim de todas.
const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#0b0b0f;color:#f2efe6;font:700 44px/1.1 sans-serif}
  .t{position:absolute;left:40px;top:40px;animation:rise .7s ease-out both;animation-delay:.15s}
  .i{position:absolute;left:40px;animation:slide .7s cubic-bezier(.22,.8,.2,1) both}
  .i:nth-of-type(2){top:130px;animation-delay:.3s}
  .i:nth-of-type(3){top:190px;animation-delay:.8s}
  .i:nth-of-type(4){top:250px;animation-delay:1.3s}
  @keyframes rise{from{transform:translateY(24px);opacity:0}to{transform:translateY(0);opacity:1}}
  @keyframes slide{from{transform:translateX(-38px);opacity:0}to{transform:translateX(0);opacity:1}}
</style></head><body>
<div data-composition-id="anim" data-root="true" data-width="640" data-height="360" data-fps="30" data-duration="4">
  <div class="t">Nesta edição.</div>
  <div class="i">A sala às seis</div>
  <div class="i">O corte que faltou</div>
  <div class="i">A ordem certa</div>
</div></body></html>`;

async function chromeOrSkip(t: TestContext): Promise<boolean> {
  try {
    await resolveChrome();
    return true;
  } catch {
    t.skip("Chrome não encontrado");
    return false;
  }
}

/** Abre a página, espera `idleMs` de tempo real e captura os frames pedidos. */
async function capture(dir: string, idleMs: number, frames: number[]): Promise<string[]> {
  const server = await startServer(dir, { page: { path: "index.html", html: HTML } });
  const session = await openSession({ url: `${server.url}index.html`, viewport: VIEWPORT, gpu: "software", captureShots: 3 });
  try {
    await new Promise((resolve) => setTimeout(resolve, idleMs));
    const hashes: string[] = [];
    for (const frame of frames) {
      await session.seekFrame(frame, FPS);
      hashes.push((await session.capture()).sha256);
    }
    assert.deepEqual(session.pageErrors(), []);
    return hashes;
  } finally {
    await session.close();
    await server.close();
  }
}

test("animações CSS ficam congeladas no tempo 0 desde a prontidão: o pixel não depende de quanto tempo real passou", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;

  const dir = await mkdtemp(join(tmpdir(), "ff-anim-start-"));
  const frames = [12, 36, 60, 84, 108];
  const quick = await capture(dir, 0, frames);
  const slow = await capture(dir, 2500, frames); // todas as animações terminariam em tempo real
  assert.deepEqual(slow, quick, "o raster mudou porque as animações correram em tempo real antes do primeiro seek");
});

test("a prontidão pausa as animações em 0 antes do primeiro seek", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;

  const dir = await mkdtemp(join(tmpdir(), "ff-anim-paused-"));
  const server = await startServer(dir, { page: { path: "index.html", html: HTML } });
  const session = await openSession({ url: `${server.url}index.html`, viewport: VIEWPORT, gpu: "software" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const states = await session.evaluate<Array<[string, number]>>(
      "document.getAnimations().map((a) => [a.playState, Number(a.currentTime)])",
    );
    assert.equal(states.length, 4);
    for (const [state, time] of states) {
      assert.equal(state, "paused");
      assert.equal(time, 0, "ainda no tempo 0: só o seek move as animações");
    }
  } finally {
    await session.close();
    await server.close();
  }
});
