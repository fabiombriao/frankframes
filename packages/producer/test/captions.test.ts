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
