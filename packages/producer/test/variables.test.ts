// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadComposition } from "@frankframes/contract";
import { VariableError, applyVariables, collectVariables, prepare } from "../src/index.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const SOURCE = `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<!-- comentário do autor -->
<div data-composition-id="main" data-root="true" data-width="640" data-height="360" data-fps="30" data-duration="2">
    <h1 class="titulo" data-var="titulo">Título autoral</h1>
  <img class="foto" src="padrao.jpg" alt="foto" data-var-attr="src:foto; alt:legenda">
  <p data-var="vazio"></p>
</div></body></html>`;

function throwsVariable(operation: () => unknown, code: VariableError["code"]): VariableError {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof VariableError, `esperava VariableError, veio ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new assert.AssertionError({ message: `esperava ${code}, mas não lançou` });
}

test("troca o texto do elemento com escape e o atributo existente", () => {
  const { html, used } = applyVariables(SOURCE, { titulo: "A <b>&</b> B", foto: "novo.jpg", legenda: 'diz "oi"', vazio: "x" });
  assert.deepEqual(used, ["foto", "legenda", "titulo", "vazio"]);
  assert.ok(html.includes('<h1 class="titulo" data-var="titulo">A &lt;b&gt;&amp;&lt;/b&gt; B</h1>'), html);
  assert.ok(html.includes('src="novo.jpg"'), html);
  assert.ok(html.includes('alt="diz &quot;oi&quot;"'), html);
  assert.ok(html.includes('<p data-var="vazio">x</p>'), "elemento vazio também recebe o texto");
});

test("o resto do arquivo fica byte a byte igual (comentário, indentação, ordem dos atributos)", () => {
  const { html } = applyVariables(SOURCE, { titulo: "T", foto: "f.jpg", legenda: "l", vazio: "v" });
  const expected = SOURCE.replace("Título autoral", "T").replace('src="padrao.jpg"', 'src="f.jpg"').replace('alt="foto"', 'alt="l"').replace("<p data-var=\"vazio\"></p>", '<p data-var="vazio">v</p>');
  assert.equal(html, expected);
});

test("atributo ausente no elemento é inserido; elemento vazio com barra mantém a barra", () => {
  const source = '<div data-var-attr="data-duration:tempo; title:dica"><img src="a.png" data-var-attr="alt:texto" /></div>';
  const { html } = applyVariables(source, { tempo: "3", dica: "d", texto: "t" });
  assert.equal(html, '<div data-var-attr="data-duration:tempo; title:dica" data-duration="3" title="d"><img src="a.png" data-var-attr="alt:texto" alt="t" /></div>');
});

test("collectVariables lista as chaves sem repetição, em ordem", () => {
  assert.deepEqual(collectVariables(SOURCE), ["foto", "legenda", "titulo", "vazio"]);
  assert.deepEqual(collectVariables('<p data-var="b">1</p><p data-var="a">2</p><p data-var="a">3</p>'), ["a", "b"]);
  assert.deepEqual(collectVariables("<p>sem variável</p>"), []);
});

test("E_VAR_MISSING: chave usada no HTML e ausente nas vars", () => {
  const error = throwsVariable(() => applyVariables(SOURCE, { titulo: "T" }), "E_VAR_MISSING");
  assert.match(error.message, /foto, legenda, vazio/);
  assert.match(error.hint, /"foto", "legenda", "vazio"/);
});

test("E_VAR_UNKNOWN: chave das vars que nenhum elemento usa (erro de digitação não passa)", () => {
  const error = throwsVariable(() => applyVariables(SOURCE, { titulo: "T", foto: "f", legenda: "l", vazio: "v", titullo: "x" }), "E_VAR_UNKNOWN");
  assert.match(error.message, /titullo/);
});

test("E_VAR_INVALID: elemento com filhos, elemento sem fechamento e código", () => {
  const filhos = throwsVariable(() => applyVariables('<p data-var="a">um <b>dois</b></p>', { a: "x" }), "E_VAR_INVALID");
  assert.match(filhos.message, /só pode conter texto/);
  throwsVariable(() => applyVariables('<img data-var="a" src="x.png">', { a: "x" }), "E_VAR_INVALID");
  throwsVariable(() => applyVariables('<script data-var="a">1</script>', { a: "x" }), "E_VAR_INVALID");
  throwsVariable(() => applyVariables('<p><!-- c --><span data-var="a">x</span></p><p data-var="b"><!-- c --></p>', { a: "x", b: "y" }), "E_VAR_INVALID");
});

test("E_VAR_INVALID: forma da chave, do data-var-attr e das vars", () => {
  throwsVariable(() => applyVariables('<p data-var="1ruim">x</p>', { "1ruim": "x" }), "E_VAR_INVALID");
  throwsVariable(() => applyVariables('<p data-var="a b">x</p>', { "a b": "x" }), "E_VAR_INVALID");
  throwsVariable(() => applyVariables('<img data-var-attr="src" src="x">', {}), "E_VAR_INVALID");
  throwsVariable(() => applyVariables('<img data-var-attr="src:foto; src:outra" src="x">', { foto: "a", outra: "b" }), "E_VAR_INVALID");
  throwsVariable(() => applyVariables('<img data-var-attr="data-var:foto" src="x">', { foto: "a" }), "E_VAR_INVALID");
  throwsVariable(() => applyVariables("<p>x</p>", { "chave ruim": "x" }), "E_VAR_INVALID");
  throwsVariable(() => applyVariables("<p>x</p>", { chave: 3 as unknown as string }), "E_VAR_INVALID");
  throwsVariable(() => collectVariables('<p data-var="a b">x</p>'), "E_VAR_INVALID");
});

test("data-duration por variável muda a duração resolvida pelo contrato", () => {
  const source = `<!doctype html><html><body>
<div data-composition-id="main" data-root="true" data-width="640" data-height="360" data-fps="30" data-duration="2" data-var-attr="data-duration:tempo">
  <div data-clip-id="a" data-start="0" data-duration="1"></div>
</div></body></html>`;
  assert.deepEqual(loadComposition(source).duration, { kind: "authored", seconds: 2 });
  const { html } = applyVariables(source, { tempo: "5" });
  assert.deepEqual(loadComposition(html).duration, { kind: "authored", seconds: 5 });
});

test("prepare aplica as variáveis antes do contrato, inclusive em sub-composição, e sem vars vale o autoral", { timeout: 60_000 }, async (t) => {
  const dir = await tempDir(t, "ff-vars-");
  await mkdir(join(dir, "cards"), { recursive: true });
  const entry = join(dir, "index.html");
  await writeFile(
    entry,
    `<!doctype html><html><body>
<div data-composition-id="main" data-root="true" data-width="640" data-height="360" data-fps="30" data-var-attr="data-duration:tempo" data-duration="1">
  <div data-composition-id="host" data-start="0" data-duration="1" data-composition-src="cards/card.html"></div>
</div></body></html>`,
  );
  await writeFile(
    join(dir, "cards", "card.html"),
    `<!doctype html><html><body><div data-composition-id="card" data-duration="1"><p data-var="nome">Autoral</p></div></body></html>`,
  );
  // O render real precisa do FFmpeg só para medir mídia; sem mídia nem o procura, então passa caminhos falsos.
  const common = { ffmpeg: "ffmpeg-inexistente", ffprobe: "ffprobe-inexistente" };

  const plain = await prepare({ entry, ...common });
  assert.equal(plain.seconds, 1);
  assert.ok(plain.compiledHtml.includes("Autoral"), "sem vars, o texto autoral fica");

  const varied = await prepare({ entry, ...common, vars: { tempo: "3", nome: "Maria" } });
  assert.equal(varied.seconds, 3, "data-duration trocado por variável entra no contrato");
  assert.ok(varied.compiledHtml.includes(">Maria</p>"), "data-var da sub-composição também vale");

  await assert.rejects(
    prepare({ entry, ...common, vars: { tempo: "3" } }),
    (error: { code?: string; stage?: string }) => error.code === "E_VAR_MISSING" && error.stage === "compile",
  );
  await assert.rejects(
    prepare({ entry, ...common, vars: { tempo: "3", nome: "x", sobra: "y" } }),
    (error: { code?: string }) => error.code === "E_VAR_UNKNOWN",
  );
  t.diagnostic("prepare cobre vars, E_VAR_MISSING e E_VAR_UNKNOWN");
});
