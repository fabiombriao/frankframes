// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession, resolveChrome, startServer } from "../src/index.ts";

const COMPOSITION = `<html><head><style>
  .b { position: fixed; top: 0; left: 0; width: 40px; height: 40px; background: #ff2d55; animation: m 3s linear infinite; }
  @keyframes m { to { transform: translateX(400px); } }
</style></head><body>
  <div data-composition-id="ui" data-root="true" data-duration="3"><div class="b"></div></div>
</body></html>`;

const SHORT = `<html><head><style>
  .b { position: fixed; top: 0; left: 0; width: 40px; height: 40px; background: #ff2d55; }
</style></head><body>
  <div data-composition-id="curta" data-root="true" data-duration="0.5"><div class="b"></div></div>
</body></html>`;

/** Preview de 15 frames a 30 fps (500 ms); o último frame começa em 14 × 1000/30 ms. */
async function withShortPreview(
  t: { skip: (reason: string) => void },
  run: (session: Awaited<ReturnType<typeof openSession>>) => Promise<void>,
): Promise<void> {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }
  const dir = await mkdtemp(join(tmpdir(), "ff-ui-short-"));
  await writeFile(join(dir, "index.html"), SHORT);
  const server = await startServer(dir, { live: true, preview: { fps: { num: 30, den: 1 }, frames: 15 } });
  const session = await openSession({ url: server.url, viewport: { width: 480, height: 270 }, gpu: "auto" });
  try {
    await run(session);
  } finally {
    await session.close();
    await server.close();
  }
}

const LAST_FRAME_MS = (14 * 1000) / 30;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("relógio ao vivo para no último frame e fica nele", { timeout: 60_000 }, (t) =>
  withShortPreview(t, async (session) => {
    await sleep(1200); // 500 ms de composição; o resto é folga
    const now = await session.evaluate<number>("window.__ff.now()");
    assert.ok(Math.abs(now - LAST_FRAME_MS) < 0.001, `deveria parar em ${LAST_FRAME_MS} ms, obtido ${now}`);
    assert.equal(await session.evaluate<boolean>("window.__ff.playing()"), false);
    assert.equal(await session.evaluate<string>(`document.querySelector("[data-ff-play]").textContent`), "play");
    const stored = await session.evaluate<number[]>(
      `Object.keys(sessionStorage).filter((key) => key.startsWith("__ffTime")).map((key) => Number(sessionStorage.getItem(key)))`,
    );
    for (const value of stored) assert.ok(value <= 467, `sessionStorage nunca acima do último frame, obtido ${value}`);
  }));

test("Play no fim recomeça do início", { timeout: 60_000 }, (t) =>
  withShortPreview(t, async (session) => {
    await sleep(1200);
    await session.evaluate(`document.querySelector("[data-ff-play]").click()`);
    await sleep(120);
    const now = await session.evaluate<number>("window.__ff.now()");
    assert.ok(now < 200, `Play no fim precisa recomeçar do 0, obtido ${Math.round(now)} ms`);
    assert.equal(await session.evaluate<boolean>("window.__ff.playing()"), true);
  }));

test("Loop volta ao início sem parar", { timeout: 60_000 }, (t) =>
  withShortPreview(t, async (session) => {
    await sleep(1200);
    await session.evaluate(`document.querySelector("[data-ff-loop]").click()`);
    assert.equal(await session.evaluate<string>(`document.querySelector("[data-ff-loop]").getAttribute("aria-pressed")`), "true");
    await session.evaluate(`document.querySelector("[data-ff-play]").click()`);
    await sleep(1200); // mais de duas voltas
    assert.equal(await session.evaluate<boolean>("window.__ff.playing()"), true, "em loop o relógio não para");
    const now = await session.evaluate<number>("window.__ff.now()");
    assert.ok(now < 500, `em loop o tempo nunca passa do fim, obtido ${Math.round(now)} ms`);
  }));

test("carregar a barra do preview não lança exceção", { timeout: 60_000 }, (t) =>
  withShortPreview(t, async (session) => {
    assert.deepEqual(session.pageErrors(), []);
  }));

test("barra do preview: pausa, scrub por frame e #f na URL", { timeout: 120_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  const dir = await mkdtemp(join(tmpdir(), "ff-ui-"));
  await writeFile(join(dir, "index.html"), COMPOSITION);

  const server = await startServer(dir, { live: true, preview: { fps: { num: 30, den: 1 }, frames: 90 } });
  const session = await openSession({ url: server.url, viewport: { width: 480, height: 270 }, gpu: "auto" });
  try {
    const hasBar = await session.evaluate<boolean>(`!!document.querySelector("[data-ff-ui]")`);
    assert.equal(hasBar, true, "preview precisa da barra de controle");

    await session.evaluate(`document.querySelector("[data-ff-play]").click()`);
    const atPause = await session.evaluate<number>("window.__ff.now()");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterPause = await session.evaluate<number>("window.__ff.now()");
    assert.ok(Math.abs(afterPause - atPause) < 60, `pausado, o relógio não pode andar (${Math.round(atPause)} → ${Math.round(afterPause)})`);

    await session.evaluate(`(() => {
      const range = document.querySelector("[data-ff-scrub]");
      range.value = "30";
      range.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    const seeked = await session.evaluate<number>("window.__ff.now()");
    assert.ok(Math.abs(seeked - 1000) < 50, `frame 30 a 30 fps = 1000 ms, obtido ${Math.round(seeked)}`);
    assert.equal(await session.evaluate<string>("location.hash"), "#f=30");

    await session.evaluate(`document.querySelector("[data-ff-play]").click()`);
    const playing = await session.evaluate<number>("window.__ff.now()");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const advanced = await session.evaluate<number>("window.__ff.now()");
    assert.ok(advanced > playing + 100, "play precisa voltar a andar");
  } finally {
    await session.close();
    await server.close();
  }
});
