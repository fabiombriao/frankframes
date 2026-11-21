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

const MIXED = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>mix</title></head>
<body style="margin:0;background:#000">
<div data-composition-id="mix" data-width="640" data-height="360" data-fps="30" data-duration="4">
  <audio data-clip-id="a" data-track="3" src="a.wav" data-start="0" data-duration="1" data-fade-in="0.2"></audio>
  <video data-clip-id="v" data-has-audio="false" src="v.mp4" data-start="1" data-duration="1"></video>
  <div data-clip-id="titulo" data-start="2" data-duration="1">Oi</div>
  <div data-composition-id="cena" data-start="0" data-duration="2">
    <div data-clip-id="t" data-start="0" data-duration="1">Texto aninhado</div>
  </div>
</div>
</body>
</html>
`;

interface RichClip {
  id: string;
  tag: string;
  track: number;
  kind: string;
  hasAudio: boolean;
  mediaSrc: string | null;
  fadeIn: number | null;
  fadeOut: number | null;
  hasKeyframes: boolean;
  hasChildren: boolean;
  parentId: string | null;
  editable: boolean;
}

test("GET /api/composition devolve track, kind, mídia, parentId e editable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-studio-test-"));
  const entry = join(dir, "mix.html");
  await writeFile(entry, MIXED, "utf8");
  let server: StudioServer | undefined;
  try {
    server = await startStudio({ entry });
    const payload = (await (await fetch(`${server.url}api/composition`)).json()) as { clips: RichClip[] };
    const byId = new Map(payload.clips.map((clip) => [clip.id, clip]));

    const audio = byId.get("a");
    assert.ok(audio !== undefined);
    assert.equal(audio.kind, "audio");
    assert.equal(audio.track, 3);
    assert.equal(audio.hasAudio, true);
    assert.equal(audio.mediaSrc, "a.wav");
    assert.equal(audio.fadeIn, 0.2);
    assert.equal(audio.fadeOut, null);
    assert.equal(audio.parentId, null);
    assert.equal(audio.editable, true);

    const video = byId.get("v");
    assert.ok(video !== undefined);
    assert.equal(video.kind, "video");
    assert.equal(video.hasAudio, false);

    const title = byId.get("titulo");
    assert.ok(title !== undefined);
    assert.equal(title.kind, "text");
    assert.equal(title.hasKeyframes, false);
    assert.equal(title.hasChildren, false);

    const host = byId.get("cena");
    assert.ok(host !== undefined);
    assert.equal(host.kind, "video", "host de sub-composição conta como vídeo");
    assert.equal(host.hasChildren, true);
    assert.equal(host.editable, false, "host sem data-clip-id explícito não é editável");

    const nested = byId.get("t");
    assert.ok(nested !== undefined);
    assert.equal(nested.parentId, "cena");
    assert.equal(nested.editable, false, "clip aninhado nunca é editável");
    assert.equal(nested.kind, "text");
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("o Studio serve timeline-math.js como JavaScript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-studio-test-"));
  const entry = join(dir, "comp.html");
  await writeFile(entry, HTML, "utf8");
  let server: StudioServer | undefined;
  try {
    server = await startStudio({ entry });
    const response = await fetch(`${server.url}timeline-math.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
    assert.match(await response.text(), /export function lastFrameTime/);
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
