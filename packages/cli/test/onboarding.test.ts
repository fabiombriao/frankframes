// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadComposition } from "@frankframes/contract";
import { runInit, runSkillInstall } from "../src/onboarding.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

test("init cria uma composição que passa no contrato", async (t) => {
  const dir = await tempDir(t, "ff-init-");
  await runInit(dir);

  const composition = loadComposition(await readFile(join(dir, "index.html"), "utf8"));
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  assert.deepEqual(composition.duration, { kind: "authored", seconds: 4 });
  assert.equal(composition.clips.length, 3);
  assert.equal((await stat(join(dir, "assets"))).isDirectory(), true);
});

test("skill install grava a skill no diretório do agente", async (t) => {
  const dir = await tempDir(t, "ff-skill-");
  await runSkillInstall("claude", dir);
  for (const name of ["frankframes", "frankframes-generate"]) {
    const text = await readFile(join(dir, ".claude", "skills", name, "SKILL.md"), "utf8");
    assert.match(text, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`), name);
  }
});

test("skill install --cursor grava um .mdc por skill", async (t) => {
  const dir = await tempDir(t, "ff-skill-cursor-");
  await runSkillInstall("cursor", dir);
  for (const name of ["frankframes", "frankframes-generate"]) {
    const text = await readFile(join(dir, ".cursor", "rules", `${name}.mdc`), "utf8");
    assert.match(text, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`), name);
  }
});
