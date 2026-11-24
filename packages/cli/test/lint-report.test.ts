// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { lintReport } from "../src/lint-report.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const HELLO = resolve(fileURLToPath(new URL("../../../examples/hello.html", import.meta.url)));

test("lintReport é, byte a byte, o que `lint --json` imprime", async () => {
  const { stdout } = await run(process.execPath, [CLI, "lint", HELLO, "--json"], { encoding: "utf8" });
  const expected = `${JSON.stringify(lintReport(readFileSync(HELLO, "utf8"), HELLO), null, 2)}\n`;
  assert.equal(stdout, expected);
  const parsed = JSON.parse(stdout) as { ok: boolean; clips: unknown[]; diagnostics: unknown[] };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.clips.length, 2);
});

test("lintReport de HTML sem raiz traz E_NO_ROOT e ok:false", () => {
  const report = lintReport("<div>oi</div>", "x.html");
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some((d) => d.code === "E_NO_ROOT"));
});
