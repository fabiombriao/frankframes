// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPresets } from "@frankframes/contract";
import { MOTION_THUMBS_DIR, motionThumbPath } from "../src/index.ts";

const MAX_BYTES = 200 * 1024;
const MOTION_DOC = fileURLToPath(new URL("../../../docs/motion.md", import.meta.url));

test("todo preset tem miniatura GIF real de até 200 KB", async () => {
  const presets = listPresets();
  assert.ok(presets.length >= 36, `esperado ao menos 36 presets, obtido ${presets.length}`);
  for (const preset of presets) {
    const file = join(MOTION_THUMBS_DIR, `${preset.name}.gif`);
    const bytes = await readFile(file).catch(() => null);
    assert.ok(bytes, `${preset.name}: miniatura ausente (rode \`node scripts/generate-motion-thumbs.ts\`)`);
    assert.equal(bytes.subarray(0, 6).toString("latin1"), "GIF89a", `${preset.name}: não é GIF89a`);
    assert.ok(bytes.byteLength > 500, `${preset.name}: GIF com ${bytes.byteLength} bytes parece vazio`);
    assert.ok(bytes.byteLength <= MAX_BYTES, `${preset.name}: GIF com ${(bytes.byteLength / 1024).toFixed(0)} KB passa do teto de 200 KB`);
    assert.equal(motionThumbPath(preset.name), file);
  }
});

test("nenhuma miniatura órfã: todo GIF pertence a um preset", async () => {
  const names = new Set(listPresets().map((preset) => preset.name));
  for (const file of await readdir(MOTION_THUMBS_DIR)) {
    assert.ok(file.endsWith(".gif"), `arquivo estranho em ${MOTION_THUMBS_DIR}: ${file}`);
    assert.ok(names.has(file.slice(0, -4)), `${file}: preset inexistente (apague o arquivo ou rode o gerador)`);
  }
});

test("docs/motion.md cita cada preset e a miniatura dele", async () => {
  const doc = await readFile(MOTION_DOC, "utf8");
  for (const preset of listPresets()) {
    assert.ok(doc.includes(`\`${preset.name}\``), `docs/motion.md não cita \`${preset.name}\``);
    assert.ok(doc.includes(`../catalog/motion/thumbs/${preset.name}.gif`), `docs/motion.md sem a miniatura de ${preset.name}`);
    assert.ok(doc.includes(preset.label), `docs/motion.md sem o label "${preset.label}"`);
  }
});

test("motionThumbPath recusa nome inválido e preset sem miniatura", async () => {
  assert.throws(() => motionThumbPath("../x"), /inválido/);
  assert.throws(() => motionThumbPath("Subir"), /inválido/);
  assert.throws(() => motionThumbPath("nao-existe"), /inexistente/);
  assert.ok((await stat(motionThumbPath("subir"))).isFile());
});
