// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openSession, resolveChrome, startServer } from "../src/index.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

test("imagem do autor que não carrega falha a sessão", { timeout: 120_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  const dir = await tempDir(t, "ff-img-");
  await writeFile(
    join(dir, "index.html"),
    `<html><body><div data-composition-id="x" data-root="true" data-duration="1">
      <img src="nao-existe.png" data-start="0" data-duration="1">
    </div></body></html>`,
  );

  const server = await startServer(dir);
  try {
    await assert.rejects(
      openSession({ url: server.url, viewport: { width: 320, height: 200 }, gpu: "auto" }),
      /não decodificou/,
      "imagem ausente não pode passar em silêncio",
    );
  } finally {
    await server.close();
  }
});
