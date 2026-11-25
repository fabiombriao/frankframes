// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { openSession, openSessionFor, resolveChrome, startServer } from "@frankframes/engine";
import { prepare } from "../src/render.ts";
import { buildCaptionComposition, editCaptionText, readCaptionFile } from "../src/captions.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const LONG_TEXT = "essa legenda é bem longa e precisa ocupar toda a largura permitida do quadro sem ficar presa na metade da tela";

/** Segmento longo: com palavras com tempo (karaokê, quebra natural) ou só texto (quebra explícita por `<br>`). */
function longSegment(karaoke: boolean): { start: number; end: number; text: string; words?: Array<{ start: number; end: number; word: string }> } {
  const words = LONG_TEXT.split(" ");
  return {
    start: 0,
    end: 2,
    text: LONG_TEXT,
    ...(karaoke ? { words: words.map((word, i) => ({ start: (i * 1.5) / words.length, end: ((i + 1) * 1.5) / words.length, word })) } : {}),
  };
}

// A caixa da legenda cresce até 84% do quadro e fica centrada (antes parava em 50%: `left:50%` + translate).
for (const [width, height] of [[1080, 1920], [1920, 1080]] as const) {
  for (const karaoke of [false, true]) {
    test(`caixa da legenda ${width}x${height} (${karaoke ? "karaokê" : "texto"}): passa de 50% da largura, não passa de 84% e fica centrada`, { timeout: 300_000 }, async (t) => {
      try {
        await resolveChrome();
      } catch {
        return t.skip("Chrome não encontrado");
      }

      const dir = await tempDir(t, "ff-caption-box-");
      const entry = join(dir, "index.html");
      // `maxWords` do tamanho do texto: o teste é da caixa com o texto longo inteiro, sem dividir.
      await writeFile(entry, buildCaptionComposition([longSegment(karaoke)], { width, height, maxWords: LONG_TEXT.split(" ").length }));

      const prepared = await prepare({ entry });
      const server = await startServer(prepared.entryDir, { page: { path: basename(prepared.entry), html: prepared.compiledHtml } });
      const session = await openSessionFor(server, { url: `${server.url}${basename(entry)}`, viewport: prepared.viewport, gpu: "software" });
      try {
        await session.seekFrame(15, prepared.fps); // 0,5 s: a legenda está no ar
        const box = await session.evaluate<{ left: number; width: number; height: number; lineHeight: number }>(`(() => {
          const el = document.querySelector(".caption");
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { left: r.left, width: r.width, height: r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom), lineHeight: parseFloat(cs.lineHeight) };
        })()`);
        assert.ok(box.width > width * 0.5, `largura ${box.width}px não passa de 50% de ${width}px (teto antigo: left:50%)`);
        assert.ok(box.width <= width * 0.84 + 0.5, `largura ${box.width}px passa de 84% de ${width}px`);
        assert.ok(Math.abs(box.left + box.width / 2 - width / 2) <= 1, `caixa descentralizada: centro em ${box.left + box.width / 2}px, esperado ${width / 2}px`);
        // Coerência do maxChars: no texto com `<br>`, o navegador não quebra além das linhas que o gerador pediu.
        if (!karaoke) {
          const wanted = (buildCaptionComposition([longSegment(false)], { width, height }).match(/<br>/g) ?? []).length + 1;
          assert.equal(Math.round(box.height / box.lineHeight), wanted, "o texto quebrou em mais linhas do que o gerador pediu");
        }
      } finally {
        await session.close();
        await server.close();
      }
    });
  }
}

const WHITE = "rgb(255, 255, 255)";
const LIT = "rgb(255, 212, 0)"; // #ffd400
/** Com 1000 fps, o número do frame é o instante em milissegundos. */
const MILLISECONDS = { num: 1000, den: 1 };

test("karaokê: só a palavra que está sendo falada fica na cor de destaque, em qualquer ordem de seek (EDT-95)", { timeout: 300_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  const dir = await tempDir(t, "ff-karaoke-");
  const entry = join(dir, "index.html");
  await writeFile(
    entry,
    buildCaptionComposition([
      {
        start: 0,
        end: 2,
        text: "um dois três",
        words: [
          { start: 0.2, end: 0.6, word: "um" },
          { start: 0.7, end: 1.1, word: "dois" },
          { start: 1.2, end: 1.6, word: "três" },
        ],
      },
    ], { width: 640, height: 360, fontSize: 40 }),
  );

  const prepared = await prepare({ entry });
  const server = await startServer(prepared.entryDir, { page: { path: basename(prepared.entry), html: prepared.compiledHtml } });
  const session = await openSessionFor(server, { url: `${server.url}${basename(entry)}`, viewport: prepared.viewport, gpu: "software" });
  try {
    const colorsAt = async (ms: number): Promise<string[]> => {
      await session.seekFrame(ms, MILLISECONDS);
      return session.evaluate<string[]>(`[...document.querySelectorAll("span.w")].map((span) => getComputedStyle(span).color)`);
    };

    assert.deepEqual(await colorsAt(900), [WHITE, LIT, WHITE], "no meio da 2ª palavra");
    assert.deepEqual(await colorsAt(100), [WHITE, WHITE, WHITE], "antes de alguém falar");
    assert.deepEqual(await colorsAt(650), [LIT, WHITE, WHITE], "entre duas palavras a anterior segue acesa");
    assert.deepEqual(await colorsAt(1850), [WHITE, WHITE, LIT], "a última fica acesa até o fim da legenda");
    // Volta no tempo depois de todas as animações anteriores terem terminado: com fill none isto falha.
    assert.deepEqual(await colorsAt(400), [LIT, WHITE, WHITE], "seek para trás reacende a 1ª");
    assert.deepEqual(await colorsAt(699), [LIT, WHITE, WHITE], "1 ms antes da 2ª");
    assert.deepEqual(await colorsAt(700), [WHITE, LIT, WHITE], "no início exato da 2ª, só ela");
    assert.deepEqual(session.pageErrors(), []);
  } finally {
    await session.close();
    await server.close();
  }
});

test("karaokê: com decimais quebrados, em cada troca de palavra há exatamente uma acesa (EDT-95)", { timeout: 300_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  const words = Array.from({ length: 30 }, (_, i) => {
    const start = 0.1 + i * 0.2137;
    return { word: `p${i}`, start, end: start + 0.2 };
  });
  const dir = await tempDir(t, "ff-karaoke-edges-");
  const entry = join(dir, "index.html");
  await writeFile(entry, buildCaptionComposition([{ start: 0, end: 7, text: "x", words }], { width: 640, height: 360, maxWords: words.length }));

  const prepared = await prepare({ entry });
  const server = await startServer(prepared.entryDir, { page: { path: basename(prepared.entry), html: prepared.compiledHtml } });
  const session = await openSessionFor(server, { url: `${server.url}${basename(entry)}`, viewport: prepared.viewport, gpu: "software" });
  try {
    const litAt = async (ms: number): Promise<number[]> => {
      await session.seekFrame(ms, MILLISECONDS);
      return session.evaluate<number[]>(
        `[...document.querySelectorAll("span.w")].flatMap((span, i) => getComputedStyle(span).color === "${LIT}" ? [i] : [])`,
      );
    };
    const starts = words.map((word) => Math.round(word.start * 1000));
    const expected: Array<[number, number[]]> = starts.flatMap((ms, i): Array<[number, number[]]> => [
      [ms - 1, i === 0 ? [] : [i - 1]],
      [ms, [i]],
    ]);
    const wrong: string[] = [];
    for (const [ms, lit] of [...expected, ...[...expected].reverse()]) {
      const got = await litAt(ms);
      if (got.join() !== lit.join()) wrong.push(`${ms} ms: acesas [${got}], esperado [${lit}]`);
    }
    assert.deepEqual(wrong, []);
  } finally {
    await session.close();
    await server.close();
  }
});

test("karaokê editado com outra quantidade de palavras: continua uma palavra acesa por vez, nos tempos repartidos (EDT-97)", { timeout: 300_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  const generated = buildCaptionComposition([
    { start: 0, end: 2, text: "um dois três", words: [{ start: 0.2, end: 0.6, word: "um" }, { start: 0.7, end: 0.9, word: "dois" }, { start: 1, end: 1.6, word: "três" }] },
  ], { width: 640, height: 360, fontSize: 40 });
  const edited = editCaptionText(generated, "cap-0", "a gente corrigiu esta frase toda");
  const words = readCaptionFile(edited).cues[0]!.words!;
  assert.equal(words.length, 6);

  const dir = await tempDir(t, "ff-karaoke-edit-");
  const entry = join(dir, "index.html");
  await writeFile(entry, edited);

  const prepared = await prepare({ entry });
  const server = await startServer(prepared.entryDir, { page: { path: basename(prepared.entry), html: prepared.compiledHtml } });
  const session = await openSessionFor(server, { url: `${server.url}${basename(entry)}`, viewport: prepared.viewport, gpu: "software" });
  try {
    const litAt = async (ms: number): Promise<number[]> => {
      await session.seekFrame(ms, MILLISECONDS);
      return session.evaluate<number[]>(
        `[...document.querySelectorAll("span.w")].flatMap((span, i) => getComputedStyle(span).color === "${LIT}" ? [i] : [])`,
      );
    };
    const starts = words.map((word) => Math.round(word.start * 1000));
    const expected: Array<[number, number[]]> = starts.flatMap((ms, i): Array<[number, number[]]> => [
      [ms - 1, i === 0 ? [] : [i - 1]],
      [ms, [i]],
    ]);
    const wrong: string[] = [];
    for (const [ms, on] of [...expected, [1999, [5]] as [number, number[]], ...[...expected].reverse()]) {
      const got = await litAt(ms);
      if (got.join() !== on.join()) wrong.push(`${ms} ms: acesas [${got}], esperado [${on}]`);
    }
    assert.deepEqual(wrong, []);
    assert.deepEqual(session.pageErrors(), []);
  } finally {
    await session.close();
    await server.close();
  }
});
