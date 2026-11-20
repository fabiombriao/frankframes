// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAiCompatible } from "../src/openai.ts";

function listen(server: Server): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") resolve(address.port);
    else reject(new Error("porta indisponível"));
  });
  return promise;
}

function close(server: Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => (error ? reject(error) : resolve()));
  return promise;
}

async function readBody(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function withInput<T>(run: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ff-openai-test-"));
  const file = join(dir, "audio.wav");
  await writeFile(file, Buffer.from("RIFFfake-wave-data"));
  try {
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("envia multipart, autorização e converte segments/words", async () => {
  let authorization = "";
  let body = "";
  let url = "";
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization ?? "";
    url = request.url ?? "";
    body = await readBody(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        text: "Olá mundo.",
        segments: [
          { start: 0, end: 1.5, text: "Olá" },
          { start: 1.5, end: 2.75, text: "mundo." },
        ],
        words: [
          { start: 0, end: 0.6, word: "Olá" },
          { start: 0.6, end: 1.5, word: "mundo." },
        ],
      }),
    );
  });
  const port = await listen(server);

  try {
    await withInput(async (file) => {
      const transcriber = createOpenAiCompatible({
        name: "fake",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "segredo",
        model: "whisper-test",
      });
      const result = await transcriber.transcribe(file, { language: "pt" });

      assert.equal(url, "/v1/audio/transcriptions");
      assert.equal(authorization, "Bearer segredo");
      assert.match(body, /name="file"; filename="audio\.wav"/);
      assert.match(body, /name="model"\r\n\r\nwhisper-test/);
      assert.match(body, /name="response_format"\r\n\r\nverbose_json/);
      assert.match(body, /name="language"\r\n\r\npt/);

      assert.equal(result.provider, "fake");
      assert.equal(result.text, "Olá mundo.");
      assert.deepEqual(result.segments, [
        { start: 0, end: 1.5, text: "Olá" },
        { start: 1.5, end: 2.75, text: "mundo." },
      ]);
      assert.deepEqual(result.words, [
        { start: 0, end: 0.6, word: "Olá" },
        { start: 0.6, end: 1.5, word: "mundo." },
      ]);
    });
  } finally {
    await close(server);
  }
});

test("resposta sem segments mantém text e devolve lista vazia", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ text: "apenas texto" }));
  });
  const port = await listen(server);

  try {
    await withInput(async (file) => {
      const transcriber = createOpenAiCompatible({
        name: "fake",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: "segredo",
        model: "whisper-test",
      });
      const result = await transcriber.transcribe(file);
      assert.equal(result.text, "apenas texto");
      assert.deepEqual(result.segments, []);
      assert.equal(result.words, undefined);
    });
  } finally {
    await close(server);
  }
});

test("erro HTTP 401 cita o status e trunca o corpo em 300 caracteres", async () => {
  const longBody = "x".repeat(1000);
  const server = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "text/plain" });
    response.end(longBody);
  });
  const port = await listen(server);

  try {
    await withInput(async (file) => {
      const transcriber = createOpenAiCompatible({
        name: "fake",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: "errada",
        model: "whisper-test",
      });
      await assert.rejects(
        () => transcriber.transcribe(file),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok("code" in error);
          assert.equal(error.code, "E_OPENAI_HTTP");
          assert.match(error.message, /401/);
          assert.ok(error.message.includes("x".repeat(300)));
          assert.ok(!error.message.includes("x".repeat(301)));
          return true;
        },
      );
    });
  } finally {
    await close(server);
  }
});
