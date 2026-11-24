// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, decideUpgrade, latestPublished } from "../src/upgrade.ts";

test("comparação de versões cobre patch, minor e major", () => {
  assert.ok(compareVersions("0.1.0", "0.1.1") < 0);
  assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("1.0.0", "1.0.0") === 0);
  assert.ok(compareVersions("0.9.9", "1.0.0") < 0);
});

test("decisão de upgrade cobre os quatro casos", () => {
  assert.equal(decideUpgrade("0.1.0", null), "não publicado");
  assert.equal(decideUpgrade("0.1.0", "0.1.0"), "atualizado");
  assert.equal(decideUpgrade("0.1.0", "0.2.0"), "atualizar");
  assert.equal(decideUpgrade("0.3.0", "0.2.0"), "versão local mais nova");
});

const jsonResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("latestPublished: 404 do registro é 'não publicado' (null); 200 devolve a versão", async () => {
  assert.equal(await latestPublished(async () => jsonResponse(404, { error: "Not found" })), null);
  assert.equal(await latestPublished(async () => jsonResponse(200, { version: "1.2.3" })), "1.2.3");
});

test("latestPublished: falha de rede NÃO vira 'não publicado': lança com a URL e o motivo", async () => {
  const offline: typeof fetch = async () => {
    throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND registry.npmjs.org") });
  };
  await assert.rejects(latestPublished(offline), (error: unknown) => {
    const message = (error as Error).message;
    return message.includes("registry.npmjs.org/@frankframes%2Fcli/latest") && message.includes("ENOTFOUND") && message.includes("conexão");
  });
});

test("latestPublished: HTTP de erro e resposta sem version lançam", async () => {
  await assert.rejects(latestPublished(async () => jsonResponse(503, {})), /HTTP 503/);
  await assert.rejects(latestPublished(async () => jsonResponse(200, {})), /sem o campo version/);
});
