// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalogIndex, publishCatalog, serveCatalog } from "../src/catalog-server.ts";
import type { CatalogServer } from "../src/catalog-server.ts";

function rawGet(url: string, path: string): Promise<number> {
  const { hostname, port } = new URL(url);
  const answer = Promise.withResolvers<number>();
  const req = request({ hostname, port, path, method: "GET" }, (res) => {
    res.resume();
    res.on("end", () => answer.resolve(res.statusCode ?? 0));
  });
  req.on("error", answer.reject);
  req.end();
  return answer.promise;
}

test("índice valida o sha256 do HTML de cada bloco", async () => {
  const index = await buildCatalogIndex();
  assert.equal(index.length, 48);
  const first = index[0]!;
  for (const key of ["slug", "name", "summary", "sha256", "sizeBytes"] as const) {
    assert.ok(first[key] !== undefined, `campo ausente: ${key}`);
  }
  assert.ok(first.tags.length > 0);
  assert.ok(first.durationSeconds > 0);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  // A skill de geração filtra os blocos por formato: toda entrada precisa de largura e altura inteiras.
  for (const entry of index) {
    assert.ok(Number.isInteger(entry.width) && entry.width > 0, `${entry.slug}: width ${entry.width}`);
    assert.ok(Number.isInteger(entry.height) && entry.height > 0, `${entry.slug}: height ${entry.height}`);
  }
});

test("publica, serve e bloqueia path traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "ff-catalog-"));
  let server: CatalogServer | undefined;
  try {
    const published = await publishCatalog(root);
    assert.equal(published.files, 48 * 3 + 1);

    const indexBytes = await readFile(join(root, "index.json"));
    const index = JSON.parse(indexBytes.toString("utf8")) as { slug: string; sha256: string }[];
    assert.equal(index.length, 48);

    for (const entry of index) {
      const html = await readFile(join(root, entry.slug, "index.html"));
      assert.equal(createHash("sha256").update(html).digest("hex"), entry.sha256, `${entry.slug}: sha256 do HTML publicado não confere`);
    }
    const entry = index[0]!;

    // Sobrescrever é idempotente.
    const again = await publishCatalog(root);
    assert.deepEqual(again, published);

    server = await serveCatalog(root);
    const response = await fetch(`${server.url}/index.json`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const served = (await response.json()) as { slug: string }[];
    assert.equal(served.length, 48);

    const meta = await fetch(`${server.url}/${entry.slug}/meta.json`);
    assert.equal(meta.status, 200);
    const metaJson = (await meta.json()) as { sha256: string };
    assert.match(metaJson.sha256, /^[0-9a-f]{64}$/);

    const missing = await fetch(`${server.url}/${entry.slug}/nao-existe.html`);
    assert.equal(missing.status, 404);

    assert.ok([403, 404].includes(await rawGet(server.url, "/../package.json")));
    assert.ok([403, 404].includes(await rawGet(server.url, "/%2e%2e/%2e%2e/package.json")));
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
