// FrankFrames — proprietário. Ver LICENSE na raiz.
// Studio: rotas de presets de movimento e escrita de data-enter pelo POST de clip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface PresetItem {
  name: string;
  label: string;
  dur: number;
  curve: string;
  keys: Record<string, unknown>;
}

async function withStudio(run: (server: StudioServer, entry: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ff-studio-motion-"));
  const entry = join(dir, "comp.html");
  await writeFile(entry, HTML, "utf8");
  let server: StudioServer | undefined;
  try {
    server = await startStudio({ entry });
    await run(server, entry);
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function post(server: StudioServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("GET /api/motion/presets lista os presets por tipo, cada um com label", async () => {
  await withStudio(async (server) => {
    const response = await fetch(`${server.url}api/motion/presets`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, PresetItem[]>;
    const counts = Object.fromEntries(Object.entries(body).map(([kind, list]) => [kind, list.length]));
    assert.deepEqual(counts, { enter: 12, exit: 8, emphasis: 6, camera: 5, transition: 5 });
    for (const list of Object.values(body)) {
      for (const preset of list) {
        assert.ok(preset.name.length > 0);
        assert.ok(preset.label.length > 0, `${preset.name} sem label`);
        assert.equal(typeof preset.keys, "object");
      }
    }
    const subir = body.enter?.find((preset) => preset.name === "subir");
    assert.ok(subir !== undefined);
    assert.equal(subir.dur, 0.6);
  });
});

test("GET /__ff_motion/<nome>.gif serve a miniatura e recusa nome fora da lista", async () => {
  await withStudio(async (server) => {
    const ok = await fetch(`${server.url}__ff_motion/subir.gif`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/gif");
    const bytes = Buffer.from(await ok.arrayBuffer());
    assert.equal(bytes.subarray(0, 3).toString("latin1"), "GIF");

    const traversal = await fetch(`${server.url}__ff_motion/../x.gif`);
    assert.equal(traversal.status, 404);
    // fetch normaliza "..", então o caminho codificado é o que realmente chega ao servidor
    const encoded = await fetch(`${server.url}__ff_motion/..%2F..%2Fpackage.gif`);
    assert.equal(encoded.status, 404);
    const unknown = await fetch(`${server.url}__ff_motion/naoexiste.gif`);
    assert.equal(unknown.status, 404);
  });
});

test("POST /api/clips/<id> grava data-enter, entra no histórico e o undo remove", async () => {
  await withStudio(async (server, entry) => {
    const patch = await post(server, "api/clips/a", { attributes: { "data-enter": "subir dur=0.7" } });
    assert.equal(patch.status, 200);
    assert.ok((await readFile(entry, "utf8")).includes('data-enter="subir dur=0.7"'));

    const composition = (await (await fetch(`${server.url}api/composition`)).json()) as {
      clips: Array<{ id: string; motion: Record<string, { raw: string; preset: string | null; params: Record<string, string> }> }>;
    };
    const a = composition.clips.find((clip) => clip.id === "a");
    assert.equal(a?.motion.enter?.preset, "subir");
    assert.equal(a?.motion.enter?.params.dur, "0.7");
    assert.equal(a?.motion.exit, undefined, "só aparecem as chaves presentes no HTML");
    const b = composition.clips.find((clip) => clip.id === "b");
    assert.deepEqual(b?.motion, {});

    const undo = await post(server, "api/undo", {});
    assert.equal(undo.status, 200);
    assert.ok(!(await readFile(entry, "utf8")).includes("data-enter"), "undo remove o atributo");

    const removed = await post(server, "api/clips/a", { attributes: { "data-enter": null } });
    assert.equal(removed.status, 200);
  });
});

test("preset desconhecido falha com E_MOTION_PRESET_UNKNOWN e não toca no arquivo", async () => {
  await withStudio(async (server, entry) => {
    const before = await readFile(entry, "utf8");
    const response = await post(server, "api/clips/a", { attributes: { "data-enter": "voar" } });
    assert.ok(response.status >= 400 && response.status < 500, `status ${response.status}`);
    assert.match(await response.text(), /E_MOTION_PRESET_UNKNOWN/);
    assert.equal(await readFile(entry, "utf8"), before);
  });
});
