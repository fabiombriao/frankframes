// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-97: editar o texto de uma legenda gerada, sem tocar no resto do arquivo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadComposition } from "@frankframes/contract";
import { buildCaptionComposition, editCaptionText, hasCaptionMeta, readCaptionFile } from "../src/captions.ts";
import type { CaptionOptions, CaptionSegment } from "../src/captions.ts";
import { EditError } from "../src/edit.ts";

const VERTICAL: CaptionOptions = { width: 1080, height: 1920 };

/** Segmento com palavras: `["um", 0.2, 0.6]`. */
const spoken = (start: number, end: number, ...list: Array<[string, number, number]>): CaptionSegment => ({
  start,
  end,
  text: list.map(([word]) => word).join(" "),
  words: list.map(([word, from, to]) => ({ word, start: from, end: to })),
});

/** Três legendas de karaokê, com emoji antes da que se edita (offsets contam unidades UTF-16). */
const three = (): CaptionSegment[] => [
  spoken(0, 1.5, ["olá", 0, 0.5], ["🎬🎬", 0.5, 1], ["ação.", 1, 1.5]),
  spoken(1.5, 3.5, ["essa", 1.7, 2.1], ["legneda", 2.2, 2.6], ["aqui.", 2.7, 3.1]),
  spoken(3.5, 5, ["fim", 3.6, 4], ["mesmo", 4.1, 4.5]),
];

const elementOf = (html: string, id: string): string => {
  const found = new RegExp(`<div class="caption" data-clip-id="${id}"[^\\n]*</div>`).exec(html);
  assert.ok(found, `legenda ${id} no arquivo`);
  return found[0];
};

/** [início, fim] aceso de cada palavra da legenda, em ms. */
const lit = (html: string, id: string): Array<[number, number]> => {
  const cue = readCaptionFile(html).cues.find((item) => item.id === id);
  assert.ok(cue?.words, `legenda ${id} com palavras`);
  return cue.words.map((word): [number, number] => [Math.round(word.start * 1000), Math.round(word.end * 1000)]);
};

const units = (html: string, id: string): string[] => [...elementOf(html, id).matchAll(/data-unit="([0-9.]+)"/g)].map((m) => m[1]!);

const refused = (code: string, task: () => unknown): EditError => {
  let caught: unknown;
  try {
    task();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof EditError, `esperava ${code}, veio ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  assert.ok(typeof caught.hint === "string" && caught.hint !== "", `${code} sem hint`);
  return caught;
};

test("a meta guarda as opções de layout resolvidas e a leitura devolve as legendas com tempos locais", () => {
  const html = buildCaptionComposition(three(), { ...VERTICAL, highlight: "#ff2d55", motion: { enter: "subir dur=0.3" } });
  assert.equal(hasCaptionMeta(html), true);
  const { options, cues } = readCaptionFile(html);
  assert.deepEqual(options, {
    v: 1,
    width: 1080,
    height: 1920,
    fontSize: 70,
    maxChars: 24,
    maxLines: 3,
    bottom: 154,
    highlight: "#ff2d55",
    maxWords: 4,
    motion: { enter: "subir dur=0.3" },
  });
  assert.deepEqual(
    cues.map((cue) => [cue.id, cue.start, cue.end, cue.text, cue.words?.length]),
    [
      ["cap-0", 0, 1.5, "olá 🎬🎬 ação.", 3],
      ["cap-1", 1.5, 3.5, "essa legneda aqui.", 3],
      ["cap-2", 3.5, 5, "fim mesmo", 2],
    ],
  );
  assert.deepEqual(cues[1]!.words, [
    { start: 1.7, end: 2.2, word: "essa" },
    { start: 2.2, end: 2.7, word: "legneda" },
    { start: 2.7, end: 3.5, word: "aqui." },
  ]);

  // O valor da meta vai escapado: aspas no motion ou no destaque não fecham o atributo.
  const quoted = buildCaptionComposition(three(), { highlight: `#fff /* '"<> */` });
  assert.equal(readCaptionFile(quoted).options.highlight, `#fff /* '"<> */`);
});

test("editar troca só o elemento da legenda: o resto do arquivo fica byte a byte, com LF ou CRLF e retoques à mão", () => {
  const generated = buildCaptionComposition(three(), VERTICAL)
    .replace("<title>legendas</title>", "<title>legendas 🎬 do autor</title>\n  <!-- retoque à mão -->")
    .replace('data-clip-id="cap-2"', 'data-clip-id="cap-2" data-nota="não mexer"');
  for (const html of [generated, generated.replaceAll("\n", "\r\n"), `﻿${generated}`]) {
    const before = elementOf(html, "cap-1");
    const edited = editCaptionText(html, "cap-1", "essa legenda aqui.");
    const after = elementOf(edited, "cap-1");
    assert.equal(after, before.replace("legneda", "legenda"), "só a letra muda no elemento");
    const at = html.indexOf(before);
    assert.equal(edited, html.slice(0, at) + after + html.slice(at + before.length));
  }
});

test("mesma quantidade de palavras mantém os tempos, e reaplicar o mesmo texto não muda o arquivo", () => {
  for (const motion of [undefined, { enter: "subir dur=0.3" }, { enter: "subir dur=0.2", exit: "apagar dur=0.2" }]) {
    // Decimais quebrados: refazer a âncora a partir dos ms arredondados erraria o data-unit por 1 ms.
    const segments = [spoken(0.1004, 2.9006, ["um", 0.2137, 0.6], ["dois", 0.7274, 1.1], ["três", 1.2411, 1.9])];
    assert.equal(readCaptionFile(buildCaptionComposition(segments, VERTICAL)).cues[0]!.words!.length, 3);
    const html = buildCaptionComposition(segments, { ...VERTICAL, ...(motion === undefined ? {} : { motion }) });
    for (const cue of readCaptionFile(html).cues) assert.equal(editCaptionText(html, cue.id, `  ${cue.text} `), html, `${cue.id} ${JSON.stringify(motion)}`);

    const edited = editCaptionText(html, "cap-0", "Um, DOIS três!");
    assert.deepEqual(lit(edited, "cap-0"), lit(html, "cap-0"));
    assert.deepEqual(units(edited, "cap-0"), units(html, "cap-0"));
    assert.equal(readCaptionFile(edited).cues[0]!.text, "Um, DOIS três!");
    assert.equal(loadComposition(edited).ok, true);
  }
});

test("editar dá o mesmo arquivo que gerar já com o texto novo (karaokê e frase, com quebra de linha e fonte)", () => {
  const motion = { motion: { enter: "subir dur=0.3" } };
  for (const options of [VERTICAL, { ...VERTICAL, ...motion }, { width: 1920, height: 1080, fontSize: 44, maxCharsPerLine: 14, maxLines: 2 }]) {
    const typo = [spoken(0, 2, ["essa", 0.2, 0.6], ["legneda", 0.7, 1.1], ["aqui", 1.2, 1.6])];
    const right = [spoken(0, 2, ["essa", 0.2, 0.6], ["legenda", 0.7, 1.1], ["aqui", 1.2, 1.6])];
    assert.equal(editCaptionText(buildCaptionComposition(typo, options), "cap-0", "essa legenda aqui"), buildCaptionComposition(right, options));

    // Por frase: só o texto muda; quebra de linha e fonte saem do mesmo código da geração.
    const long = "uma frase bem maior que precisa quebrar em várias linhas e por isso encolher a fonte da legenda inteira até caber";
    const short = buildCaptionComposition([{ start: 0, end: 3, text: "curta" }], options);
    const generated = buildCaptionComposition([{ start: 0, end: 3, text: long }], options);
    const edited = editCaptionText(short, "cap-0", long);
    assert.equal(edited, generated);
    assert.notEqual(/font-size:(\d+)px"/.exec(elementOf(edited, "cap-0"))![1], /font-size:(\d+)px"/.exec(elementOf(short, "cap-0"))![1]);
    assert.ok(elementOf(edited, "cap-0").includes("<br>"));
    assert.equal(readCaptionFile(edited).cues[0]!.words, null, "legenda por frase continua por frase");
    assert.equal(editCaptionText(edited, "cap-0", "curta"), short, "voltar ao texto curto devolve o arquivo original");
  }
});

/** Edita a única legenda e confere o que não muda: palavras encadeadas, uma acesa por vez, do mesmo início ao mesmo fim. */
const retimed = (html: string, text: string): Array<[number, number]> => {
  const edited = editCaptionText(html, "cap-0", text);
  assert.equal(readCaptionFile(edited).cues[0]!.text, text);
  const spans = lit(edited, "cap-0");
  const before = lit(html, "cap-0");
  assert.deepEqual([spans[0]![0], spans.at(-1)![1]], [before[0]![0], before.at(-1)![1]], text);
  assert.ok(spans.every(([from, to], i) => to > from && (i === 0 || spans[i - 1]![1] === from)), `${text}: ${JSON.stringify(spans)}`);
  return spans;
};

/** Cinco palavras numa legenda só: [200,700] [700,1200] [1200,1700] [1700,2200] [2200,3000]. */
const five = (): string =>
  buildCaptionComposition([spoken(0, 3, ["um", 0.2, 0.6], ["dois", 0.7, 1.1], ["três", 1.2, 1.6], ["quatro", 1.7, 2.1], ["cinco", 2.2, 2.6])], {
    ...VERTICAL,
    maxWords: 8,
  });

test("outra quantidade de palavras não mexe nas que ficaram iguais: o caso do A001 (EDT-98)", () => {
  const html = buildCaptionComposition(
    [spoken(14.1, 15.38, ["falando", 14.1, 14.44], ["de", 14.44, 14.66], ["chat", 14.66, 14.96], ["EPT", 14.96, 15.38])],
    VERTICAL,
  );
  assert.deepEqual(retimed(html, "falando de ChatGPT"), [[14100, 14440], [14440, 14660], [14660, 15380]]);
});

test("o trecho trocado no meio reparte só o intervalo das palavras que substitui (EDT-98)", () => {
  // "três quatro" vai de 1200 a 2200: 1, 2 e 7 caracteres.
  assert.deepEqual(retimed(five(), "um dois a bb ccccccc cinco"), [[200, 700], [700, 1200], [1200, 1300], [1300, 1500], [1500, 2200], [2200, 3000]]);
  assert.deepEqual(retimed(five(), "um dois sete cinco"), [[200, 700], [700, 1200], [1200, 2200], [2200, 3000]]);
  // A comparação é exata: mudar só a caixa ou a pontuação já é palavra trocada.
  assert.deepEqual(retimed(five(), "um Dois xxxx cinco"), [[200, 700], [700, 1450], [1450, 2200], [2200, 3000]]);
  // Mesma quantidade continua mantendo todos os tempos, mesmo com tudo diferente.
  assert.deepEqual(retimed(five(), "a bbbbbbbbbbbb c dddd e"), lit(five(), "cap-0"));
});

test("inserção pura divide o intervalo da palavra anterior; no começo, o da seguinte (EDT-98)", () => {
  // "dois" (700 a 1200) com "xx": 4 e 2 caracteres.
  assert.deepEqual(retimed(five(), "um dois xx três quatro cinco"), [[200, 700], [700, 1033], [1033, 1200], [1200, 1700], [1700, 2200], [2200, 3000]]);
  // Duas inseridas juntas dividem a mesma vizinha: 4, 1 e 1.
  assert.deepEqual(
    retimed(five(), "um dois a b três quatro cinco"),
    [[200, 700], [700, 1033], [1033, 1117], [1117, 1200], [1200, 1700], [1700, 2200], [2200, 3000]],
  );
  assert.deepEqual(retimed(five(), "um dois três quatro cinco fim"), [[200, 700], [700, 1200], [1200, 1700], [1700, 2200], [2200, 2700], [2700, 3000]]);
  // Sem anterior: "zero" e "um" (200 a 700), 4 e 2.
  assert.deepEqual(retimed(five(), "zero um dois três quatro cinco"), [[200, 533], [533, 700], [700, 1200], [1200, 1700], [1700, 2200], [2200, 3000]]);
});

test("remoção pura dá o intervalo à palavra anterior; no começo, à seguinte (EDT-98)", () => {
  assert.deepEqual(retimed(five(), "um dois quatro cinco"), [[200, 700], [700, 1700], [1700, 2200], [2200, 3000]]);
  assert.deepEqual(retimed(five(), "um cinco"), [[200, 2200], [2200, 3000]]);
  assert.deepEqual(retimed(five(), "um dois três quatro"), [[200, 700], [700, 1200], [1200, 1700], [1700, 3000]]);
  assert.deepEqual(retimed(five(), "dois três quatro cinco"), [[200, 1200], [1200, 1700], [1700, 2200], [2200, 3000]]);
  assert.deepEqual(retimed(five(), "quatro cinco"), [[200, 2200], [2200, 3000]]);
  // Palavra repetida: o começo é casado primeiro, então quem sai é a segunda.
  const twice = buildCaptionComposition([spoken(0, 2, ["não", 0.2, 0.5], ["não", 0.6, 0.9], ["sei", 1, 1.4])], VERTICAL);
  assert.deepEqual(retimed(twice, "não sei"), [[200, 1000], [1000, 2000]]);
});

test("com motion, o instante que não muda mantém o data-unit gravado (EDT-98)", () => {
  // Decimais quebrados: em "um" e "quatro", refazer a âncora dos ms erraria o data-unit por 1 ms.
  const html = buildCaptionComposition(
    [spoken(0.1004, 2.9006, ["um", 0.2137, 0.6], ["dois", 0.7274, 1.1], ["três", 1.2411, 1.6], ["quatro", 1.7499, 2.1], ["cinco", 2.2503, 2.6])],
    { ...VERTICAL, maxWords: 8, motion: { enter: "subir dur=0.3" } },
  );
  const saved = units(html, "cap-0");
  assert.deepEqual([saved[0], saved[3]], ["0.113", "1.649"], "os dados precisam exercitar o arredondamento");
  const after = (text: string): string[] => units(editCaptionText(html, "cap-0", text), "cap-0");

  // Prefixo e sufixo guardam a âncora; das duas novas no lugar de "três", só a 2ª tem instante novo.
  const middle = after("um dois nova outra quatro cinco");
  assert.deepEqual(middle.toSpliced(3, 1), saved);
  assert.ok(Number(middle[3]) > Number(saved[2]) && Number(middle[3]) < Number(saved[3]), middle.join(" "));
  assert.deepEqual(after("um dois quatro cinco"), [saved[0], saved[1], saved[3], saved[4]]);
  // O trecho que começa no mesmo instante também: "um" que passa a durar mais, e quem herda o começo.
  assert.deepEqual(after("um três quatro cinco"), [saved[0], saved[2], saved[3], saved[4]]);
  assert.deepEqual(after("dois três quatro cinco"), [saved[0], saved[2], saved[3], saved[4]]);
  assert.equal(after("um dois três xyz cinco fim")[3], saved[3], "a 1ª palavra do trecho começa onde a antiga começava");
});

test("outra quantidade de palavras reparte o trecho pelos caracteres, em ms encadeados", () => {
  const html = buildCaptionComposition([spoken(0, 2, ["um", 0.2, 0.6], ["dois", 0.7, 1.1], ["três", 1.2, 1.6])], VERTICAL);

  // 1800 ms, 1 + 2 caracteres.
  assert.deepEqual(lit(editCaptionText(html, "cap-0", "a bb"), "cap-0"), [[200, 800], [800, 2000]]);
  // Arredondamento: as bordas saem do acumulado (1800 × 1/7, 2/7 e 3/7), sem sobra no fim.
  assert.deepEqual(lit(editCaptionText(html, "cap-0", "a b c dddd"), "cap-0"), [[200, 457], [457, 714], [714, 971], [971, 2000]]);
  // Uma só palavra fica com o intervalo inteiro; acento e emoji contam um caractere cada.
  assert.deepEqual(lit(editCaptionText(html, "cap-0", "tudo"), "cap-0"), [[200, 2000]]);
  assert.deepEqual(lit(editCaptionText(html, "cap-0", "é 🎬"), "cap-0"), [[200, 1100], [1100, 2000]]);

  // Cada palavra com pelo menos 1 ms, mesmo quando a proporção daria zero.
  const tight = buildCaptionComposition([spoken(0, 1, ["x", 0.996, 1])], VERTICAL);
  assert.deepEqual(lit(editCaptionText(tight, "cap-0", `a ${"b".repeat(500)} c d`), "cap-0"), [[996, 997], [997, 998], [998, 999], [999, 1000]]);
  refused("E_ATTRIBUTE_INVALID", () => editCaptionText(tight, "cap-0", "a b c d e"));

  // Outra legenda do mesmo arquivo: o intervalo é absoluto (a animação roda no tempo da sub-composição).
  const many = buildCaptionComposition(three(), VERTICAL);
  const spans = lit(editCaptionText(many, "cap-1", "essa legenda bem aqui."), "cap-1");
  assert.equal(spans[0]![0], 1700);
  assert.equal(spans.at(-1)![1], 3500);
  for (let i = 1; i < spans.length; i++) assert.equal(spans[i - 1]![1], spans[i]![0], `palavra ${i}`);
  assert.ok(spans.every(([from, to]) => to > from));
});

test("com motion, outra quantidade de palavras refaz os data-unit no início de cada palavra nova", () => {
  const html = buildCaptionComposition([spoken(1, 3, ["um", 1.2, 1.6], ["dois", 1.7, 2.1], ["três", 2.2, 2.6])], {
    ...VERTICAL,
    motion: { enter: "subir dur=0.3" },
  });
  const edited = editCaptionText(html, "cap-0", "a bb");
  assert.deepEqual(lit(edited, "cap-0"), [[1200, 1800], [1800, 3000]]);
  assert.deepEqual(units(edited, "cap-0"), ["0.200", "0.800"]);
  assert.equal(loadComposition(edited).ok, true, JSON.stringify(loadComposition(edited).diagnostics));

  // A última âncora é limitada a D − dur, como na geração.
  const last = editCaptionText(html, "cap-0", `${"a".repeat(30)} b`);
  assert.equal(units(last, "cap-0")[1], "1.700");
  assert.equal(loadComposition(last).ok, true);

  // Motion que deixa de caber com o texto novo é recusa com código, não arquivo inválido.
  // Aqui a 2ª palavra nova começaria no fim: a entrada dela não deixa espaço para a saída.
  const exit = buildCaptionComposition([spoken(0, 2, ["um", 0, 1])], { motion: { enter: "subir dur=0.4", exit: "apagar dur=0.4" } });
  assert.match(refused("E_ATTRIBUTE_INVALID", () => editCaptionText(exit, "cap-0", `${"x".repeat(40)} y`)).message, /saída/);
});

test("texto com < e & é texto: vai escapado e volta igual", () => {
  const text = `<b>oi</b> & "x" </div><script>alert(1)</script>`;
  for (const segments of [[{ start: 0, end: 2, text: "frase" }], [spoken(0, 2, ["um", 0.2, 0.6])]]) {
    const html = buildCaptionComposition(segments, VERTICAL);
    const edited = editCaptionText(html, "cap-0", text);
    assert.ok(!edited.includes("<b>") && !edited.includes("<script>"), "nada vira elemento");
    assert.equal(readCaptionFile(edited).cues[0]!.text, text);
    const composition = loadComposition(edited);
    assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
    assert.equal(composition.clips.length, 1);
    assert.equal(editCaptionText(edited, "cap-0", segments[0]!.text), html);
  }
});

test("texto vazio, legenda inexistente e arquivo sem a meta falham com código e hint", () => {
  const html = buildCaptionComposition(three(), VERTICAL);
  for (const empty of ["", "   ", "\n\t "]) refused("E_ATTRIBUTE_INVALID", () => editCaptionText(html, "cap-1", empty));
  refused("E_CAPTIONS_CUE_NOT_FOUND", () => editCaptionText(html, "cap-9", "texto"));

  const legacy = html.replace(/\n\s*<meta name="frankframes:captions"[^\n]*>/, "");
  assert.notEqual(legacy, html);
  assert.equal(hasCaptionMeta(legacy), false);
  for (const task of [() => readCaptionFile(legacy), () => editCaptionText(legacy, "cap-1", "texto")]) {
    assert.match(refused("E_CAPTIONS_LEGACY", task).hint!, /frankframes captions/);
  }

  const meta = /(<meta name="frankframes:captions" content=')([^']*)(')/;
  for (const content of ["{", "null", "{&quot;v&quot;:2}", "{&quot;v&quot;:1}"]) {
    refused("E_CAPTIONS_LEGACY", () => readCaptionFile(html.replace(meta, `$1${content}$3`)));
  }
  // Legenda mexida para fora do formato gerado não é adivinhada.
  refused("E_CAPTIONS_LEGACY", () => readCaptionFile(html.replace(">fim</span>", "><b>fim</b></span> <i>x</i>")));
});
