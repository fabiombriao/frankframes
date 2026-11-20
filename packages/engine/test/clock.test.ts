// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { injectClock } from "../src/clock.ts";

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
