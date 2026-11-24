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

const karaoke = [
  {
    start: 1,
    end: 3,
    text: "olá mundo lindo",
    words: [
      { start: 1, end: 1.5, word: "olá" },
      { start: 1.9, end: 2.4, word: "mundo" },
      { start: 2.95, end: 3, word: "lindo" },
    ],
  },
];

test("motion nas legendas: data-unit é o início da palavra menos o do segmento e o contrato valida", () => {
  const html = buildCaptionComposition(karaoke, { motion: { enter: "subir" } });
  const composition = loadComposition(html);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  assert.match(html, /data-split="word stagger=0" data-enter="subir dur=0\.[0-9]+"/);
  const units = [...html.matchAll(/class="w" data-unit="([0-9.]+)"/g)].map((m) => m[1]);
  // a última palavra cai no fim da fala: a âncora é limitada a D − dur
  assert.deepEqual(units.slice(0, 2), ["0.000", "0.900"]);
  const dur = Number(/data-enter="subir dur=([0-9.]+)"/.exec(html)![1]);
  assert.ok(Number(units[2]) <= 2 - dur + 1e-9 && Number(units[2]) > 0.9, `última âncora ${units[2]} (dur ${dur})`);
  assert.ok(html.includes("animation-delay:1.000s"), "o karaokê continua em CSS");
  // o texto das palavras não muda
  assert.equal((html.match(/class="w"/g) ?? []).length, 3);
});

test("motion nas legendas sem palavras: stagger encolhe para a última entrada caber na fala", () => {
  const html = buildCaptionComposition([{ start: 0, end: 1, text: "um dois três quatro cinco" }], { motion: { enter: "subir" } });
  const composition = loadComposition(html);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  const stagger = Number(/data-split="word stagger=([0-9.]+)"/.exec(html)![1]);
  assert.ok(stagger > 0 && stagger <= 0.06, `stagger ${stagger}`);
  assert.ok(!html.includes("data-unit"), "sem palavras com tempo, as unidades são automáticas");
});

test("motion nas legendas: saída entra depois da última entrada; preset inválido ou sem espaço falha alto", () => {
  const html = buildCaptionComposition(
    [{ start: 0, end: 4, text: "olá mundo", words: [{ start: 0, end: 1, word: "olá" }, { start: 1, end: 2, word: "mundo" }] }],
    { motion: { enter: "subir dur=0.4", exit: "apagar dur=0.5" } },
  );
  assert.equal(loadComposition(html).ok, true);
  assert.match(html, /data-exit="apagar dur=0\.5"/);
  assert.throws(() => buildCaptionComposition(karaoke, { motion: { enter: "inexistente" } }), /preset "inexistente" não existe/);
  assert.throws(() => buildCaptionComposition(karaoke, { motion: { enter: "subir dur=x" } }), /dur inválido/);
  assert.throws(
    () => buildCaptionComposition(karaoke, { motion: { enter: "subir dur=1", exit: "apagar" } }),
    /não tem espaço para a saída/,
  );
});

test("fonte padrão: proporcional à altura no 16:9 (inalterada) e à largura no vertical; sem transform de centralização", () => {
  const segments = [{ start: 0, end: 1, text: "oi" }];
  const fontOf = (html: string): string => /\.caption \{[^}]*?font-size: (\d+)px/.exec(html)![1]!;
  assert.equal(fontOf(buildCaptionComposition(segments, { width: 1920, height: 1080 })), "59", "16:9 não muda: 1080 × 0,055");
  assert.equal(fontOf(buildCaptionComposition(segments)), "59", "o padrão sem tamanho continua 1920×1080");
  assert.equal(fontOf(buildCaptionComposition(segments, { width: 1080, height: 1920 })), "70", "vertical: 1080 × 0,065, não 1920 × 0,055 = 106");
  assert.equal(fontOf(buildCaptionComposition(segments, { width: 1080, height: 1920, fontSize: 40 })), "40", "fontSize explícito manda");

  const css = buildCaptionComposition(segments, { width: 1080, height: 1920 });
  assert.match(css, /left: 0;\s*right: 0;\s*margin-inline: auto;/);
  assert.match(css, /width: fit-content;\s*max-width: 84%;/);
  assert.doesNotMatch(css, /left: 50%|translate/, "left:50% limita a caixa a 50% do quadro");
});

test("sem motion, a legenda sai exatamente como antes", () => {
  const html = buildCaptionComposition(karaoke);
  assert.ok(!html.includes("data-split") && !html.includes("data-unit") && !html.includes("data-enter"));
});
