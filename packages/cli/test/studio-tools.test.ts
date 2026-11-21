// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadComposition } from "@frankframes/contract";
import { resolveFfmpeg } from "@frankframes/producer";
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

type Reply = { status: number; json: Record<string, unknown> };

async function post(url: string, body: unknown): Promise<Reply> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function upload(server: StudioServer, name: string, body: Buffer, start = 0): Promise<Reply> {
  const response = await fetch(`${server.url}api/media?name=${encodeURIComponent(name)}&start=${start}`, { method: "POST", body: new Uint8Array(body) });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function withStudio(run: (server: StudioServer, dir: string, entry: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ff-studio-test-"));
  const entry = join(dir, "comp.html");
  await writeFile(entry, HTML, "utf8");
  let server: StudioServer | undefined;
  try {
    server = await startStudio({ entry });
    await run(server, dir, entry);
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("estúdio desfaz, refaz, divide e recusa histórico velho", () =>
  withStudio(async (server, _dir, entry) => {
    const empty = (await (await fetch(`${server.url}api/history`)).json()) as { canUndo: boolean };
    assert.equal(empty.canUndo, false);

    const edited = await post(`${server.url}api/clips/a`, { attributes: { "data-duration": "0.5" } });
    assert.equal(edited.status, 200);
    assert.equal((edited.json.history as { undo: string }).undo, "editar a");
    const afterEdit = await readFile(entry, "utf8");

    const undone = await post(`${server.url}api/undo`, {});
    assert.equal(undone.status, 200);
    assert.equal(undone.json.changed, true);
    assert.equal(await readFile(entry, "utf8"), HTML, "desfazer volta ao arquivo original byte a byte");

    const redone = await post(`${server.url}api/redo`, {});
    assert.equal(redone.json.changed, true);
    assert.equal(await readFile(entry, "utf8"), afterEdit);

    const nothing = await post(`${server.url}api/redo`, {});
    assert.equal(nothing.json.changed, false, "refazer sem passo pendente não grava");

    const split = await post(`${server.url}api/clips/b/split`, { at: 1.25 });
    assert.equal(split.status, 200, JSON.stringify(split.json));
    const splitComposition = loadComposition(await readFile(entry, "utf8"));
    assert.equal(splitComposition.ok, true);
    const second = splitComposition.clips.find((clip) => clip.id === split.json.id);
    assert.ok(second !== undefined, "segunda metade existe");
    assert.equal(second.start, 1.25);
    assert.equal(second.end, 2);
    assert.equal(splitComposition.clips.find((clip) => clip.id === "b")?.end, 1.25);

    const outside = await post(`${server.url}api/clips/b/split`, { at: 1.9 });
    assert.equal(outside.status, 400);
    assert.equal(outside.json.code, "E_SPLIT_OUT_OF_RANGE");

    await post(`${server.url}api/undo`, {});
    assert.equal(await readFile(entry, "utf8"), afterEdit, "desfazer o corte devolve o clip inteiro");

    // Mudança feita fora do Studio: desfazer não pode atropelar.
    const external = afterEdit.replace("Segundo", "Editado fora");
    await writeFile(entry, external, "utf8");
    const stale = await post(`${server.url}api/undo`, {});
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, "E_HISTORY_STALE");
    assert.equal(await readFile(entry, "utf8"), external, "arquivo editado fora fica intacto");
    const cleared = (await (await fetch(`${server.url}api/history`)).json()) as { canUndo: boolean; canRedo: boolean };
    assert.deepEqual([cleared.canUndo, cleared.canRedo], [false, false]);
  }));

// PNG 1x1 transparente.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** WAV PCM mono 8 kHz: silêncio, ou um tom de 440 Hz quando `amplitude` > 0. */
function wav(seconds: number, amplitude = 0): Buffer {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
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
  if (amplitude > 0) for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * amplitude), 44 + i * 2);
  return buffer;
}

test("estúdio importa imagem para assets/, reaproveita cópia idêntica e serve no preview", () =>
  withStudio(async (server, dir, entry) => {
    await writeFile(join(dir, ".env"), "SEGREDO=1", "utf8");
    const first = await upload(server, "Logo Final ção.PNG", PNG, 0.5);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.src, "assets/Logo-Final-cao.png");
    assert.equal(first.json.kind, "img");
    assert.equal(first.json.duration, 3);
    assert.equal(first.json.reused, false);
    assert.deepEqual(await readFile(join(dir, "assets", "Logo-Final-cao.png")), PNG);

    const composition = loadComposition(await readFile(entry, "utf8"));
    assert.equal(composition.ok, true);
    const clip = composition.clips.find((item) => item.id === first.json.id);
    assert.ok(clip !== undefined);
    assert.equal(clip.start, 0.5);
    assert.equal(clip.mediaSrc, "assets/Logo-Final-cao.png");

    const again = await upload(server, "Logo Final ção.PNG", PNG);
    assert.equal(again.json.reused, true, "mesmo conteúdo reaproveita o arquivo");
    assert.equal(again.json.src, first.json.src);

    const different = await upload(server, "Logo Final ção.PNG", Buffer.concat([PNG, Buffer.from([0])]));
    assert.match(String(different.json.src), /^assets\/Logo-Final-cao-[0-9a-f]{8}\.png$/, "nome igual com conteúdo diferente não sobrescreve");

    const unsupported = await upload(server, "planilha.xlsx", Buffer.from("x"));
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.json.code, "E_MEDIA_UNSUPPORTED");

    const emptyFile = await upload(server, "vazio.png", Buffer.alloc(0));
    assert.equal(emptyFile.status, 400);
    assert.equal(emptyFile.json.code, "E_MEDIA_EMPTY");

    const previewHtml = await (await fetch(`${server.url}preview`)).text();
    assert.ok(previewHtml.includes('<base href="/__ff_site/">'), "preview resolve caminhos relativos no projeto");
    const asset = await fetch(`${server.url}__ff_site/assets/Logo-Final-cao.png`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "image/png");
    assert.equal((await fetch(`${server.url}__ff_site/.env`)).status, 403, "arquivo oculto nunca é servido");

    const before = loadComposition(await readFile(entry, "utf8")).clips.length;
    const undone = await post(`${server.url}api/undo`, {});
    assert.equal(undone.status, 200);
    assert.equal(loadComposition(await readFile(entry, "utf8")).clips.length, before - 1, "desfazer remove só a última importação");
  }));

test("estúdio importa áudio medindo a duração com ffprobe", async (t) => {
  try {
    await resolveFfmpeg();
  } catch (error) {
    t.skip(`ffprobe indisponível: ${(error as Error).message}`);
    return;
  }
  await withStudio(async (server, dir, entry) => {
    const imported = await upload(server, "trilha.wav", wav(1.5), 0.25);
    assert.equal(imported.status, 200, JSON.stringify(imported.json));
    assert.equal(imported.json.kind, "audio");
    assert.ok(Math.abs(Number(imported.json.duration) - 1.5) < 0.01, `duração medida: ${String(imported.json.duration)}`);
    const clip = loadComposition(await readFile(entry, "utf8")).clips.find((item) => item.id === imported.json.id);
    assert.equal(clip?.tag, "audio");
    assert.equal(clip?.start, 0.25);

    const broken = await upload(server, "quebrado.mp3", Buffer.from("isto não é áudio"));
    assert.equal(broken.status, 400);
    assert.equal(broken.json.code, "E_MEDIA_PROBE");
    await assert.rejects(readFile(join(dir, "assets", "quebrado.mp3")), "arquivo ilegível não fica no projeto");
  });
});

const AUDIO_HTML = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>teste</title></head>
<body style="margin:0;background:#000">
<div data-composition-id="teste-audio" data-width="640" data-height="360" data-fps="30" data-duration="2">
  <audio data-clip-id="musica" src="assets/musica.wav" data-start="0" data-duration="1.5" data-volume="0.5"></audio>
</div>
</body>
</html>
`;

/** Estúdio com cache de áudio próprio: o teste nunca toca o cache do usuário. */
async function withAudioStudio(html: string, run: (server: StudioServer, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ff-studio-audio-"));
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "assets", "musica.wav"), wav(1.5, 12000)); // tom: loudnorm não mede silêncio
  const entry = join(dir, "comp.html");
  await writeFile(entry, html, "utf8");
  let server: StudioServer | undefined;
  try {
    server = await startStudio({ entry, audioCacheDir: join(dir, "cache-audio") });
    await run(server, dir);
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("estúdio injeta o mix do preview e serve o WAV pela chave", async (t) => {
  try {
    await resolveFfmpeg();
  } catch (error) {
    t.skip(`ffmpeg indisponível: ${(error as Error).message}`);
    return;
  }
  await withAudioStudio(AUDIO_HTML, async (server) => {
    const html = await (await fetch(`${server.url}preview`)).text();
    const match = /window\.__ffPreviewAudio=(\{[^;]*\});/.exec(html);
    assert.ok(match !== null, "o preview carrega a configuração de áudio");
    const config = JSON.parse(match[1]!.replaceAll("\u003c", "<")) as { src?: string; error?: string };
    assert.equal(config.error, undefined, config.error ?? "sem erro");
    assert.match(config.src ?? "", /^\/__ff_audio\/[0-9a-f]{64}\.wav$/);

    const response = await fetch(`${server.url}${config.src!.slice(1)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.subarray(0, 4).toString("latin1"), "RIFF");
    assert.equal(body.subarray(8, 12).toString("latin1"), "WAVE");
  });
});

test("estúdio sem faixa de áudio não injeta mix e recusa nomes fora da chave", () =>
  withStudio(async (server) => {
    const html = await (await fetch(`${server.url}preview`)).text();
    assert.ok(!html.includes("__ffPreviewAudio"), "sem áudio, sem runtime");
    for (const name of ["../x.wav", "..%2Fx.wav", "musica.wav", `${"a".repeat(64)}.mp3`, `${"A".repeat(64)}.wav`, `${"a".repeat(64)}.wav`]) {
      const response = await fetch(`${server.url}__ff_audio/${name}`);
      assert.equal(response.status, 404, `${name} → ${response.status}`);
    }
  }));

test("estúdio mostra falha do mix no preview sem derrubar o vídeo", async (t) => {
  try {
    await resolveFfmpeg();
  } catch (error) {
    t.skip(`ffmpeg indisponível: ${(error as Error).message}`);
    return;
  }
  await withAudioStudio(AUDIO_HTML.replace("assets/musica.wav", "assets/falta.wav"), async (server) => {
    const response = await fetch(`${server.url}preview`);
    assert.equal(response.status, 200, "o vídeo carrega mesmo com o áudio quebrado");
    const html = await response.text();
    assert.match(html, /E_PREVIEW_AUDIO: arquivo de áudio não encontrado: assets.{1,2}falta\.wav/); // o separador sai escapado no JSON
  });
});

// EDT-41: excluir clip sem mover o resto.
test("estúdio exclui um clip, não move o resto e desfaz byte a byte", () =>
  withStudio(async (server, _dir, entry) => {
    const chained = HTML.replace('data-clip-id="b" data-start="1"', 'data-clip-id="b" data-start="a"');
    await writeFile(entry, chained, "utf8");
    const before = loadComposition(chained).clips.map((clip) => [clip.id, clip.start]);

    const removed = await post(`${server.url}api/clips/a/delete`, {});
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.equal(removed.json.id, "a");
    assert.equal((removed.json.history as { undo: string }).undo, "excluir a");
    const after = await readFile(entry, "utf8");
    assert.ok(!after.includes('data-clip-id="a"'), "a saiu do arquivo");
    const composition = loadComposition(after);
    assert.equal(composition.ok, true);
    assert.deepEqual(
      composition.clips.map((clip) => [clip.id, clip.start]),
      before.filter(([id]) => id !== "a"),
      "b continua no mesmo instante",
    );

    const undone = await post(`${server.url}api/undo`, {});
    assert.equal(undone.status, 200);
    assert.equal(await readFile(entry, "utf8"), chained, "desfazer restaura o arquivo byte a byte");

    const missing = await post(`${server.url}api/clips/zzz/delete`, {});
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "E_CLIP_NOT_FOUND");
    assert.equal(await readFile(entry, "utf8"), chained, "falha não grava");
  }));

test("estúdio recusa excluir o único clip de uma raiz sem data-duration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-studio-test-"));
  const entry = join(dir, "solo.html");
  const solo = HTML.replace(' data-duration="2">', ">").replace(/\s*<div data-clip-id="b"[^<]*<\/div>/, "");
  assert.ok(!solo.includes('data-clip-id="b"') && !solo.includes('data-duration="2"'), "fixture preparada");
  await writeFile(entry, solo, "utf8");
  let server: StudioServer | undefined;
  try {
    server = await startStudio({ entry });
    const refused = await post(`${server.url}api/clips/a/delete`, {});
    assert.equal(refused.status, 400, JSON.stringify(refused.json));
    assert.equal(refused.json.code, "E_CONTRACT_INVALID");
    assert.equal(await readFile(entry, "utf8"), solo, "arquivo intacto");
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
