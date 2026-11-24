// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NEEDS_REAL, evaluateCriteria } from "../../../scripts/generate-eval.ts";
import type { EvalInput } from "../../../scripts/generate-eval.ts";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../../scripts/generate-eval.ts", import.meta.url));
const PEDIDOS = fileURLToPath(new URL("../../../skills/frankframes-generate/evals/pedidos.json", import.meta.url));

/** Um relatório de exemplo que passa em tudo; cada teste estraga um campo. */
function good(): EvalInput {
  return {
    expected: { width: 1920, height: 1080, fps: 30, durationSeconds: 6 },
    generateOk: true,
    entryMatchesLastAttempt: true,
    mp4: { exists: true, width: 1920, height: 1080, durationSeconds: 6 },
    lintDurationSeconds: 6,
    frames: [
      { t: 0.6, uniform: false },
      { t: 3, uniform: false },
      { t: 5.4, uniform: false },
    ],
  };
}

const failed = (input: EvalInput): string[] => evaluateCriteria(input).checks.filter((c) => !c.ok).map((c) => c.name);

test("evaluateCriteria: relatório bom passa em todos os critérios", () => {
  const verdict = evaluateCriteria(good());
  assert.equal(verdict.pass, true);
  assert.deepEqual(failed(good()), []);
});

test("evaluateCriteria: tolerâncias de 1 frame (lint) e de 0,5 s (pedido) são inclusivas", () => {
  const edge = good();
  edge.mp4.durationSeconds = 6.5;
  edge.lintDurationSeconds = 6.5 - 1 / 30;
  assert.equal(evaluateCriteria(edge).pass, true);
  edge.mp4.durationSeconds = 6.6;
  assert.deepEqual(failed(edge), ["duracao-lint", "duracao-pedida"]);
});

test("evaluateCriteria: cada falha cai no critério certo", () => {
  const cases: Array<[string, (input: EvalInput) => void, string[]]> = [
    ["generate falhou", (i) => (i.generateOk = false), ["generate"]],
    ["MP4 ausente", (i) => (i.mp4 = { exists: false }), ["mp4", "duracao-lint", "formato", "duracao-pedida"]],
    ["duração do MP4 ≠ lint por mais de 1 frame", (i) => (i.lintDurationSeconds = 6.05), ["duracao-lint"]],
    ["lint não resolveu a duração", (i) => (i.lintDurationSeconds = null), ["duracao-lint"]],
    ["formato errado", (i) => ((i.mp4.width = 1080), (i.mp4.height = 1920)), ["formato"]],
    ["duração pedida errada", (i) => ((i.mp4.durationSeconds = 8), (i.lintDurationSeconds = 8)), ["duracao-pedida"]],
    ["frame chapado", (i) => (i.frames[1]!.uniform = true), ["frames"]],
    ["faltam frames", (i) => (i.frames = i.frames.slice(0, 2)), ["frames"]],
    ["edição manual", (i) => (i.entryMatchesLastAttempt = false), ["sem-edicao-manual"]],
  ];
  for (const [label, mutate, expected] of cases) {
    const input = good();
    mutate(input);
    assert.deepEqual(failed(input), expected, label);
    assert.equal(evaluateCriteria(input).pass, false, label);
  }
});

test("evaluateCriteria: vertical 9:16 exige 1080x1920", () => {
  const vertical = good();
  vertical.expected = { width: 1080, height: 1920, fps: 30, durationSeconds: 6 };
  assert.deepEqual(failed(vertical), ["formato"], "MP4 16:9 num pedido 9:16");
  vertical.mp4.width = 1080;
  vertical.mp4.height = 1920;
  assert.equal(evaluateCriteria(vertical).pass, true);
});

test("sem --real o script sai com 2 e não chama o Codex", async () => {
  try {
    await run(process.execPath, [SCRIPT], { encoding: "utf8", env: { ...process.env, FRANKFRAMES_CODEX: "" } });
    assert.fail("devia sair com 2");
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    assert.equal(failure.code, 2);
    assert.ok(failure.stderr?.includes(NEEDS_REAL), failure.stderr ?? "sem stderr");
  }
  assert.equal(NEEDS_REAL, "este script chama o Codex real; passe --real");
});

test("pedidos.json: os 5 pedidos de aceite, cada um com id, formato e duração", () => {
  const pedidos = JSON.parse(readFileSync(PEDIDOS, "utf8")) as Array<{ id: string; pedido: string; format: string; durationSeconds: number }>;
  assert.equal(pedidos.length, 5);
  assert.equal(new Set(pedidos.map((p) => p.id)).size, 5);
  for (const p of pedidos) {
    assert.ok(["16:9", "9:16", "1:1"].includes(p.format), p.id);
    assert.ok(p.durationSeconds > 0 && p.pedido.length > 0, p.id);
  }
});
