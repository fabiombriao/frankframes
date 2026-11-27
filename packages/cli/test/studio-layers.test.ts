// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { resolveChrome } from "@frankframes/engine";
import { startStudio } from "../src/studio-server.ts";
import { withTempDir } from "../../../scripts/test-support/temp.ts";

const ENTRY = `<!doctype html>
<html lang="pt-BR"><head><style>
body { margin: 0; }
.card { position: absolute; left: 100px; top: 800px; box-sizing: border-box;
        width: 600px; height: 240px; padding: 30px; background: #332233; }
.card small { display: block; font-size: 29px; }
.block { position: absolute; left: 100px; top: 1100px; }
</style></head><body>
<main data-composition-id="camadas" data-width="1080" data-height="1920" data-fps="30" data-duration="5">
  <div class="card" data-clip-id="folha" data-start="0" data-duration="5" data-enter="erguer dur=0.4" data-exit="apagar dur=0.2"><small>Folha de pagamento</small><p><em>+</em> custo fixo</p></div>
  <div class="block" data-clip-id="bloco" data-composition-id="bloco" data-composition-src="bloco.html" data-start="0" data-duration="5"></div>
</main></body></html>`;
const BLOCK = '<!doctype html><html><body><div data-composition-id="bloco" data-duration="5"><b>Apoio</b></div></body></html>';

test("Camadas: seleciona título e cartão no preview, edita fonte, arrasta, redimensiona e salva no arquivo correto", { timeout: 45_000 }, async (t) => {
  const chrome = await resolveChrome().catch(() => null);
  if (chrome === null) return t.skip("Chrome indisponível");
  await withTempDir("ff-studio-layers-", async (dir) => {
    const entry = join(dir, "index.html");
    const block = join(dir, "bloco.html");
    await Promise.all([writeFile(entry, ENTRY), writeFile(block, BLOCK)]);
    const studio = await startStudio({ entry });
    const browser = await puppeteer.launch({ executablePath: chrome.path, headless: true, args: ["--no-sandbox"], defaultViewport: { width: 1280, height: 900 } });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(8_000);
      await page.goto(studio.url);
      const frame = await (await page.waitForSelector("#player"))!.contentFrame();
      assert.ok(frame);
      await frame.waitForSelector(".card[data-ff-studio-layer]");
      await frame.$eval("[data-ff-scrub]", (input) => {
        (input as HTMLInputElement).value = "60";
        input.dispatchEvent(new Event("input"));
      });
      await page.click("#layersButton");
      await page.waitForFunction(() => Array.from(document.querySelectorAll("#layerPicker option")).some((option) => option.textContent?.includes("Apoio")));
      const canvas = await (await page.$("#layerOverlay"))!.boundingBox();
      assert.ok(canvas);
      const scale = canvas.width / 1080;
      const onCanvas = (x: number, y: number) => ({ x: canvas.x + x * scale, y: canvas.y + y * scale });
      const title = onCanvas(145, 844);
      await page.mouse.click(title.x, title.y);
      const pickerLabel = () => page.$eval("#layerPicker", (element) => (element as HTMLSelectElement).selectedOptions[0]?.textContent);
      assert.match(await pickerLabel() ?? "", /Folha de pagamento/);
      const change = (name: string, value: string) => page.$eval(`[data-layer-property="${name}"]`, (element, next) => {
        (element as HTMLInputElement).value = next;
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
      await change("font-size", "50");
      await page.locator("#layerApply").click();
      await frame.waitForFunction(() => getComputedStyle(document.querySelector(".card small")!).fontSize === "50px");
      assert.match(await readFile(entry, "utf8"), /<small style="font-size: 50px;">Folha de pagamento<\/small>/);

      const background = onCanvas(112, 1005);
      await page.waitForFunction(() => !document.getElementById("layerPanel")!.hasAttribute("aria-busy"));
      await page.mouse.click(background.x, background.y);
      assert.equal(await pickerLabel(), "folha");
      const dragLayer = async (x: number, y: number, dx: number, dy: number) => {
        const written = page.waitForResponse((response) => response.url().endsWith("/api/layers") && response.request().method() === "POST");
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + dx, y + dy, { steps: 4 });
        await page.mouse.up();
        const response = await written;
        assert.ok(response.ok(), await response.text());
        await page.waitForFunction(() => !document.getElementById("layerPanel")!.hasAttribute("aria-busy"));
      };
      await dragLayer(background.x, background.y, 14, 9);
      await frame.waitForFunction(() => getComputedStyle(document.querySelector(".card")!).transform !== "none");

      const handle = await (await page.waitForSelector('[data-corner="se"]', { visible: true }))!.boundingBox();
      assert.ok(handle);
      await dragLayer(handle.x + handle.width / 2, handle.y + handle.height / 2, 16, 10);
      await frame.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector(".card")!).width) > 600);

      await change("background-color", "#648b24");
      await change("opacity", "0.5");
      await page.locator("#layerApply").click();
      await frame.waitForFunction(() => {
        const style = getComputedStyle(document.querySelector(".card")!);
        return style.opacity === "0.5" && style.backgroundColor === "rgb(100, 139, 36)";
      });
      await page.locator("#undoButton").click();
      await frame.waitForFunction(() => getComputedStyle(document.querySelector(".card")!).opacity === "1");
      assert.match(await readFile(entry, "utf8"), /width: 6[0-9]+(?:\.[0-9]+)?px/);

      const nested = await page.$$eval("#layerPicker option", (options) =>
        (options.find((option) => option.textContent?.includes("Apoio")) as HTMLOptionElement).value);
      await page.select("#layerPicker", nested);
      await page.$eval("#layerTextFields textarea", (element) => {
        (element as HTMLTextAreaElement).value = "Subcamada editada";
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.locator("#layerApply").click();
      await frame.waitForFunction(() => document.querySelector(".block b")?.textContent === "Subcamada editada");
      assert.equal(await readFile(block, "utf8"), BLOCK.replace("Apoio", "Subcamada editada"));
      assert.doesNotMatch(await readFile(entry, "utf8"), /data-ff-studio-layer|Subcamada editada/);
    } finally {
      await browser.close();
      await studio.close();
    }
  });
});
