// FrankFrames — proprietário. Ver LICENSE na raiz.
// Servidor do Studio (EDT-85): abre pausado, serve o inspetor e importa mídia com a duração exata do probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveFfmpeg } from "@frankframes/producer";
import { startStudio } from "../src/studio-server.ts";
import { withTempDir } from "../../../scripts/test-support/temp.ts";

const HTML = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>teste</title></head>
<body style="margin:0;background:#000">
<div data-composition-id="teste" data-width="640" data-height="360" data-fps="30" data-duration="2">
  <div data-clip-id="a" data-start="0" data-duration="1" class="clip">Primeiro</div>
</div>
</body>
</html>
`;

/** WAV mono de 8 kHz com `samples` amostras: a duração é `samples / 8000`, sem arredondamento de arquivo. */
function wavSamples(samples: number): Buffer {
  const rate = 8000;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

test("EDT-85: o preview do Studio chega à página com autoplay false (abre pausado em 0) e serve o inspetor", () =>
  withTempDir("ff-studio-open-", async (dir) => {
    const entry = join(dir, "comp.html");
    await writeFile(entry, HTML, "utf8");
    const server = await startStudio({ entry });
    try {
      const preview = await (await fetch(`${server.url}preview`)).text();
      const meta = /window\.__ffPreviewMeta=(\{.*?\});<\/script>/.exec(preview);
      assert.ok(meta, "o preview precisa trazer __ffPreviewMeta");
      const parsed = JSON.parse(meta[1] as string) as { autoplay?: boolean; reload?: boolean };
      assert.equal(parsed.autoplay, false, "sem isto a barra liga o relógio ao abrir");
      assert.equal(parsed.reload, false);

      const inspector = await fetch(`${server.url}inspector.js`);
      assert.equal(inspector.status, 200);
      assert.match(inspector.headers.get("content-type") ?? "", /javascript/);
      assert.match(await inspector.text(), /export function numericChanges/);
    } finally {
      await server.close();
    }
  }));

test("EDT-85: importar áudio grava a duração com a precisão do probe (1,234625 não vira 1.235)", async (t) => {
  try {
    await resolveFfmpeg();
  } catch (error) {
    t.skip(`ffprobe indisponível: ${(error as Error).message}`);
    return;
  }
  await withTempDir("ff-studio-exact-", async (dir) => {
    const entry = join(dir, "comp.html");
    await writeFile(entry, HTML, "utf8");
    const server = await startStudio({ entry });
    try {
      const response = await fetch(`${server.url}api/media?name=exata.wav&start=0`, { method: "POST", body: new Uint8Array(wavSamples(9877)) });
      const json = (await response.json()) as { duration: number; id: string };
      assert.equal(response.status, 200, JSON.stringify(json));
      assert.equal(json.duration, 1.234625, "9877 amostras a 8 kHz");
      assert.notEqual(json.duration, Math.round(json.duration * 1000) / 1000, "a fixture precisa ser sensível ao arredondamento");
      const html = await readFile(entry, "utf8");
      assert.match(html, new RegExp(`data-clip-id="${json.id}"[^>]*data-duration="1\\.234625"`), html);
    } finally {
      await server.close();
    }
  });
});
