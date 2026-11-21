// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startGallery } from "../src/gallery.ts";
import type { GalleryServer } from "../src/gallery.ts";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test("galeria lista, serve thumbs e abre a prévia ao vivo", async () => {
  let server: GalleryServer | undefined;
  try {
    server = await startGallery();

    const index = await fetch(`${server.url}/`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get("cache-control"), "no-store");
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    const html = await index.text();
    assert.ok((html.match(/\/view\//g) ?? []).length >= 48, "a grade precisa de pelo menos 48 links /view/");
    assert.ok(html.includes("title-card"));
    assert.ok(html.includes('src="/thumb/title-card.png"'));

    const thumb = await fetch(`${server.url}/thumb/title-card.png`);
    assert.equal(thumb.status, 200);
    assert.match(thumb.headers.get("content-type") ?? "", /image\/png/);
    const bytes = new Uint8Array(await thumb.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 8)], PNG);

    const view = await fetch(`${server.url}/view/title-card`);
    assert.equal(view.status, 200);
    assert.equal(view.headers.get("cache-control"), "no-store");
    const preview = await view.text();
    assert.ok(preview.includes("__ff"));
    assert.ok(preview.includes("data-ff-start"));
    assert.ok(preview.includes("/__ff_fonts"));

    const missing = await fetch(`${server.url}/view/nao-existe`);
    assert.ok(missing.status === 500 || missing.status === 404, `status inesperado: ${missing.status}`);

    const traversal = await fetch(`${server.url}/thumb/..%2f..%2fpackage.json`);
    assert.ok(traversal.status === 400 || traversal.status === 403, `status inesperado: ${traversal.status}`);

    const invalid = await fetch(`${server.url}/view/Title_Card`);
    assert.equal(invalid.status, 400);
  } finally {
    await server?.close();
  }
});
