// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserError, classifyFailure, retryOnceIfTransient } from "../src/failures.ts";

test("classifica falha de browser fechado como transiente e repetível", () => {
  assert.deepEqual(
    { kind: classifyFailure(new Error("Protocol error (Page.captureScreenshot): TargetCloseError")).kind, retryable: classifyFailure(new Error("TargetCloseError")).retryable },
    { kind: "transient", retryable: true },
  );
});

test("erro de autoria e de imagem nunca é repetido", () => {
  assert.equal(classifyFailure(new Error("data-start inválido em fedora")).retryable, false);
  assert.equal(classifyFailure(new Error("Image 3 failed to load")).kind, "verification");
  assert.equal(classifyFailure(new Error("ENOENT: no such file or directory")).kind, "io");
  assert.equal(classifyFailure(new Error("something odd")).kind, "unknown");
});

test("retryOnceIfTransient repete uma vez só em falha transiente", async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error("TargetCloseError");
    return "ok";
  };
  assert.equal(await retryOnceIfTransient(flaky), "ok");
  assert.equal(calls, 2);
});

test("retryOnceIfTransient não repete erro não transiente", async () => {
  let calls = 0;
  await assert.rejects(
    retryOnceIfTransient(async () => {
      calls++;
      throw new Error("data-start inválido");
    }),
  );
  assert.equal(calls, 1);
});

test("E_BROWSER_TIMEOUT é falha de tempo, com código próprio e nunca repetida às cegas", () => {
  const timeout = classifyFailure(new Error("E_BROWSER_TIMEOUT: o seek do frame 3 passou de 60 s sem responder (hint)"));
  assert.equal(timeout.kind, "timeout");
  assert.equal(timeout.code, "E_BROWSER_TIMEOUT");
  assert.equal(timeout.retryable, false);
});

test("E_BROWSER_CLOSED segue a regra de queda do browser: uma repetição no render", () => {
  const closed = classifyFailure(new BrowserError("E_BROWSER_CLOSED", "o Chrome caiu", "rode de novo"));
  assert.equal(closed.kind, "transient");
  assert.equal(closed.retryable, true);
});

test("E_FONT_LOAD é erro de autoria e não se repete, mesmo com 'network error' na mensagem", () => {
  const font = classifyFailure(new Error("E_FONT_LOAD: fonte declarada não carregou: Roboto: A network error occurred"));
  assert.equal(font.kind, "authoring");
  assert.equal(font.code, "E_FONT_LOAD");
  assert.equal(font.retryable, false);
});

test("BrowserError carrega código e hint, e a mensagem começa pelo código", () => {
  const error = new BrowserError("E_BROWSER_TIMEOUT", "demorou", "aumente o prazo");
  assert.equal(error.code, "E_BROWSER_TIMEOUT");
  assert.equal(error.hint, "aumente o prazo");
  assert.equal(error.message, "E_BROWSER_TIMEOUT: demorou (aumente o prazo)");
});
