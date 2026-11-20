// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadComposition } from "@frankframes/contract";
import { runInit, runSkillInstall } from "../src/onboarding.ts";

test("init cria uma composição que passa no contrato", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-init-"));
  await runInit(dir);

  const composition = loadComposition(await readFile(join(dir, "index.html"), "utf8"));
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  assert.deepEqual(composition.duration, { kind: "authored", seconds: 4 });
  assert.equal(composition.clips.length, 3);
  assert.equal((await stat(join(dir, "assets"))).isDirectory(), true);
});

test("skill install grava a skill no diretório do agente", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-skill-"));
  await runSkillInstall("claude", dir);
  const text = await readFile(join(dir, ".claude", "skills", "frankframes", "SKILL.md"), "utf8");
  assert.match(text, /^---/);
  assert.match(text, /frankframes/);
});
