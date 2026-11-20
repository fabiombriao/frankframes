import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, sep } from "node:path";
import { loadComposition } from "@frankframes/contract";
import { listBlocks, readBlock } from "../src/index.ts";

const SLUGS = [
  "chart-bars",
  "image-frame",
  "list-reveal",
  "lower-third",
  "outro",
  "quote",
  "stat-counter",
  "title-card",
] as const;

interface Meta {
  name: string;
  summary: string;
  durationSeconds: number;
  tags: string[];
}

function metaOf(slug: string): Meta {
  return JSON.parse(readBlock(slug, "meta.json")) as Meta;
}

test("catálogo lista os oito blocos em ordem alfabética", () => {
  const blocks = listBlocks();
  assert.deepEqual(
    blocks.map((block) => block.slug),
    [...SLUGS],
  );
  for (const block of blocks) {
    assert.ok(isAbsolute(block.dir), `dir de ${block.slug} precisa ser absoluto`);
    assert.ok(block.dir.endsWith(`${sep}catalog${sep}blocks${sep}${block.slug}`), `dir inesperado: ${block.dir}`);
    assert.equal(block.name, metaOf(block.slug).name);
    assert.equal(block.durationSeconds, metaOf(block.slug).durationSeconds);
  }
});

for (const slug of SLUGS) {
  test(`bloco ${slug}: composição válida e sem mídia externa`, () => {
    const html = readBlock(slug);
    const composition = loadComposition(html);
    const errors = composition.diagnostics.filter((diagnostic) => diagnostic.severity === "error");

    assert.equal(composition.ok, true, `${slug}: ${errors.map((error) => error.message).join("; ")}`);
    assert.notEqual(composition.duration.kind, "unresolved");
    assert.equal(composition.id, slug);
    assert.equal(composition.width, 1920);
    assert.equal(composition.height, 1080);
    assert.deepEqual(composition.fps, { num: 30, den: 1 });

    const meta = metaOf(slug);
    assert.ok(meta.durationSeconds >= 2 && meta.durationSeconds <= 5, `${slug}: duração fora de 2–5s`);
    const seconds = composition.duration.kind === "unresolved" ? 0 : composition.duration.seconds;
    assert.ok(Math.abs(seconds - meta.durationSeconds) < 1e-6, `${slug}: duração não bate com meta.json`);
    assert.ok(meta.name.trim() !== "" && meta.summary.trim() !== "");
    assert.ok(Array.isArray(meta.tags) && meta.tags.length > 0);

    assert.ok(!/https?:\/\//i.test(html), `${slug}: URL externa no HTML`);
    assert.ok(!/<script/i.test(html), `${slug}: script no HTML`);
  });
}

test("readBlock recusa slug e arquivo fora do bloco", () => {
  assert.throws(() => readBlock("../blocks/title-card"));
  assert.throws(() => readBlock("title-card", "../title-card/index.html"));
  assert.throws(() => readBlock("nao-existe"));
});
