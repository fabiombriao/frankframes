// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession, openSessionFor, resolveChrome, startServer } from "../src/index.ts";

const COMPOSITION = `<html><head><style>
  .b { position: fixed; top: 0; left: 0; width: 50px; height: 50px; background: #f00; animation: m 4s linear infinite; }
  @keyframes m { to { transform: translateX(600px); } }
</style></head><body>
  <div data-composition-id="live" data-root="true" data-duration="4">
    <div class="b"></div>
    <div data-clip-id="late" data-start="1" data-duration="2" data-ff-start="1000" data-ff-end="3000">tarde</div>
  </div>
</body></html>`;

/** Espera a condição real (relógio do preview), não um tempo adivinhado. */
async function waitForClock(session: Awaited<ReturnType<typeof openSession>>, target: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const now = await session.evaluate<number>("window.__ff.now()");
    if (now >= target) return now;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`relógio do preview não chegou a ${target} ms`);
}

test("preview roda em tempo real e respeita a janela dos clips", { timeout: 120_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  const dir = await mkdtemp(join(tmpdir(), "ff-live-"));
  await writeFile(join(dir, "index.html"), COMPOSITION);

  const server = await startServer(dir, { live: true });
  const session = await openSessionFor(server, { url: server.url, viewport: { width: 640, height: 360 }, gpu: "auto" });
  try {
    const visibility = await session.evaluate<string>(
      `getComputedStyle(document.querySelector('[data-clip-id="late"]')).visibility`,
    );
    const first = await session.evaluate<number>("window.__ff.now()");
    assert.equal(visibility, "hidden", "clip que começa em 1 s não pode aparecer aos ~0 s");

    const second = await waitForClock(session, first + 300);
    assert.ok(second >= first + 300, `relógio do preview precisa avançar sozinho (${Math.round(first)} → ${Math.round(second)})`);

    await waitForClock(session, 1_200);
    const later = await session.evaluate<string>(
      `getComputedStyle(document.querySelector('[data-clip-id="late"]')).visibility`,
    );
    assert.equal(later, "visible", "depois de 1 s o clip precisa aparecer");

    const beforeReload = await session.evaluate<number>("window.__ff.now()");
    await session.reload();
    const resumed = await waitForClock(session, 1);
    assert.ok(
      resumed >= beforeReload - 200,
      `recarregar precisa voltar ao mesmo instante, não ao zero (${Math.round(beforeReload)} → ${Math.round(resumed)})`,
    );

    const errors = await session.evaluate<string[]>("window.__ff.liveErrors");
    assert.deepEqual(errors, [], "laço do preview não pode engolir erro");
  } finally {
    await session.close();
    await server.close();
  }
});

test("falha ao gravar o instante em sessionStorage vai para liveErrors, uma vez só", { timeout: 120_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  const dir = await mkdtemp(join(tmpdir(), "ff-live-storage-"));
  await writeFile(join(dir, "index.html"), COMPOSITION);

  const server = await startServer(dir, { live: true });
  const session = await openSessionFor(server, { url: server.url, viewport: { width: 640, height: 360 }, gpu: "auto" });
  try {
    // Storage cheio/bloqueado: o setItem passa a lançar, e o relógio recomeça já com isso.
    await session.evaluate(
      `Storage.prototype.setItem = function () { throw new Error("quota cheia"); }; window.__ff.stopLive(); window.__ff.startLive(0);`,
    );
    await waitForClock(session, 900); // ≥ 3 ticks de persistência (a cada 250 ms)
    const errors = await session.evaluate<string[]>("window.__ff.liveErrors");
    assert.equal(errors.length, 1, `a falha aparece uma vez, sem inundar: ${JSON.stringify(errors)}`);
    assert.match(errors[0] ?? "", /sessionStorage.*quota cheia/);
  } finally {
    await session.close();
    await server.close();
  }
});
