// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { injectClock } from "../src/clock.ts";
import { injectionScript } from "../src/inject.ts";

test("o relógio entra antes de qualquer script da composição", () => {
  const html = `<html><head><script src="autor.js"></script></head><body><script>autor()</script></body></html>`;
  const output = injectClock(html);
  const clockAt = output.indexOf("__ff");
  assert.ok(clockAt > 0);
  assert.ok(clockAt < output.indexOf("autor.js"), "clock precisa rodar antes do script do autor");
  assert.equal(output.split("window.__ff =").length, 2, "clock injetado uma vez só");
});

test("injeta sem <head> e sem <html>", () => {
  assert.ok(injectClock("<div>x</div>").startsWith("<script>"));
  const noHead = injectClock('<html><body><script src="a.js"></script></body></html>');
  assert.ok(noHead.indexOf("__ff") < noHead.indexOf("a.js"));
});

const META = { fps: { num: 30, den: 1 }, frames: 3 };

test("a barra do preview abre /__ff_reload por padrão e não abre com reload:false", () => {
  assert.ok(injectionScript({ preview: META }).includes("__ff_reload"), "padrão recarrega por SSE");
  assert.ok(!injectionScript({ preview: { ...META, reload: false } }).includes("__ff_reload"), "o Studio recarrega pelo próprio canal");
});

test("a UI do preview é registrada como listener, sem chamar o retorno de addEventListener", () => {
  for (const reload of [undefined, false]) {
    const block = injectionScript({ preview: { ...META, reload } });
    // Último <script> é o da barra; o do relógio termina em `})();` legitimamente.
    const ui = block.slice(block.lastIndexOf("<script>"));
    assert.ok(ui.includes("DOMContentLoaded"), "o último script é o da barra");
    assert.ok(!/\}\)\(\);<\/script>$/.test(ui), "`})();` chama undefined e lança TypeError ao carregar");
    assert.ok(/\}\);<\/script>$/.test(ui));
  }
});
