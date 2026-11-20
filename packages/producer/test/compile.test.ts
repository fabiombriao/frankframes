// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadComposition } from "@frankframes/contract";
import { annotateTiming, mergeSubCompositions } from "../src/compile.ts";

test("<template> inline vira nós reais e some do documento", async () => {
  const html = `<html><body><div data-composition-id="main" data-root="true">
    <div data-composition-id="card" data-start="1">
      <template><div data-composition-id="card-in" data-duration="1">
        <div data-clip-id="inner" data-start="0" data-duration="1">oi</div>
      </div></template>
    </div>
  </div></body></html>`;

  const merged = await mergeSubCompositions(html, ".");
  assert.ok(!merged.html.includes("<template"), "template precisa ser substituído pelo conteúdo");
  assert.ok(merged.html.includes("data-clip-id=\"inner\""));
  assert.equal(merged.warnings.length, 0);
});

test("sub-composição de arquivo é inlinada com caminhos reescritos", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-compile-"));
  await mkdir(join(dir, "cards"), { recursive: true });
  await writeFile(
    join(dir, "cards", "card.html"),
    `<html><body><div data-composition-id="card" data-duration="1" style="background:url(pic.png)">
      <img src="pic.png" alt="">
      <div data-clip-id="inner" data-start="0" data-duration="1">ok</div>
    </div></body></html>`,
  );

  const entry = `<html><body><div data-composition-id="main" data-root="true">
    <div data-composition-id="host" data-start="1" data-composition-src="cards/card.html"></div>
  </div></body></html>`;

  const merged = await mergeSubCompositions(entry, dir);
  assert.ok(merged.html.includes('data-clip-id="inner"'), "clips da sub-composição precisam entrar");
  assert.ok(merged.html.includes('src="cards/pic.png"'), "caminho relativo precisa ser reescrito");
  assert.ok(!merged.html.includes("data-composition-src"), "host não pode continuar externo");
});

test("referência circular é recusada com aviso, sem loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-compile-"));
  await writeFile(
    join(dir, "a.html"),
    `<div data-composition-id="a"><div data-composition-id="x" data-composition-src="b.html"></div></div>`,
  );
  await writeFile(
    join(dir, "b.html"),
    `<div data-composition-id="b"><div data-composition-id="y" data-composition-src="a.html"></div></div>`,
  );
  const merged = await mergeSubCompositions(`<div data-composition-id="main" data-root="true" data-composition-src="a.html"></div>`, dir);
  assert.ok(merged.warnings.some((w) => w.includes("circular")), merged.warnings.join(" | "));
});

test("anotação grava início/fim em ms e o escopo da sub-composição", async () => {
  const html = `<div data-composition-id="main" data-root="true" data-duration="4">
    <div data-clip-id="a" data-start="1" data-duration="1"></div>
    <div data-composition-id="card" data-start="2" data-duration="1">
      <div data-clip-id="b" data-start="0.5" data-duration="0.5"></div>
    </div>
  </div>`;
  const composition = loadComposition(html);
  assert.equal(composition.ok, true);

  const { html: annotated, annotations } = annotateTiming(html, composition);
  assert.equal(annotations, 3);
  assert.match(annotated, /data-clip-id="a"[^>]*data-ff-start="1000"[^>]*data-ff-end="2000"|data-ff-start="1000"[^>]*data-clip-id="a"/);
  assert.ok(annotated.includes('data-ff-comp-start="2000"'), "host de sub-composição precisa do início do escopo");
  assert.ok(annotated.includes('data-ff-start="2500"'), "clip interno é anotado com tempo absoluto");
});

test("clip sem data-clip-id recebe tempo anotado", async () => {
  const { materializeClipIds } = await import("../src/compile.ts");
  const html = `<div data-composition-id="main" data-root="true" data-duration="4">
    <div data-start="1" data-duration="1"></div>
  </div>`;
  const composition = loadComposition(html);
  assert.equal(composition.ok, true);
  assert.equal(composition.clips.length, 1);

  const materialized = materializeClipIds(html);
  assert.match(materialized, /data-clip-id="div#0"/);

  const { html: annotated, annotations } = annotateTiming(materialized, composition);
  assert.equal(annotations, 1, "sem id materializado, o clip nunca seria escondido");
  assert.match(annotated, /data-ff-start="1000"/);
  assert.match(annotated, /data-ff-end="2000"/);
});

test("<style> do <head> da sub-composição é preservado", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-head-"));
  await writeFile(
    join(dir, "card.html"),
    `<html><head><style>.x{color:red}</style></head><body>
      <div data-composition-id="card" data-duration="1" style="background:blue">
        <div data-clip-id="x" data-start="0" data-duration="1" class="x">oi</div>
      </div></body></html>`,
  );
  const merged = await mergeSubCompositions(
    `<div data-composition-id="main" data-root="true"><div data-composition-id="h" data-start="0" data-composition-src="card.html"></div></div>`,
    dir,
  );
  assert.ok(merged.html.includes(".x{color:red}"), "o <style> do head precisa entrar");
  assert.ok(merged.html.includes("background:blue"), "o style da raiz interna precisa ser herdado");
});

test("data-composition-src fora da entrada é recusado", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-escape-"));
  const merged = await mergeSubCompositions(
    `<div data-composition-id="main" data-root="true"><div data-composition-id="h" data-start="0" data-composition-src="../segredo.html"></div></div>`,
    dir,
  );
  assert.ok(merged.warnings.some((w) => w.includes("fora do diretório")));
  assert.ok(!merged.html.includes("data-composition-src"));
});
