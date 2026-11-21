// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadComposition } from "@frankframes/contract";
import { buildCaptionComposition } from "../src/captions.ts";

test("legendas: um clip por segmento, tempo exato e texto escapado", () => {
  const html = buildCaptionComposition(
    [
      { start: 0, end: 1.2, text: "primeira <linha>" },
      { start: 1.2, end: 2.5, text: "segunda & última" },
      { start: 2.5, end: 2.5, text: "ignorada" },
    ],
    { width: 1080, height: 1920 },
  );

  const composition = loadComposition(html);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  assert.deepEqual(composition.duration, { kind: "authored", seconds: 2.5 });
  assert.equal(composition.clips.length, 2, "segmento de duração zero sai");
  assert.deepEqual(
    composition.clips.map((clip) => [clip.id, clip.start, clip.end]),
    [["cap-0", 0, 1.2], ["cap-1", 1.2, 2.5]],
  );
  assert.ok(html.includes("primeira &lt;linha&gt;"), "texto precisa ser escapado");
  assert.ok(html.includes("segunda &amp; última"));
  assert.ok(html.includes('data-width="1080"'));
});

test("sem segmento válido, falha alto", () => {
  assert.throws(() => buildCaptionComposition([]), /nenhum segmento válido/);
  assert.throws(() => buildCaptionComposition([{ start: 2, end: 1, text: "x" }]), /nenhum segmento válido/);
});

test("quebra de linha equilibrada e fonte que encolhe", async () => {
  const { wrapLines, fitFontSize } = await import("../src/captions.ts");
  const lines = wrapLines("uma legenda longa que precisa de pelo menos duas linhas para caber na largura", 30);
  assert.ok(lines.length >= 2);
  for (const line of lines) assert.ok(line.length <= 34, `linha longa: ${line.length}`);
  assert.deepEqual(wrapLines("   ", 20), []);

  const base = 60;
  assert.equal(fitFontSize(["curta"], base, 40), base);
  const longLines = Array.from({ length: 6 }, () => "x".repeat(38));
  assert.ok(fitFontSize(longLines, base, 40) < base, "muitas linhas precisam encolher a fonte");
});

test("composição de legenda quebra o texto e mantém tempo", () => {
  const texto = "essa legenda é longa o suficiente para ocupar mais de uma linha na largura segura do quadro";
  const html = buildCaptionComposition([{ start: 0, end: 2, text: texto }], { width: 1080, height: 1920, maxCharsPerLine: 28 });
  const composition = loadComposition(html);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  assert.ok(html.includes("<br>"), "texto longo precisa de quebra explícita");
  assert.equal((html.match(/data-clip-id=/g) ?? []).length, 1);
});

test("karaokê: uma palavra por span, acesa no instante absoluto", () => {
  const html = buildCaptionComposition(
    [
      {
        start: 1,
        end: 3,
        text: "olá mundo",
        words: [
          { start: 1, end: 1.8, word: "olá" },
          { start: 1.9, end: 2.6, word: "mundo" },
        ],
      },
    ],
    { width: 1080, height: 1920, highlight: "#ff2d55" },
  );

  const composition = loadComposition(html);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  assert.equal((html.match(/class="w"/g) ?? []).length, 2, "uma palavra por span");
  assert.ok(html.includes("animation-delay:1.000s"), "primeira palavra acende no segundo 1");
  assert.ok(html.includes("animation-delay:1.900s"));
  assert.ok(html.includes("@keyframes k"), "keyframe do destaque precisa existir");
  assert.ok(html.includes("#ff2d55"));
  assert.ok(!html.includes("<br>"), "com palavras, o texto não é quebrado manualmente");
});

test("palavras inválidas caem no modo texto", () => {
  const html = buildCaptionComposition([
    { start: 0, end: 1, text: "sem palavras", words: [{ start: Number.NaN, end: 1, word: "x" }] },
  ]);
  assert.ok(!html.includes('class="w"'));
  assert.ok(html.includes("sem palavras"));
});
