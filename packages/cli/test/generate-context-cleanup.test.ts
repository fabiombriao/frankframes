// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildContextDir } from "../src/generate-context.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

/** Aponta os temporários do processo para uma pasta só deste teste: a contagem de `ff-generate-*` fica exata. */
async function isolateTmp(t: Parameters<typeof tempDir>[0]): Promise<string> {
  const sandbox = await tempDir(t, "ff-gencleanup-");
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = sandbox;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return sandbox;
}

const generateDirs = (sandbox: string): string[] => readdirSync(sandbox).filter((name) => name.startsWith("ff-generate-"));

test("buildContextDir que falha depois do mkdtemp não deixa ff-generate-* e o erro original sobe", async (t) => {
  const sandbox = await isolateTmp(t);
  const missing = join(sandbox, "projeto-que-nao-existe");
  await assert.rejects(
    buildContextDir({ project: { dir: missing, probe: async () => 1 } }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT" && String((error as Error).message).includes("projeto-que-nao-existe"),
  );
  assert.deepEqual(generateDirs(sandbox), [], "a pasta criada por buildContextDir some na falha");
});

test("buildContextDir com sucesso entrega a pasta ao chamador, que é quem a apaga", async (t) => {
  const sandbox = await isolateTmp(t);
  const context = await buildContextDir();
  assert.deepEqual(generateDirs(sandbox), [context.dir.slice(sandbox.length + 1)]);
  assert.ok(existsSync(join(context.dir, "SKILL.md")));
  await rm(context.dir, { recursive: true });
});

test("buildContextDir com `dir` do chamador não apaga a pasta dele na falha", async (t) => {
  const dir = await tempDir(t, "ff-gencleanup-dono-"); // criada antes do isolamento: fora da sandbox
  const sandbox = await isolateTmp(t);
  await assert.rejects(buildContextDir({ dir, project: { dir: join(sandbox, "nao-existe"), probe: async () => 1 } }));
  assert.ok(existsSync(dir), "o dono é o chamador");
});
