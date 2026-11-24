// FrankFrames — proprietário. Ver LICENSE na raiz.
// Player do Studio segue a raiz (EDT-87): o viewport do iframe é `data-width` × `data-height`, escalado sem cortar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { resolveChrome } from "@frankframes/engine";
import { startStudio } from "../src/studio-server.ts";
import { runInit } from "../src/onboarding.ts";
import { fitPlayerBox, playerViewport } from "../src/studio/player-fit.js";
import { withTempDir } from "../../../scripts/test-support/temp.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

test("EDT-87: playerViewport lê a raiz e cai no padrão do render só no que falta", () => {
  assert.deepEqual(playerViewport({ width: 1080, height: 1920 }), { width: 1080, height: 1920 });
  assert.deepEqual(playerViewport({ width: 1080 }), { width: 1080, height: 1080 });
  assert.deepEqual(playerViewport({}), { width: 1920, height: 1080 });
  assert.deepEqual(playerViewport(null), { width: 1920, height: 1080 });
  assert.deepEqual(playerViewport({ width: 0, height: -5 }), { width: 1920, height: 1080 });
});

test("EDT-87: fitPlayerBox usa uma escala só, centraliza e não corta nem estica", () => {
  // Bloco vertical num painel largo: a altura manda; sobra espaço dos lados (era o defeito: quadro fixo em 16:9).
  const vertical = fitPlayerBox({ width: 700, height: 540 }, { width: 1080, height: 1920 });
  assert.equal(vertical.scale, 540 / 1920);
  assert.equal(vertical.frameHeight, 540);
  assert.ok(Math.abs(vertical.frameWidth / vertical.frameHeight - 9 / 16) < 1e-9, "proporção da raiz");
  assert.equal(vertical.top, 0);
  assert.ok(Math.abs(vertical.left - (700 - vertical.frameWidth) / 2) < 1e-9);

  // Horizontal num painel alto: a largura manda.
  const wide = fitPlayerBox({ width: 400, height: 900 }, { width: 1920, height: 1080 });
  assert.equal(wide.scale, 400 / 1920);
  assert.equal(wide.frameWidth, 400);
  assert.ok(Math.abs(wide.top - (900 - wide.frameHeight) / 2) < 1e-9);

  // Nunca passa do espaço livre.
  for (const [w, h] of [[1920, 1080], [1080, 1920], [1080, 1080], [3840, 2160]] as const) {
    const box = fitPlayerBox({ width: 733, height: 417 }, { width: w, height: h });
    assert.ok(box.frameWidth <= 733 + 1e-9 && box.frameHeight <= 417 + 1e-9, `${w}x${h} cabe`);
    assert.ok(box.left >= -1e-9 && box.top >= -1e-9);
  }

  assert.throws(() => fitPlayerBox({ width: 0, height: 100 }, { width: 1920, height: 1080 }), /espaço do player inválido/);
  assert.throws(() => fitPlayerBox({ width: 100, height: 100 }, { width: 0, height: 1080 }), /viewport do player inválido/);
});

test("EDT-87: o servidor do Studio serve /player-fit.js e o app o importa", () =>
  withTempDir("ff-studio-fit-serve-", async (dir) => {
    await runInit(dir);
    const server = await startStudio({ entry: join(dir, "index.html") });
    try {
      const served = await fetch(`${server.url}player-fit.js`);
      assert.equal(served.status, 200);
      assert.match(served.headers.get("content-type") ?? "", /javascript/);
      assert.match(await served.text(), /export function fitPlayerBox/);
      assert.match(await (await fetch(`${server.url}app.js`)).text(), /from "\/player-fit\.js"/);
    } finally {
      await server.close();
    }
  }));

test("EDT-87: o init não fixa o #stage em CSS: o tamanho vem da raiz", () =>
  withTempDir("ff-init-stage-", async (dir) => {
    const target = join(dir, "novo");
    await runInit(target);
    const html = await readFile(join(target, "index.html"), "utf8");
    const rule = /#stage\s*\{([^}]*)\}/.exec(html);
    assert.ok(rule, "o starter define #stage");
    assert.doesNotMatch(rule[1] as string, /\b(width|height)\s*:\s*\d+px/, "largura/altura em px criaria uma segunda fonte de tamanho");
    assert.match(rule[1] as string, /width:\s*100vw/);
    assert.match(rule[1] as string, /height:\s*100vh/);
  }));

test("EDT-87: com um bloco vertical o iframe tem o viewport 1080x1920 e o quadro, a proporção da raiz", async (t) => {
  try {
    await resolveChrome();
  } catch (error) {
    t.skip(`Chrome indisponível: ${(error as Error).message}`);
    return;
  }
  await withTempDir("ff-studio-fit-", async (dir) => {
    const blockDir = join(ROOT, "catalog", "blocks", "vertical-lower-third");
    const entry = join(dir, "index.html");
    await mkdir(dir, { recursive: true });
    await copyFile(join(blockDir, "index.html"), entry);
    const server = await startStudio({ entry });
    const chrome = await resolveChrome();
    const browser = await puppeteer.launch({ executablePath: chrome.path, headless: true, args: ["--no-sandbox"], defaultViewport: { width: 1600, height: 900 } });
    try {
      const page = await browser.newPage();
      await page.goto(server.url, { waitUntil: "domcontentloaded" });
      const read = (): Promise<{ iframeW: number; iframeH: number; frameW: number; frameH: number; panelW: number; panelH: number; left: number; top: number }> =>
        page.evaluate(() => {
          const frame = document.getElementById("playerFrame") as HTMLElement;
          const iframe = document.getElementById("player") as HTMLIFrameElement;
          const panel = document.getElementById("playerPanel") as HTMLElement;
          const f = frame.getBoundingClientRect();
          const p = panel.getBoundingClientRect();
          return {
            iframeW: iframe.offsetWidth,
            iframeH: iframe.offsetHeight,
            frameW: f.width,
            frameH: f.height,
            panelW: p.width,
            panelH: p.height,
            left: f.left - p.left,
            top: f.top - p.top,
          };
        });
      await page.waitForFunction(() => (document.getElementById("player") as HTMLIFrameElement).offsetWidth === 1080, { timeout: 15_000 });
      const vertical = await read();
      assert.equal(vertical.iframeW, 1080, "viewport do iframe = data-width");
      assert.equal(vertical.iframeH, 1920, "viewport do iframe = data-height");
      assert.ok(Math.abs(vertical.frameW / vertical.frameH - 1080 / 1920) < 0.01, `quadro na proporção da raiz: ${vertical.frameW}x${vertical.frameH}`);
      assert.ok(vertical.frameW <= vertical.panelW && vertical.frameH <= vertical.panelH, "cabe no painel sem corte");
      assert.ok(vertical.left >= 0 && vertical.top >= 0);

      // Editar a raiz pelo inspetor de Composição muda o player na hora, sem recarregar a página.
      assert.match(await readFile(entry, "utf8"), /data-width="1080" data-height="1920"/);
      await page.click("#compositionButton");
      await page.$eval("#compWidth", (input) => {
        (input as HTMLInputElement).value = "1920";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.$eval("#compHeight", (input) => {
        (input as HTMLInputElement).value = "1080";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.click("#compositionApply");
      await page.waitForFunction(() => (document.getElementById("player") as HTMLIFrameElement).offsetWidth === 1920, { timeout: 15_000 });
      const wide = await read();
      assert.equal(wide.iframeH, 1080);
      assert.ok(Math.abs(wide.frameW / wide.frameH - 16 / 9) < 0.01, `quadro 16:9: ${wide.frameW}x${wide.frameH}`);
    } finally {
      await browser.close();
      await server.close();
    }
  });
});
