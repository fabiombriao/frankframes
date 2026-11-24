// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { installLocalModel } from "../src/local.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const MODEL = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));

async function serveModel(seenRanges: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const range = request.headers.range;
    if (range) seenRanges.push(range);
    const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const slice = MODEL.subarray(start);
    response.writeHead(range ? 206 : 200, {
      "content-length": String(slice.byteLength),
      ...(range ? { "content-range": `bytes ${start}-${MODEL.length - 1}/${MODEL.length}` } : {}),
    });
    response.end(slice);
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/model.bin`,
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

test("retoma download parcial e verifica o hash", async (t) => {
  const ranges: string[] = [];
  const server = await serveModel(ranges);
  try {
    const dir = await tempDir(t, "ff-resume-");
    const dest = join(dir, "model.bin");
    await writeFile(`${dest}.part`, MODEL.subarray(0, 1024));

    const installed = await installLocalModel({ modelUrl: server.url, destPath: dest });

    assert.deepEqual(ranges, ["bytes=1024-"], "primeira requisição precisa pedir o restante");
    assert.equal(installed.bytes, MODEL.length);
    assert.equal(installed.sha256, createHash("sha256").update(MODEL).digest("hex"));
    assert.deepEqual(await readFile(dest), MODEL);
  } finally {
    await server.close();
  }
});

test("destino íntegro não baixa de novo", async (t) => {
  const ranges: string[] = [];
  const server = await serveModel(ranges);
  try {
    const dir = await tempDir(t, "ff-resume-");
    const dest = join(dir, "model.bin");
    await writeFile(dest, MODEL);
    const digest = createHash("sha256").update(MODEL).digest("hex");

    const installed = await installLocalModel({ modelUrl: server.url, destPath: dest, expectedSha256: digest });
    assert.equal(installed.bytes, MODEL.length);
    assert.deepEqual(ranges, [], "nada de rede quando o arquivo já está certo");
  } finally {
    await server.close();
  }
});
