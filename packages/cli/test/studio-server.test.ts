// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadComposition } from "@frankframes/contract";
import { startStudio } from "../src/studio-server.ts";
import type { StudioServer } from "../src/studio-server.ts";

const HTML = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>teste</title></head>
<body style="margin:0;background:#000">
<div data-composition-id="teste" data-width="640" data-height="360" data-fps="30" data-duration="2">
  <div data-clip-id="a" data-start="0" data-duration="1" class="clip">Primeiro</div>
  <div data-clip-id="b" data-start="1" data-duration="1" class="clip">Segundo</div>
</div>
</body>
</html>
`;

interface CompositionPayload {
  entry: string;
  id: string;
  fps: { num: number; den: number };
  duration: number | null;
  clips: Array<{
    id: string;
    tag: string;
    start: number | null;
    duration: number | null;
    end: number | null;
    playbackRate: number;
    text: string | null;
  }>;
  diagnostics: unknown[];
}

test("estúdio lê, edita, insere clips e serve a prévia", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-studio-test-"));
  const entry = join(dir, "comp.html");
  await writeFile(entry, HTML, "utf8");
  let server: StudioServer | undefined;
  try {
    server = await startStudio({ entry });

    const composition = await fetch(`${server.url}api/composition`);
    assert.equal(composition.status, 200);
    assert.equal(composition.headers.get("cache-control"), "no-store");
    const payload = (await composition.json()) as CompositionPayload;
    assert.equal(payload.duration, 2);
    assert.equal(payload.clips.length, 2);
    const a = payload.clips.find((clip) => clip.id === "a");
    assert.ok(a !== undefined);
    assert.equal(a.duration, 1);
    assert.equal(a.start, 0);
    assert.equal(a.playbackRate, 1);
    assert.equal(a.text, "Primeiro");

    const patch = await fetch(`${server.url}api/clips/a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attributes: { "data-duration": "0.5" } }),
    });
    assert.equal(patch.status, 200);
    const patched = (await patch.json()) as { ok: boolean; duration: number | null; diagnostics: unknown[] };
    assert.equal(patched.ok, true);
    assert.ok(Array.isArray(patched.diagnostics));
    const afterPatch = await readFile(entry, "utf8");
    assert.ok(afterPatch.includes('data-duration="0.5"'), "o arquivo precisa conter o novo valor");

    const invalid = await fetch(`${server.url}api/clips/a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attributes: { "data-start": "abc" } }),
    });
    assert.equal(invalid.status, 400);
    const invalidBody = (await invalid.json()) as { code: string; message: string };
    assert.equal(invalidBody.code, "E_CONTRACT_INVALID");
    assert.equal(await readFile(entry, "utf8"), afterPatch, "patch inválido não pode tocar no arquivo");

    const inserted = await fetch(`${server.url}api/clips`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "title", start: 0, duration: 0.75 }),
    });
    assert.equal(inserted.status, 200);
    const insertedBody = (await inserted.json()) as { ok: boolean; id: string };
    assert.equal(insertedBody.ok, true);
    assert.match(insertedBody.id, /^clip-\d+$/);
    const loaded = loadComposition(await readFile(entry, "utf8"));
    assert.ok(loaded.clips.some((clip) => clip.id === insertedBody.id), "o contrato precisa ver o clip novo");

    const interfaceResponse = await fetch(`${server.url}`);
    assert.ok([200, 503].includes(interfaceResponse.status), `status inesperado: ${interfaceResponse.status}`);
    if (interfaceResponse.status === 503) assert.equal(await interfaceResponse.text(), "interface ausente\n");

    const preview = await fetch(`${server.url}preview`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-type") ?? "", /text\/html/);
    const previewHtml = await preview.text();
    assert.ok(previewHtml.includes("__ff"));
    assert.ok(previewHtml.includes("/__ff_fonts"));
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
