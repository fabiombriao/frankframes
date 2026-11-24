// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fillPresets, motionPresetTable, PRESETS_BEGIN, PRESETS_END } from "../../../scripts/sync-skill.ts";

const SOURCE = fileURLToPath(new URL("../../../skills/", import.meta.url));
const PACKAGED = fileURLToPath(new URL("../skill/", import.meta.url));

/** Caminhos relativos de todos os arquivos sob `dir`, ordenados. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

test("skills publicadas são idênticas às do monorepo, arquivo a arquivo", async () => {
  const source = await filesUnder(SOURCE);
  const packaged = await filesUnder(PACKAGED);
  assert.deepEqual(packaged, source, "rode `node scripts/sync-skill.ts`");
  assert.ok(source.includes("frankframes/SKILL.md") && source.includes("frankframes-generate/SKILL.md"));
  for (const file of source) {
    const a = await readFile(join(SOURCE, file), "utf8");
    const b = await readFile(join(PACKAGED, file), "utf8");
    assert.equal(b, a, `${file} diverge: rode \`node scripts/sync-skill.ts\``);
  }
});

test("a tabela de presets da skill de geração é a gerada do código", async () => {
  const text = await readFile(join(SOURCE, "frankframes-generate", "SKILL.md"), "utf8");
  assert.equal(fillPresets(text), text, "tabela de presets desatualizada: rode `node scripts/sync-skill.ts`");
  const region = text.slice(text.indexOf(PRESETS_BEGIN) + PRESETS_BEGIN.length, text.indexOf(PRESETS_END));
  assert.equal(region.trim().replaceAll("\r\n", "\n"), motionPresetTable());
});

test("fillPresets falha alto sem os marcadores", () => {
  assert.throws(() => fillPresets("# sem marcadores"), /marcadores de presets/);
});

test("skill de geração: até 250 linhas, frontmatter e os cinco pedidos de aceite", async () => {
  const text = await readFile(join(SOURCE, "frankframes-generate", "SKILL.md"), "utf8");
  assert.ok(text.split("\n").length <= 250, `${text.split("\n").length} linhas`);
  assert.match(text, /^---\r?\nname: frankframes-generate\r?\ndescription: .+\r?\n---\r?\n/);
  const pedidos = JSON.parse(await readFile(join(SOURCE, "frankframes-generate", "evals", "pedidos.json"), "utf8")) as Array<{
    id: string;
    pedido: string;
    format: string;
    durationSeconds: number;
  }>;
  assert.equal(pedidos.length, 5);
  for (const pedido of pedidos) {
    assert.ok(pedido.id && pedido.pedido && pedido.durationSeconds > 0, pedido.id);
    assert.ok(["16:9", "9:16", "1:1"].includes(pedido.format), pedido.id);
  }
});
