// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openSession, openSessionFor, resolveChrome, startServer } from "../src/index.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

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
  t: TestContext,
  run: (session: Awaited<ReturnType<typeof openSession>>) => Promise<void>,
  autoplay?: boolean,
): Promise<void> {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }
  const dir = await tempDir(t, "ff-ui-short-");
  await writeFile(join(dir, "index.html"), SHORT);
  const server = await startServer(dir, { live: true, preview: { fps: { num: 30, den: 1 }, frames: 15, ...(autoplay === undefined ? {} : { autoplay }) } });
  const session = await openSessionFor(server, { url: server.url, viewport: { width: 480, height: 270 }, gpu: "auto" });
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

/** Para o relógio num instante e recarrega, como o Studio faz depois de uma edição. */
async function stopAtAndReload(session: Awaited<ReturnType<typeof openSession>>, ms: number): Promise<void> {
  await session.evaluate(`window.__ff.stopLive(); window.__ff.seek(${ms})`);
  await session.reload();
}

test("EDT-76: preview parado em t volta parado em t depois de recarregar", { timeout: 60_000 }, (t) =>
  withShortPreview(t, async (session) => {
    await stopAtAndReload(session, 200);
    // Sem o estado de play salvo, o preview religava e corria até o fim (LAST_FRAME_MS) em ~300 ms.
    await sleep(700);
    const now = await session.evaluate<number>("window.__ff.now()");
    assert.ok(Math.abs(now - 200) <= 1000 / 30, `deveria continuar em 200 ms, obtido ${Math.round(now)}`);
    assert.equal(await session.evaluate<boolean>("window.__ff.playing()"), false);
    assert.equal(await session.evaluate<string>(`document.querySelector("[data-ff-play]").textContent`), "play");
    assert.deepEqual(await session.evaluate<string[]>("window.__ff.liveErrors"), []);
    // Recarregar de novo, sem mexer, não perde nem desloca o instante.
    await session.reload();
    const again = await session.evaluate<number>("window.__ff.now()");
    assert.ok(Math.abs(again - 200) <= 1000 / 30, `segunda recarga: obtido ${Math.round(again)}`);
  }));

test("EDT-76: preview tocando continua tocando depois de recarregar", { timeout: 60_000 }, (t) =>
  withShortPreview(t, async (session) => {
    await session.evaluate(`window.__ff.stopLive(); window.__ff.seek(50); window.__ff.startLive(50)`);
    await session.reload();
    assert.equal(await session.evaluate<boolean>("window.__ff.playing()"), true);
    const now = await session.evaluate<number>("window.__ff.now()");
    assert.ok(now >= 50 - 1000 / 30, `não pode recomeçar antes do instante salvo, obtido ${Math.round(now)}`);
  }));

test("EDT-76: instante salvo além do fim vira o último frame, não 0", { timeout: 60_000 }, (t) =>
  withShortPreview(t, async (session) => {
    // Composição encurtada por uma edição: o instante antigo (9 s) passa do fim novo (500 ms).
    // O pagehide da barra grava o instante real; o nosso roda depois e deixa o valor antigo.
    await session.evaluate(`window.__ff.stopLive(); window.addEventListener("pagehide", () => {
      sessionStorage.setItem("__ffTime:preview", "9000");
      sessionStorage.setItem("__ffPlaying:preview", "0");
    })`);
    await session.reload();
    const now = await session.evaluate<number>("window.__ff.now()");
    assert.ok(Math.abs(now - LAST_FRAME_MS) < 0.001, `deveria ir ao último frame, obtido ${now}`);
    assert.equal(await session.evaluate<boolean>("window.__ff.playing()"), false);
  }));

test("EDT-76: instante salvo inválido aparece em liveErrors", { timeout: 60_000 }, (t) =>
  withShortPreview(t, async (session) => {
    await session.evaluate(`window.__ff.stopLive(); window.addEventListener("pagehide", () => sessionStorage.setItem("__ffTime:preview", "abc"))`);
    await session.reload();
    const errors = await session.evaluate<string[]>("window.__ff.liveErrors");
    assert.ok(
      errors.some((message) => message.includes("instante salvo inválido")),
      `valor inválido precisa aparecer em liveErrors, obtido ${JSON.stringify(errors)}`,
    );
  }));

test("EDT-76: o instante salvo vale mais que o #f velho da URL na recarga", { timeout: 60_000 }, (t) =>
  withShortPreview(t, async (session) => {
    // Scrub na barra deixa "#f=3"; depois um seek vindo de fora (timeline do Studio) move o instante.
    await session.evaluate(`(() => {
      const range = document.querySelector("[data-ff-scrub]");
      range.value = "3";
      range.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    assert.equal(await session.evaluate<string>("location.hash"), "#f=3");
    await stopAtAndReload(session, 300);
    const now = await session.evaluate<number>("window.__ff.now()");
    assert.ok(Math.abs(now - 300) <= 1000 / 30, `deveria ficar em 300 ms, e não no #f=3 (100 ms), obtido ${Math.round(now)}`);
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

  const dir = await tempDir(t, "ff-ui-");
  await writeFile(join(dir, "index.html"), COMPOSITION);

  const server = await startServer(dir, { live: true, preview: { fps: { num: 30, den: 1 }, frames: 90 } });
  const session = await openSessionFor(server, { url: server.url, viewport: { width: 480, height: 270 }, gpu: "auto" });
  try {
    const hasBar = await session.evaluate<boolean>(`!!document.querySelector("[data-ff-ui]")`);
    assert.equal(hasBar, true, "preview precisa da barra de controle");

    await session.evaluate(`document.querySelector("[data-ff-play]").click()`);
    const atPause = await session.evaluate<number>("window.__ff.now()");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterPause = await session.evaluate<number>("window.__ff.now()");
    assert.ok(Math.abs(afterPause - atPause) < 60, `pausado, o relógio não pode andar (${Math.round(atPause)} → ${Math.round(afterPause)})`);

    // Como no Studio, a página tem <base href>: o "#f=" não pode mudar o caminho do documento.
    const pathBefore = await session.evaluate<string>("location.pathname");
    await session.evaluate(`document.head.insertAdjacentHTML("afterbegin", '<base href="/__ff_site/">')`);
    await session.evaluate(`(() => {
      const range = document.querySelector("[data-ff-scrub]");
      range.value = "30";
      range.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    const seeked = await session.evaluate<number>("window.__ff.now()");
    assert.ok(Math.abs(seeked - 1000) < 50, `frame 30 a 30 fps = 1000 ms, obtido ${Math.round(seeked)}`);
    assert.equal(await session.evaluate<string>("location.hash"), "#f=30");
    assert.equal(await session.evaluate<string>("location.pathname"), pathBefore, "o scrub não pode trocar o caminho do documento");

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

/** Pointerdown sintético na barra, a `fraction` da largura (0 = ponta esquerda, 1 = ponta direita); `outside` px além da ponta. */
function pointerDownAt(fraction: number, outside = 0): string {
  return `(() => {
    const range = document.querySelector("[data-ff-scrub]");
    const box = range.getBoundingClientRect();
    const x = box.left + box.width * ${fraction} + (${fraction} >= 1 ? ${outside} : -${outside});
    range.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: box.top + box.height / 2 }));
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x }));
  })()`;
}

test("EDT-85: clique na borda esquerda da barra vai ao frame 0 e na direita ao último", { timeout: 60_000 }, (t) =>
  withShortPreview(t, async (session) => {
    await session.evaluate(`window.__ff.stopLive(); window.__ff.seek(200)`);

    await session.evaluate(pointerDownAt(0.5));
    const middle = await session.evaluate<number>("window.__ff.now()");
    assert.ok(middle > 100 && middle < 400, `o meio da barra fica no meio, obtido ${Math.round(middle)} ms`);

    await session.evaluate(pointerDownAt(1));
    assert.ok(Math.abs((await session.evaluate<number>("window.__ff.now()")) - LAST_FRAME_MS) < 0.001, "borda direita = último frame");
    assert.equal(await session.evaluate<string>("location.hash"), "#f=14");
    assert.equal(await session.evaluate<string>(`document.querySelector("[data-ff-scrub]").value`), "14");

    await session.evaluate(pointerDownAt(0));
    assert.equal(await session.evaluate<number>("window.__ff.now()"), 0, "borda esquerda = frame 0, nunca o 1");
    assert.equal(await session.evaluate<string>("location.hash"), "#f=0");
    assert.equal(await session.evaluate<string>(`document.querySelector("[data-ff-scrub]").value`), "0");

    // Soltar o ponteiro além das pontas também trava nelas.
    await session.evaluate(pointerDownAt(1, 30));
    assert.ok(Math.abs((await session.evaluate<number>("window.__ff.now()")) - LAST_FRAME_MS) < 0.001);
    await session.evaluate(pointerDownAt(0, 30));
    assert.equal(await session.evaluate<number>("window.__ff.now()"), 0);
  }));

test("EDT-85: Studio (autoplay false) abre pausado em 0 e fica parado", { timeout: 60_000 }, (t) =>
  withShortPreview(
    t,
    async (session) => {
      await sleep(600); // 500 ms de composição: se o relógio estivesse ligado, já teria chegado ao fim
      assert.equal(await session.evaluate<boolean>("window.__ff.playing()"), false);
      assert.equal(await session.evaluate<number>("window.__ff.now()"), 0);
      assert.equal(await session.evaluate<string>(`document.querySelector("[data-ff-play]").textContent`), "play");
      assert.deepEqual(await session.evaluate<string[]>("window.__ff.liveErrors"), []);
    },
    false,
  ));

test("EDT-85: Studio recarregado (edição) restaura o instante e o play salvos", { timeout: 60_000 }, (t) =>
  withShortPreview(
    t,
    async (session) => {
      await stopAtAndReload(session, 200);
      await sleep(400);
      const now = await session.evaluate<number>("window.__ff.now()");
      assert.ok(Math.abs(now - 200) <= 1000 / 30, `a recarga mantém o instante, obtido ${Math.round(now)}`);
      assert.equal(await session.evaluate<boolean>("window.__ff.playing()"), false);

      await session.evaluate(`window.__ff.startLive(200)`);
      await session.reload();
      assert.equal(await session.evaluate<boolean>("window.__ff.playing()"), true, "tocando antes da recarga, toca depois");
    },
    false,
  ));
