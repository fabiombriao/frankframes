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

const fontMessage = (faces: string[], tail = ""): string =>
  `E_FONT_LOAD: fonte declarada não carregou: ${faces.join("; ")} (confira o src do @font-face, caminho e arquivo, ou a fonte em vendor/fonts)${tail}`;

test("E_FONT_LOAD só de rede, sem falha registrada pelo servidor, é transiente e repetível (EDT-72)", () => {
  const failure = classifyFailure(
    new Error(
      fontMessage([
        "Montserrat (peso 400, estilo normal): A network error occurred.",
        "Poppins (peso 600, estilo normal): A network error occurred.",
      ]),
    ),
  );
  assert.deepEqual({ kind: failure.kind, code: failure.code, retryable: failure.retryable }, { kind: "transient", code: "E_FONT_LOAD", retryable: true });
});

test("E_FONT_LOAD de autoria nunca é repetido: servidor registrou falha ou a causa não é só rede (EDT-72)", () => {
  const network = "Montserrat (peso 400, estilo normal): A network error occurred.";
  // O servidor registrou o 404 da fonte: o arquivo é o problema.
  const annotated = classifyFailure(new Error(fontMessage([network], " [servidor: ENOENT ao ler /nao-existe.woff2 (1 falha(s), sem sucesso)]")));
  assert.deepEqual({ kind: annotated.kind, retryable: annotated.retryable }, { kind: "authoring", retryable: false });
  // Uma das faces chegou e não decodifica: erro de autoria mesmo sem registro do servidor.
  const decode = classifyFailure(new Error(fontMessage([network, "Quebrada (peso normal, estilo normal): A font data decoding error occurred."])));
  assert.deepEqual({ kind: decode.kind, retryable: decode.retryable }, { kind: "authoring", retryable: false });
});

test("retryOnceIfTransient avisa a causa da primeira tentativa e a segunda falha é a que sobe (EDT-72)", async () => {
  const causes: string[] = [];
  let calls = 0;
  await assert.rejects(
    retryOnceIfTransient(
      async () => {
        calls += 1;
        throw new Error(fontMessage(["Poppins (peso 600, estilo normal): A network error occurred."], ` tentativa ${calls}`));
      },
      (cause) => causes.push(cause.code),
    ),
    /tentativa 2$/,
  );
  assert.equal(calls, 2);
  assert.deepEqual(causes, ["E_FONT_LOAD"]);
});

test("BrowserError carrega código e hint, e a mensagem começa pelo código", () => {
  const error = new BrowserError("E_BROWSER_TIMEOUT", "demorou", "aumente o prazo");
  assert.equal(error.code, "E_BROWSER_TIMEOUT");
  assert.equal(error.hint, "aumente o prazo");
  assert.equal(error.message, "E_BROWSER_TIMEOUT: demorou (aumente o prazo)");
});
