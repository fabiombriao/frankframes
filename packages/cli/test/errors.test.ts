// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { toErrorPayload } from "@frankframes/producer";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("render --json devolve código estável e sem caminho absoluto", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-err-"));
  const entry = join(dir, "index.html");
  await writeFile(entry, `<div data-composition-id="quebrada" data-root="true"><div data-start="ontem" data-duration="1"></div></div>`);

  const result = await run(process.execPath, [CLI, "render", entry, "--json"], { encoding: "utf8" }).catch(
    (error: { stdout?: string }) => error,
  );
  const payload = JSON.parse((result as { stdout: string }).stdout) as { ok: boolean; code: string; message: string };

  assert.equal(payload.ok, false);
  assert.equal(payload.code, "E_CONTRACT");
  assert.ok(!/[A-Za-z]:\\/.test(payload.message), `mensagem vazou caminho: ${payload.message}`);
});

test("payload de erro nunca inventa código", () => {
  const payload = toErrorPayload(new Error("qualquer coisa em C:\\Users\\x\\y.mp4 falhou"));
  assert.equal(payload.code, "E_INTERNAL");
  assert.equal(payload.stage, null);
  assert.ok(!payload.message.includes("C:\\Users"));
});
