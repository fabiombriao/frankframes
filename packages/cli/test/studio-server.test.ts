// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadComposition } from "@frankframes/contract";
import { startStudio } from "../src/studio-server.ts";
import type { StudioServer } from "../src/studio-server.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

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

test("estúdio lê, edita, insere clips e serve a prévia", async (t) => {
  const dir = await tempDir(t, "ff-studio-test-");
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

test("GET /api/composition devolve track, kind, mídia, parentId e editable", async (t) => {
  const dir = await tempDir(t, "ff-studio-test-");
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
  }
});

test("o Studio serve timeline-math.js como JavaScript", async (t) => {
  const dir = await tempDir(t, "ff-studio-test-");
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
  }
});

test("POST /api/clips/<id>/transition grava, entra no histórico e recusa corpo inválido", async (t) => {
  const dir = await tempDir(t, "ff-studio-transition-");
  const entry = join(dir, "comp.html");
  await writeFile(entry, HTML, "utf8");
  let server: StudioServer | undefined;
  const send = async (id: string, body: unknown) => {
    const response = await fetch(`${server!.url}api/clips/${id}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  const undo = () =>
    fetch(`${server!.url}api/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  try {
    server = await startStudio({ entry });
    const initial = await readFile(entry, "utf8");

    const created = await send("b", { preset: "dissolver", dur: 0.5 });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const written = await readFile(entry, "utf8");
    assert.match(written, /data-start="a - 0\.5"/);
    assert.match(written, /data-transition="dissolver"/);
    assert.equal(loadComposition(written).ok, true);

    const composition = (await (await fetch(`${server.url}api/composition`)).json()) as {
      clips: Array<{ id: string; start: number | null; motion: Record<string, Record<string, unknown>> }>;
    };
    const b = composition.clips.find((clip) => clip.id === "b");
    assert.equal(b?.start, 0.5);
    assert.deepEqual(
      { preset: b?.motion.transition?.preset, dur: b?.motion.transition?.dur, partner: b?.motion.transition?.partner },
      { preset: "dissolver", dur: 0.5, partner: "a" },
    );
    assert.equal(composition.clips.find((clip) => clip.id === "a")?.motion.transition, undefined);

    const longer = await send("b", { preset: "dissolver", dur: 0.8 });
    assert.equal(longer.status, 200);
    assert.match(await readFile(entry, "utf8"), /data-start="a - 0\.8"/);

    assert.equal((await undo()).status, 200);
    assert.equal(await readFile(entry, "utf8"), written, "desfazer volta à duração anterior");
    assert.equal((await undo()).status, 200);
    assert.equal(await readFile(entry, "utf8"), initial, "e à composição sem transição");

    const negative = await send("b", { preset: "dissolver", dur: -1 });
    assert.equal(negative.status, 400);
    assert.equal(negative.json.code, "E_ATTRIBUTE_INVALID");
    assert.equal((await send("b", { preset: "subir", dur: 0.5 })).status, 400, "preset que não é de transição");
    assert.equal((await send("b", { preset: "dissolver", dur: 5 })).status, 400, "sobreposição maior que os clips");
    const badDir = await send("b", { preset: "cortina", dur: 0.5, params: { dir: "diagonal" } });
    assert.equal(badDir.status, 400, "o contrato recusa dir inválido");
    assert.equal(badDir.json.code, "E_CONTRACT_INVALID");
    const noPreset = await send("b", { dur: 0.5 });
    assert.equal(noPreset.status, 400);
    assert.equal(noPreset.json.code, "E_BODY_INVALID");
    const gap = await send("a", { preset: "dissolver", dur: 0.5 });
    assert.equal(gap.status, 400);
    assert.equal(gap.json.code, "E_TRANSITION_GAP");
    assert.equal(await readFile(entry, "utf8"), initial, "pedidos recusados não tocam no arquivo");
  } finally {
    await server?.close();
  }
});
