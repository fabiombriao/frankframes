// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { html as p5html, parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { loadComposition } from "@frankframes/contract";
import { annotateTiming, mergeSubCompositions } from "../src/compile.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

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

test("sub-composição de arquivo é inlinada com caminhos reescritos", async (t) => {
  const dir = await tempDir(t, "ff-compile-");
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

/** Nós do documento que o navegador monta a partir da saída. */
function* parsedNodes(node: DefaultTreeAdapterTypes.Node): Generator<DefaultTreeAdapterTypes.Node> {
  yield node;
  for (const child of "childNodes" in node ? node.childNodes : []) yield* parsedNodes(child);
}

test("sub-composição embutida sai como entrou: vazios, comentário, texto cru e SVG (EDT-94)", async (t) => {
  const dir = await tempDir(t, "ff-clone-");
  await writeFile(
    join(dir, "sub.html"),
    `<html><head><style>.x > b { color: red }</style></head><body>
      <div data-composition-id="sub" data-duration="1"><!-- nota --><p>a<br>b</p><img src="x.png">
        <svg viewBox="0 0 1 1"><path d="M0 0"/><foreignObject><br></foreignObject></svg>
        <script>if (1 < 2 && 2 > 1) {}</script>
      </div></body></html>`,
  );

  const { html } = await mergeSubCompositions(
    `<div data-composition-id="main" data-root="true"><div data-composition-id="h" data-start="0" data-composition-src="sub.html"></div></div>`,
    dir,
  );

  assert.ok(html.includes("<p>a<br>b</p>"), html);
  assert.ok(!html.includes("</br>"), html);
  assert.ok(html.includes('<img src="x.png">') && !html.includes("</img>"), html);
  assert.ok(html.includes("<!-- nota -->"), html);
  assert.ok(html.includes("<style>.x > b { color: red }</style>"), html);
  assert.ok(html.includes("<script>if (1 < 2 && 2 > 1) {}</script>"), html);

  const nodes = [...parsedNodes(parse(html))];
  // `</br>` vira mais um <br> no parser: a saída precisa ter os mesmos 2 da origem.
  assert.equal(nodes.filter((node) => node.nodeName === "br").length, 2, html);
  const path = nodes.find((node) => node.nodeName === "path") as DefaultTreeAdapterTypes.Element | undefined;
  const svg = path?.parentNode as DefaultTreeAdapterTypes.Element | undefined;
  assert.equal(svg?.nodeName, "svg", html);
  assert.equal(svg?.namespaceURI, p5html.NS.SVG);
});

test("referência circular é recusada com aviso, sem loop", async (t) => {
  const dir = await tempDir(t, "ff-compile-");
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

/** Compila só a anotação de uma raiz com os clips dados e devolve o HTML. */
function annotateClips(inner: string): string {
  const html = `<div data-composition-id="main" data-root="true" data-duration="4">${inner}</div>`;
  const composition = loadComposition(html);
  assert.equal(composition.ok, true);
  return annotateTiming(html, composition).html;
}

test("EDT-44: data-track de clip visual vira z-index no style do clip", () => {
  const semStyle = annotateClips(`<div data-clip-id="a" data-start="0" data-duration="1" data-track="2"></div>`);
  assert.match(semStyle, /<div[^>]*data-clip-id="a"[^>]*style="z-index:2"/);
  const comStyle = annotateClips(`<div data-clip-id="a" data-start="0" data-duration="1" data-track="2" style="color:red"></div>`);
  assert.match(comStyle, /style="color:red;z-index:2"/);
  const comPontoEVirgula = annotateClips(`<div data-clip-id="a" data-start="0" data-duration="1" data-track="3" style="color:red; "></div>`);
  assert.match(comPontoEVirgula, /style="color:red;z-index:3"/);
});

test("EDT-44: z-index declarado pelo autor no clip é respeitado", () => {
  const out = annotateClips(`<div data-clip-id="a" data-start="0" data-duration="1" data-track="2" style="z-index:9"></div>`);
  assert.match(out, /style="z-index:9"/);
  assert.ok(!out.includes("z-index:2"), out);
});

test("EDT-44: sem data-track ou com wrapper que não é clip, nada é escrito", () => {
  const semTrack = annotateClips(`<div data-clip-id="a" data-start="0" data-duration="1" style="color:red"></div>`);
  assert.ok(!semTrack.includes("z-index"), semTrack);
  const wrapper = annotateClips(
    `<div data-track="2"><div data-clip-id="deep" data-start="0" data-duration="1"></div></div>`,
  );
  assert.ok(!wrapper.includes("z-index"), wrapper);
});

test("EDT-44: <audio> com data-track é só organização, sem z-index", () => {
  const out = annotateClips(`<audio data-clip-id="m" src="m.wav" data-start="0" data-duration="1" data-track="3"></audio>`);
  assert.ok(!out.includes("z-index"), out);
});

test("<style> do <head> da sub-composição é preservado", async (t) => {
  const dir = await tempDir(t, "ff-head-");
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

test("data-composition-src fora da entrada é recusado", async (t) => {
  const dir = await tempDir(t, "ff-escape-");
  const merged = await mergeSubCompositions(
    `<div data-composition-id="main" data-root="true"><div data-composition-id="h" data-start="0" data-composition-src="../segredo.html"></div></div>`,
    dir,
  );
  assert.ok(merged.warnings.some((w) => w.includes("fora do diretório")));
  assert.ok(!merged.html.includes("data-composition-src"));
});
