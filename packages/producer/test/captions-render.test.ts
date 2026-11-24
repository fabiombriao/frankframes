// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { openSession, openSessionFor, resolveChrome, startServer } from "@frankframes/engine";
import { prepare } from "../src/render.ts";
import { buildCaptionComposition } from "../src/captions.ts";
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
      await writeFile(entry, buildCaptionComposition([longSegment(karaoke)], { width, height }));

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

test("karaokê acende a palavra no instante certo",{ timeout: 300_000 }, async (t) => {
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
        text: "um dois",
        words: [
          { start: 0.5, end: 1.0, word: "um" },
          { start: 1.5, end: 2.0, word: "dois" },
        ],
      },
    ], { width: 640, height: 360, fontSize: 40 }),
  );

  const prepared = await prepare({ entry });
  const server = await startServer(prepared.entryDir, { page: { path: basename(prepared.entry), html: prepared.compiledHtml } });
  const session = await openSessionFor(server, { url: `${server.url}${basename(entry)}`, viewport: prepared.viewport, gpu: "software" });
  try {
    const colors = () =>
      session.evaluate<string[]>(`[...document.querySelectorAll("span.w")].map((span) => getComputedStyle(span).color)`);

    await session.seekFrame(6, prepared.fps); // 0,2 s: ninguém falou ainda
    const before = await colors();
    assert.equal(before.length, 2);
    assert.ok(before[0]!.includes("0.62"), `antes do tempo a palavra deveria estar apagada: ${before[0]}`);

    await session.seekFrame(21, prepared.fps); // 0,7 s: "um" já foi
    const after = await colors();
    assert.notEqual(after[0], before[0], "a primeira palavra precisa acender");
    assert.ok(after[1]!.includes("0.62"), "a segunda ainda não foi falada");
  } finally {
    await session.close();
    await server.close();
  }
});
