// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { installBlockFromUrl } from "../src/remote.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const HTML = `<html><body><div data-composition-id="card" data-root="true" data-width="640" data-height="360" data-fps="30" data-duration="2">
  <div data-clip-id="a" data-start="0" data-duration="2">olá</div>
</div></body></html>`;

async function serve(files: Record<string, string>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const body = files[(request.url ?? "/").replace(/^\//, "")];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": request.url?.endsWith(".json") ? "application/json" : "text/html" }).end(body);
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

test("instala bloco remoto quando o hash confere", async (t) => {
  const digest = createHash("sha256").update(HTML).digest("hex");
  const server = await serve({
    "meta.json": JSON.stringify({ name: "Card", summary: "teste", durationSeconds: 2, tags: [], slug: "card", sha256: digest }),
    "index.html": HTML,
  });
  try {
    const dir = await tempDir(t, "ff-remote-");
    const installed = await installBlockFromUrl(server.url, dir);
    assert.equal(installed.sha256, digest);
    assert.equal((await readFile(join(dir, "index.html"), "utf8")), HTML);
    assert.ok((await stat(join(dir, "meta.json"))).size > 0);
  } finally {
    await server.close();
  }
});

test("recusa bloco sem hash ou com conteúdo adulterado", async (t) => {
  const digest = createHash("sha256").update(HTML).digest("hex");
  const semHash = await serve({ "meta.json": JSON.stringify({ name: "Card" }), "index.html": HTML });
  try {
    await assert.rejects(installBlockFromUrl(semHash.url, await tempDir(t, "ff-remote-")), /não declara sha256/);
  } finally {
    await semHash.close();
  }

  const adulterado = await serve({
    "meta.json": JSON.stringify({ name: "Card", sha256: digest }),
    "index.html": HTML.replace("olá", "alterado"),
  });
  try {
    await assert.rejects(installBlockFromUrl(adulterado.url, await tempDir(t, "ff-remote-")), /sha256 não confere/);
  } finally {
    await adulterado.close();
  }
});
