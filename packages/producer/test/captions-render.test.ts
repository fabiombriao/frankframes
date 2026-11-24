// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { openSession, openSessionFor, resolveChrome, startServer } from "@frankframes/engine";
import { prepare } from "../src/render.ts";
import { buildCaptionComposition } from "../src/captions.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

test("karaokê acende a palavra no instante certo", { timeout: 300_000 }, async (t) => {
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
