// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLocal, installLocalModel } from "../src/local.ts";

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

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

const PAYLOAD = "ABCDEFGH";
const PAYLOAD_SHA256 = createHash("sha256").update(PAYLOAD).digest("hex");

test("installLocalModel grava os bytes e cria diretórios", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-model-test-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": String(PAYLOAD.length) });
    response.end(PAYLOAD);
  });
  const port = await listen(server);

  try {
    const destPath = join(dir, "nested", "models", "ggml-test.bin");
    const result = await installLocalModel({
      modelUrl: `http://127.0.0.1:${port}/model.bin`,
      destPath,
      expectedSha256: PAYLOAD_SHA256,
    });

    assert.equal(result.path, destPath);
    assert.equal(result.bytes, 8);
    assert.equal((await readFile(destPath, "utf8")), PAYLOAD);
    assert.equal((await stat(destPath)).size, 8);
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("installLocalModel com SHA-256 errado apaga o temporário e não cria o destino", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-model-bad-"));
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.end(PAYLOAD);
  });
  const port = await listen(server);

  try {
    const destPath = join(dir, "models", "ggml-test.bin");
    await assert.rejects(
      () =>
        installLocalModel({
          modelUrl: `http://127.0.0.1:${port}/model.bin`,
          destPath,
          expectedSha256: "0".repeat(64),
        }),
      (error: unknown) => hasErrorCode(error, "E_MODEL_HASH"),
    );
    await assert.rejects(() => stat(destPath));
    assert.deepEqual(await readdir(dirname(destPath)), []);
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("createLocal sem binário lança E_WHISPER_MISSING", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-whisper-missing-"));
  try {
    const file = join(dir, "audio.wav");
    await writeFile(file, "RIFF");
    const transcriber = createLocal({
      whisperBin: join(dir, "nao-existe", "whisper-cli.exe"),
      modelPath: join(dir, "nao-existe.bin"),
    });
    await assert.rejects(
      () => transcriber.transcribe(file),
      (error: unknown) => hasErrorCode(error, "E_WHISPER_MISSING"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
