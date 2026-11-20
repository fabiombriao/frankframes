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
