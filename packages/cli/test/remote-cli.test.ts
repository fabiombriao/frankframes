// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const BLOCK_HTML = fileURLToPath(new URL("../../../catalog/blocks/chapter-transition/index.html", import.meta.url));

const digestOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function serve(files: Record<string, Buffer | string>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const key = (request.url ?? "/").replace(/^\/+/, "");
    const body = files[key];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    // connection: close evita o reuso de socket, que faz o Node 24 (Windows) abortar no
    // process.exit logo após dois fetches (uv_async_send em handle fechando).
    response
      .writeHead(200, {
        "content-type": key.endsWith(".json") ? "application/json" : "text/html; charset=utf-8",
        connection: "close",
      })
      .end(body);
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

test("blocks add instala um bloco remoto com sha256 conferido", async (t) => {
  const html = await readFile(BLOCK_HTML);
  const sha256 = digestOf(html);
  const meta = { name: "Transição de capítulo", slug: "remoto", durationSeconds: 3.2, sha256 };
  const server = await serve({ "meta.json": JSON.stringify(meta), "index.html": html });

  const dir = await tempDir(t, "ff-remote-");
  const dest = join(dir, "bloco");

  try {
    const { stdout } = await run(process.execPath, [CLI, "blocks", "add", server.url, dest], {
      encoding: "utf8",
      cwd: dir,
    });

    assert.equal(digestOf(await readFile(join(dest, "index.html"))), sha256);
    assert.ok((await readFile(join(dest, "index.html"))).equals(html), "index.html instalado difere do servido");

    const installed = JSON.parse(await readFile(join(dest, "meta.json"), "utf8")) as { sha256: string; slug: string };
    assert.equal(installed.sha256, sha256);
    assert.equal(installed.slug, "remoto");

    assert.ok(stdout.includes(sha256.slice(0, 12)), `stdout não cita o hash: ${stdout}`);
  } finally {
    await server.close();
  }
});

test("blocks add recusa conteúdo adulterado", async (t) => {
  const html = await readFile(BLOCK_HTML);
  const server = await serve({
    "meta.json": JSON.stringify({ name: "adulterado", slug: "adulterado", sha256: digestOf(Buffer.from("outro conteúdo")) }),
    "index.html": html,
  });

  const dir = await tempDir(t, "ff-remote-bad-");
  const dest = join(dir, "bloco");

  try {
    const result = (await run(process.execPath, [CLI, "blocks", "add", server.url, dest], {
      encoding: "utf8",
      cwd: dir,
    }).catch((error: { code?: number; stdout?: string; stderr?: string }) => error)) as { code?: number; stderr?: string };

    assert.equal(result.code, 1);
    assert.match(result.stderr ?? "", /sha256 não confere/);
  } finally {
    await server.close();
  }
});

test("blocks add recusa meta.json sem sha256", async (t) => {
  const html = await readFile(BLOCK_HTML);
  const server = await serve({
    "meta.json": JSON.stringify({ name: "sem hash", slug: "sem-hash" }),
    "index.html": html,
  });

  const dir = await tempDir(t, "ff-remote-nohash-");
  const dest = join(dir, "bloco");

  try {
    const result = (await run(process.execPath, [CLI, "blocks", "add", server.url, dest], {
      encoding: "utf8",
      cwd: dir,
    }).catch((error: { code?: number; stdout?: string; stderr?: string }) => error)) as { code?: number; stderr?: string };

    assert.equal(result.code, 1);
    assert.match(result.stderr ?? "", /não declara sha256/);
  } finally {
    await server.close();
  }
});
