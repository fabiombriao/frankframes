// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSession, openSessionFor, resolveChrome, startServer } from "../src/index.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function firstFrame(page: string): Promise<{ hash: string; check: boolean }> {
  const server = await startServer(FIXTURES);
  const session = await openSessionFor(server, { url: `${server.url}${page}`, viewport: { width: 640, height: 360 }, gpu: "auto" });
  try {
    await session.seekFrame(0, { num: 30, den: 1 });
    const check = await session.evaluate<boolean>(`document.fonts.check('600 32px "Poppins"')`);
    const { sha256 } = await session.capture();
    return { hash: sha256, check };
  } finally {
    await session.close();
    await server.close();
  }
}

test("fontes embarcadas são aplicadas (senão o fallback teria o mesmo pixel)", { timeout: 300_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }

  const bundled = await firstFrame("fonts-inter.html");
  const fallback = await firstFrame("fonts-fallback.html");

  assert.equal(bundled.check, true, "Poppins (catálogo) precisa estar carregada antes do frame 0");
  assert.notEqual(
    bundled.hash,
    fallback.hash,
    "render com fonte embarcada igual ao fallback: a fonte não foi aplicada",
  );
});
