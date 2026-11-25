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
  // cada palavra acende do seu início até o da seguinte; a última, até o fim da legenda
  assert.ok(html.includes('style="animation-delay:1.000s,1.900s">olá<'), "primeira palavra acende no segundo 1");
  assert.ok(html.includes('style="animation-delay:1.900s,3.000s">mundo<'));
  assert.match(html, /\.w \{\s*color: #fff;/, "fora da fala a palavra é branca");
  assert.match(html, /animation-name: hl-on, hl-off;\s*animation-duration: 0s;\s*animation-fill-mode: forwards;/);
  assert.match(html, /@keyframes hl-on \{\s*to \{ color: #ff2d55; \}\s*\}\s*@keyframes hl-off \{\s*to \{ color: #fff; \}/);
  assert.ok(!html.includes("<br>"), "com palavras, o texto não é quebrado manualmente");
});

interface ReadCue {
  id: string;
  start: number;
  end: number;
  text: string;
  /** [início aceso, fim aceso] de cada palavra, em ms. */
  lit: Array<[number, number]>;
}

/** Legendas geradas, lidas do HTML: tempos do clip em segundos, texto e o intervalo aceso de cada palavra. */
function cuesOf(html: string): ReadCue[] {
  const composition = loadComposition(html);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  const bodies = [...html.matchAll(/<div class="caption"[^>]*>(.*)<\/div>/g)].map((m) => m[1]!);
  assert.equal(bodies.length, composition.clips.length);
  return composition.clips.map((clip, i) => ({
    id: clip.id,
    start: Math.round(clip.start! * 1000) / 1000,
    end: Math.round(clip.end! * 1000) / 1000,
    text: bodies[i]!.replace(/<br>/g, " ").replace(/<[^>]+>/g, ""),
    lit: [...bodies[i]!.matchAll(/animation-delay:([0-9.]+)s,([0-9.]+)s"/g)].map(
      (m): [number, number] => [Math.round(Number(m[1]) * 1000), Math.round(Number(m[2]) * 1000)],
    ),
  }));
}

/** Palavras com início e fim: `["um", 0.2, 0.4]`. */
const spoken = (...list: Array<[string, number, number]>): Array<{ start: number; end: number; word: string }> =>
  list.map(([word, start, end]) => ({ word, start, end }));

test("karaokê divide o segmento: até 4 palavras, pontuação e pausa acima de 0,35 s, tempos encadeados (EDT-95)", () => {
  const words = spoken(
    ["um", 0.2, 0.4], ["dois", 0.5, 0.7], ["três,", 0.8, 1.0], // pontuação: quebra antes de "quatro"
    ["quatro", 1.1, 1.3], ["cinco", 1.4, 1.6], // pausa de 0,40 s: quebra antes de "seis"
    ["seis", 2.0, 2.25], ["sete", 2.6, 2.75], // pausa de 0,35 s exatos: não quebra
    ["oito", 2.8, 3.0], ["nove", 3.1, 3.3], ["dez", 3.4, 3.6], // quatro palavras: quebra antes de "dez"
  );
  const cues = cuesOf(
    buildCaptionComposition([
      { start: 0, end: 4, text: words.map((w) => w.word).join(" "), words },
      { start: 4, end: 5, text: "segmento sem palavras sai por frase, inteiro" },
    ]),
  );

  assert.deepEqual(
    cues.map((cue) => [cue.id, cue.start, cue.end, cue.text]),
    [
      ["cap-0", 0, 1.1, "um dois três,"],
      ["cap-1", 1.1, 2, "quatro cinco"],
      ["cap-2", 2, 3.4, "seis sete oito nove"],
      ["cap-3", 3.4, 4, "dez"],
      ["cap-4", 4, 5, "segmento sem palavras sai por frase, inteiro"],
    ],
  );
  assert.deepEqual(cues.map((cue) => cue.lit), [
    [[200, 500], [500, 800], [800, 1100]],
    [[1100, 1400], [1400, 2000]],
    [[2000, 2600], [2600, 2800], [2800, 3100], [3100, 3400]],
    [[3400, 4000]],
    [],
  ]);
});

test("karaokê: cada sinal de pontuação fecha a legenda, e a fonte é ajustada ao texto da legenda curta (EDT-95)", () => {
  for (const mark of [".", ",", "?", "!", ";", ":"]) {
    const words = spoken(["antes", 0, 0.2], [`fim${mark}`, 0.2, 0.4], ["depois", 0.4, 0.6]);
    const cues = cuesOf(buildCaptionComposition([{ start: 0, end: 1, text: "x", words }], { maxWords: 10 }));
    assert.deepEqual(cues.map((cue) => cue.text), [`antes fim${mark}`, "depois"], `sinal ${mark}`);
  }

  // 24 palavras numa caixa só encolhiam a fonte; em legendas de 4 ela volta ao tamanho base (70 px no vertical).
  const many = Array.from({ length: 24 }, (_, i) => ["fala", i * 0.2, i * 0.2 + 0.15] as [string, number, number]);
  const segment = [{ start: 0, end: 5, text: many.map(([word]) => word).join(" "), words: spoken(...many) }];
  const sizes = (html: string): string[] => [...html.matchAll(/style="font-size:(\d+)px"/g)].map((m) => m[1]!);
  const vertical = { width: 1080, height: 1920 };
  assert.deepEqual(sizes(buildCaptionComposition(segment, vertical)), Array.from({ length: 6 }, () => "70"));
  const whole = sizes(buildCaptionComposition(segment, { ...vertical, maxWords: 24 }));
  assert.ok(whole.length === 1 && Number(whole[0]) < 70, `uma caixa só encolhe: ${whole}`);
});

test("karaokê: maxWords muda a divisão; valor que não é inteiro ≥ 1 falha alto (EDT-95)", () => {
  // Uma palavra a cada 0,5 s: toda legenda fica acima do mínimo de 0,4 s e só o maxWords decide.
  const words = spoken(["a", 0, 0.4], ["b", 0.5, 0.9], ["c", 1, 1.4], ["d", 1.5, 1.9], ["e", 2, 2.4]);
  const segment = [{ start: 0, end: 2.5, text: "a b c d e", words }];
  const texts = (maxWords?: number): string[] =>
    cuesOf(buildCaptionComposition(segment, maxWords === undefined ? {} : { maxWords })).map((cue) => cue.text);
  assert.deepEqual(texts(), ["a b c d", "e"], "padrão 4");
  assert.deepEqual(texts(1), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(texts(2), ["a b", "c d", "e"]);
  for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => buildCaptionComposition(segment, { maxWords: bad }), /maxWords precisa ser um inteiro maior ou igual a 1/, `${bad}`);
  }
});

test("karaokê não cria legenda sem duração: palavras no mesmo instante ou fora do segmento ficam juntas (EDT-95)", () => {
  const words = spoken(["a", 0, 0.5], ["b", 0.5, 0.5], ["c", 0.5, 0.9], ["d", 1.2, 1.4]);
  const cues = cuesOf(buildCaptionComposition([{ start: 0, end: 1, text: "a b c d", words }], { maxWords: 1 }));
  assert.deepEqual(cues.map((cue) => [cue.start, cue.end, cue.text]), [[0, 0.5, "a"], [0.5, 1, "b c d"]]);

  // No mesmo instante, a terceira fica com as duas primeiras e a legenda seguinte abre normalmente.
  const together = spoken(["a", 0, 0.1], ["b", 0, 0.1], ["c", 0, 0.4], ["d", 0.5, 0.9]);
  const two = cuesOf(buildCaptionComposition([{ start: 0, end: 1, text: "a b c d", words: together }], { maxWords: 2 }));
  assert.deepEqual(two.map((cue) => [cue.start, cue.end, cue.text]), [[0, 0.5, "a b c"], [0.5, 1, "d"]]);

  // Várias palavras depois do fim do segmento, bem espaçadas entre si, voltam todas para a última legenda dele.
  const late = spoken(["a", 0, 0.4], ["b", 0.5, 0.9], ["c", 1.5, 1.6], ["d", 2.1, 2.2]);
  const back = cuesOf(buildCaptionComposition([{ start: 0, end: 1, text: "a b c d", words: late }], { maxWords: 1 }));
  assert.deepEqual(back.map((cue) => [cue.start, cue.end, cue.text]), [[0, 0.5, "a"], [0.5, 1, "b c d"]]);
});

test("karaokê com decimais quebrados: a legenda acaba onde a seguinte começa, em ms inteiros (EDT-95)", () => {
  const words = Array.from({ length: 40 }, (_, i) => {
    const start = 0.1 + i * 0.2137;
    return { word: `p${i}`, start, end: start + 0.2 };
  });
  const html = buildCaptionComposition([{ start: 0.1, end: 9.00049, text: "x", words }], { maxWords: 3 });
  const spans = [...html.matchAll(/data-start="([0-9.]+)" data-duration="([0-9.]+)"/g)].map((m) => [
    Math.round(Number(m[1]) * 1000),
    Math.round(Number(m[2]) * 1000),
  ]);
  assert.equal(spans.length, 14);
  for (let i = 1; i < spans.length; i++) assert.equal(spans[i - 1]![0]! + spans[i - 1]![1]!, spans[i]![0], `legenda ${i}`);
  assert.equal(spans.at(-1)![0]! + spans.at(-1)![1]!, 9000);

  const lit = cuesOf(html).flatMap((cue) => cue.lit);
  assert.equal(lit.length, 40);
  for (let i = 1; i < lit.length; i++) assert.equal(lit[i - 1]![1], lit[i]![0], `palavra ${i} acende quando a anterior apaga`);
});

test("palavras inválidas caem no modo texto", () => {
  const html = buildCaptionComposition([
    { start: 0, end: 1, text: "sem palavras", words: [{ start: Number.NaN, end: 1, word: "x" }] },
  ]);
  assert.ok(!html.includes('class="w"'));
  assert.ok(html.includes("sem palavras"));
});

// Sem pausa acima de 0,35 s nem pontuação: o segmento cabe numa legenda só.
const karaoke = [
  {
    start: 1,
    end: 3,
    text: "olá mundo lindo",
    words: [
      { start: 1, end: 1.8, word: "olá" },
      { start: 1.9, end: 2.6, word: "mundo" },
      { start: 2.95, end: 3, word: "lindo" },
    ],
  },
];

test("motion nas legendas curtas: data-unit é relativo ao início de cada legenda (EDT-95)", () => {
  // Segmento até 3,4 s: a legenda de "lindo" dura 0,45 s, acima do mínimo de 0,4 s.
  const html = buildCaptionComposition([{ ...karaoke[0]!, end: 3.4 }], { motion: { enter: "subir dur=0.5" }, maxWords: 2 });
  assert.deepEqual(cuesOf(html).map((cue) => [cue.start, cue.end, cue.text]), [[1, 2.95, "olá mundo"], [2.95, 3.4, "lindo"]]);
  // a segunda legenda dura 0,45 s: a entrada encolhe para a duração dela
  assert.deepEqual([...html.matchAll(/data-enter="subir dur=([0-9.]+)"/g)].map((m) => m[1]), ["0.5", "0.45"]);
  assert.deepEqual([...html.matchAll(/data-unit="([0-9.]+)"/g)].map((m) => m[1]), ["0.000", "0.900", "0.000"]);
});

test("karaokê: palavra de 0,14 s isolada por pontuação ou pausa é juntada à vizinha (EDT-95)", () => {
  const texts = (end: number, words: Array<[string, number, number]>): Array<[number, number, string]> =>
    cuesOf(buildCaptionComposition([{ start: 0, end, text: "x", words: spoken(...words) }])).map((cue) => [cue.start, cue.end, cue.text]);

  // pontuação antes e pausa depois: "Já" teria 0,14 s e vai com a seguinte
  assert.deepEqual(texts(2, [["tempo?", 0, 0.5], ["Já", 0.52, 0.6], ["parou", 0.66, 1], ["mesmo", 1.45, 1.9]]), [
    [0, 0.52, "tempo?"],
    [0.52, 1.45, "Já parou"],
    [1.45, 2, "mesmo"],
  ]);
  // pausa antes, e é a última do segmento: vai com a anterior
  assert.deepEqual(texts(1.14, [["antes", 0, 0.4], ["fim", 1, 1.1]]), [[0, 1.14, "antes fim"]]);
  // curtas em sequência: junta até nenhuma ficar abaixo do mínimo
  assert.deepEqual(texts(1.5, [["a.", 0, 0.1], ["b.", 0.1, 0.2], ["c.", 0.2, 0.3], ["d.", 0.3, 0.4], ["resto", 0.5, 1.4]]), [
    [0, 0.5, "a. b. c. d."],
    [0.5, 1.5, "resto"],
  ]);
});

test("karaokê: sem motion, ou com preset sem mola, o mínimo é 0,4 s; segmento menor que isso é uma legenda só (EDT-95)", () => {
  const split = (second: number, end: number, options: Parameters<typeof buildCaptionComposition>[1] = {}): string[] =>
    cuesOf(buildCaptionComposition([{ start: 0, end, text: "x", words: spoken(["um.", 0, 0.2], ["dois", second, end]) }], options)).map((cue) => cue.text);

  for (const options of [{}, { motion: { enter: "subir" } }, { motion: { enter: "saltar curve=freio" } }]) {
    const label = JSON.stringify(options);
    assert.deepEqual(split(0.4, 0.8, options), ["um.", "dois"], `0,4 s exatos valem ${label}`);
    assert.deepEqual(split(0.399, 0.9, options), ["um. dois"], `0,399 s na primeira ${label}`);
    assert.deepEqual(split(0.5, 0.899, options), ["um. dois"], `0,399 s na última ${label}`);
  }
  assert.deepEqual(split(0.1, 0.2), ["um. dois"], "segmento de 0,2 s não é erro sem motion");
});

// As três durações curtas medidas nos dados reais: 0,52 s ("tempo?"), 0,14 s ("Já") e 0,58 s ("computador fazendo").
const dadosReais = [
  {
    start: 0,
    end: 2.44,
    text: "o teu tempo? Já parou para pensar. computador fazendo",
    words: spoken(
      ["o", 0, 0.1], ["teu", 0.1, 0.2], ["tempo?", 0.2, 0.5], // 0 a 0,52
      ["Já", 0.52, 0.6], // 0,52 a 0,66: pausa depois
      ["parou", 1.01, 1.2], ["para", 1.2, 1.5], ["pensar.", 1.5, 1.8],
      ["computador", 1.86, 2.1], ["fazendo", 2.15, 2.44], // 1,86 a 2,44
    ),
  },
];

test("motion saltar com as durações dos dados reais: nenhuma legenda abaixo do que a mola pede (EDT-95)", () => {
  const durations = (html: string): number[] => cuesOf(html).map((cue) => Math.round((cue.end - cue.start) * 1000));
  assert.deepEqual(durations(buildCaptionComposition(dadosReais)), [520, 490, 850, 580], "sem motion, só o de 0,14 s é juntado");

  const html = buildCaptionComposition(dadosReais, { motion: { enter: "saltar" } });
  const composition = loadComposition(html);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  assert.ok(durations(html).every((ms) => ms >= 590), `mola assenta em 0,59 s: ${durations(html)}`);
  assert.deepEqual(cuesOf(html).map((cue) => cue.text), ["o teu tempo? Já", "parou para pensar. computador fazendo"]);

  // A mola pedida por `curve=` num preset qualquer sobe o mínimo do mesmo jeito; mola-firme tem outro assentamento (0,50 s).
  assert.ok(durations(buildCaptionComposition(dadosReais, { motion: { enter: "subir curve=mola" } })).every((ms) => ms >= 590));
  assert.deepEqual(durations(buildCaptionComposition(dadosReais, { motion: { enter: "saltar curve=mola-firme" } })), [520, 1340, 580]);
  // Entrada e saída com mola somam os dois mínimos (1,18 s): a legenda de 0,70 s, que bastaria só para a entrada, é juntada.
  const early = [{ start: 0, end: 2, text: "x", words: spoken(["um.", 0, 0.01], ["dois.", 0.01, 0.1], ["três.", 0.7, 0.71], ["quatro", 0.71, 0.8]) }];
  assert.deepEqual(durations(buildCaptionComposition(early, { motion: { enter: "saltar dur=0.59" } })), [700, 1300]);
  assert.deepEqual(durations(buildCaptionComposition(early, { motion: { enter: "saltar dur=0.59", exit: "apagar dur=0.59 curve=mola" } })), [2000]);

  // `dur` do autor abaixo da mola continua sendo erro alto: juntar legendas não resolve.
  assert.throws(() => buildCaptionComposition(dadosReais, { motion: { enter: "saltar dur=0.3" } }), /E_CURVE_INVALID/);
  // Segmento inteiro menor que o mínimo: uma legenda só, e o contrato recusa como antes.
  assert.throws(
    () => buildCaptionComposition([{ start: 0, end: 0.5, text: "x", words: spoken(["um.", 0, 0.2], ["dois", 0.45, 0.5]) }], { motion: { enter: "saltar" } }),
    /E_CURVE_INVALID/,
  );
});

test("karaokê: a legenda juntada pela duração mínima pode passar de maxWords (EDT-95)", () => {
  const words = spoken(["a", 0, 0.1], ["b", 0.15, 0.25], ["c", 0.3, 0.4], ["d", 1, 1.4], ["e", 1.5, 1.9]);
  const cues = cuesOf(buildCaptionComposition([{ start: 0, end: 2, text: "a b c d e", words }], { maxWords: 1 }));
  assert.deepEqual(cues.map((cue) => [cue.start, cue.end, cue.text]), [[0, 1, "a b c"], [1, 1.5, "d"], [1.5, 2, "e"]]);
  // o destaque por palavra continua o mesmo dentro da legenda juntada
  assert.deepEqual(cues[0]!.lit, [[0, 150], [150, 300], [300, 1000]]);
});

test("motion nas legendas: data-unit é o início da palavra menos o da legenda e o contrato valida", () => {
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
