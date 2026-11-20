// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession, resolveChrome, startServer } from "@frankframes/engine";
import { compileComposition } from "../src/compile.ts";

const ENTRY = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#0b0b0f;color:#fff;font-family:"Inter"}
  .box{position:absolute;left:40px;top:40px;width:200px;height:80px;background:#ff2d55}
</style></head><body>
<div data-composition-id="main" data-root="true" data-width="640" data-height="360" data-fps="30">
  <div data-composition-id="host" data-start="1" data-duration="1" data-composition-src="cards/card.html"></div>
</div></body></html>`;

const CARD = `<!doctype html>
<html><body><div data-composition-id="card" data-duration="1">
  <div class="box" data-clip-id="inner" data-start="0" data-duration="1"></div>
</div></body></html>`;

test("sub-composição de arquivo só aparece na janela dela", { timeout: 300_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  const dir = await mkdtemp(join(tmpdir(), "ff-sub-"));
  await mkdir(join(dir, "cards"), { recursive: true });
  await writeFile(join(dir, "index.html"), ENTRY);
  await writeFile(join(dir, "cards", "card.html"), CARD);

  const compiled = await compileComposition({ entryHtml: ENTRY, entryDir: dir });
  assert.equal(compiled.composition.ok, true);
  assert.deepEqual(compiled.composition.duration, { kind: "derived", seconds: 2 });
  assert.equal(compiled.composition.clips[0]!.children.length, 1, "o clip interno precisa existir");
  assert.ok(compiled.html.includes('data-ff-start="1000"'), "host anotado com início absoluto");

  const server = await startServer(dir, { page: { path: "index.html", html: compiled.html } });
  const session = await openSession({ url: `${server.url}index.html`, viewport: { width: 640, height: 360 }, gpu: "auto" });
  try {
    const visibility = (selector: string) =>
      session.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).visibility`);

    await session.seekFrame(0, { num: 30, den: 1 });
    assert.equal(await visibility('[data-composition-id="host"]'), "hidden", "fora da janela: escondido");
    assert.equal(await visibility('[data-clip-id="inner"]'), "hidden");

    await session.seekFrame(45, { num: 30, den: 1 });
    assert.equal(await visibility('[data-composition-id="host"]'), "visible", "dentro da janela: visível");
    assert.equal(await visibility('[data-clip-id="inner"]'), "visible");

    await session.seekFrame(80, { num: 30, den: 1 });
    assert.equal(await visibility('[data-clip-id="inner"]'), "hidden", "depois do fim: escondido de novo");
  } finally {
    await session.close();
    await server.close();
  }
});
