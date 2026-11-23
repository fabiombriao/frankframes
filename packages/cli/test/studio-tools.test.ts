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

// EDT-42: aparar pela borda esquerda.
test("estúdio apara o início de um vídeo, mantém o fim e desfaz byte a byte", () =>
  withStudio(async (server, _dir, entry) => {
    const media = HTML.replace(
      '<div data-clip-id="a" data-start="0" data-duration="1" class="clip">Primeiro</div>',
      '<video data-clip-id="v" src="assets/v.mp4" data-start="1" data-duration="4" data-offset="0.5" data-playback-rate="2"></video>',
    ).replace('data-duration="2"', 'data-duration="6"').replace('data-clip-id="b" data-start="1"', 'data-clip-id="b" data-start="v"');
    assert.ok(media.includes('data-clip-id="v"') && media.includes('data-start="v"'), "fixture preparada");
    await writeFile(entry, media, "utf8");
    const before = loadComposition(media).clips;

    const trimmed = await post(`${server.url}api/clips/v/trim`, { start: 2 });
    assert.equal(trimmed.status, 200, JSON.stringify(trimmed.json));
    assert.equal(trimmed.json.id, "v");
    assert.equal(trimmed.json.duration, 6);
    assert.equal((trimmed.json.history as { undo: string }).undo, "aparar v");
    const after = await readFile(entry, "utf8");
    assert.ok(after.includes('data-start="2" data-duration="3" data-offset="2.5"'), after);
    const clips = new Map(loadComposition(after).clips.map((clip) => [clip.id, clip]));
    assert.equal(clips.get("v")!.start, 2);
    assert.equal(clips.get("v")!.end, 5);
    assert.equal(clips.get("b")!.start, before.find((clip) => clip.id === "b")!.start, "b continua onde estava");

    const undone = await post(`${server.url}api/undo`, {});
    assert.equal(undone.status, 200);
    assert.equal(await readFile(entry, "utf8"), media, "desfazer restaura o arquivo byte a byte");

    // Falhas não gravam e não entram no histórico.
    const early = await post(`${server.url}api/clips/v/trim`, { start: 0 });
    assert.equal(early.status, 400);
    assert.equal(early.json.code, "E_TRIM_OUT_OF_RANGE");
    const missing = await post(`${server.url}api/clips/zzz/trim`, { start: 1 });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "E_CLIP_NOT_FOUND");
    const invalid = await post(`${server.url}api/clips/v/trim`, { start: "2" });
    assert.equal(invalid.status, 400);
    assert.equal(await readFile(entry, "utf8"), media, "falha não grava");
  }));

// ---- EDT-43: copiar, colar e duplicar ----

test("estúdio cola no instante pedido, duplica no fim do original e desfaz cada passo", () =>
  withStudio(async (server, _dir, entry) => {
    const source = HTML.replace('data-duration="2">', 'data-duration="10">').replace(
      '<div data-clip-id="b" data-start="1" data-duration="1" class="clip">Segundo</div>',
      '<div data-clip-id="b" data-start="a" data-duration="1" class="clip" id="logo">Segundo</div>',
    );
    await writeFile(entry, source, "utf8");
    const before = new Map(loadComposition(source).clips.map((clip) => [clip.id, clip.start]));

    const pasted = await post(`${server.url}api/clips/a/paste`, { at: 5 });
    assert.equal(pasted.status, 200, JSON.stringify(pasted.json));
    assert.equal(typeof pasted.json.id, "string");
    assert.deepEqual(pasted.json.warnings, []);
    assert.equal((pasted.json.history as { undo: string }).undo, "colar a");
    const afterPaste = await readFile(entry, "utf8");
    const pastedClip = loadComposition(afterPaste).clips.find((clip) => clip.id === pasted.json.id)!;
    assert.equal(pastedClip.start, 5);
    assert.equal(pastedClip.end, 6);

    const duplicated = await post(`${server.url}api/clips/b/duplicate`, {});
    assert.equal(duplicated.status, 200, JSON.stringify(duplicated.json));
    assert.deepEqual(duplicated.json.warnings, ["id HTML duplicado: logo"]);
    assert.equal((duplicated.json.history as { undo: string }).undo, "duplicar b");
    const afterDuplicate = await readFile(entry, "utf8");
    const composition = loadComposition(afterDuplicate);
    assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
    const copy = composition.clips.find((clip) => clip.id === duplicated.json.id)!;
    assert.equal(copy.start, 2, "começa no fim do original");
    assert.equal(copy.end, 3);
    for (const [id, start] of before) {
      assert.equal(composition.clips.find((clip) => clip.id === id)!.start, start, `${id} não se move`);
    }

    const undoDuplicate = await post(`${server.url}api/undo`, {});
    assert.equal(undoDuplicate.status, 200);
    assert.equal(await readFile(entry, "utf8"), afterPaste, "desfazer duplicar volta ao arquivo anterior byte a byte");
    const undoPaste = await post(`${server.url}api/undo`, {});
    assert.equal(undoPaste.status, 200);
    assert.equal(await readFile(entry, "utf8"), source, "desfazer colar volta ao original byte a byte");
  }));

test("estúdio recusa colar clip que sumiu e início inválido, sem gravar", () =>
  withStudio(async (server, _dir, entry) => {
    const deleted = await post(`${server.url}api/clips/b/delete`, {});
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
    const afterDelete = await readFile(entry, "utf8");

    const gone = await post(`${server.url}api/clips/b/paste`, { at: 1 });
    assert.equal(gone.status, 400);
    assert.equal(gone.json.code, "E_CLIP_NOT_FOUND");
    assert.equal(gone.json.message, "o clip copiado não existe mais");

    const negative = await post(`${server.url}api/clips/a/paste`, { at: -1 });
    assert.equal(negative.status, 400);
    assert.equal(negative.json.code, "E_COPY_OUT_OF_RANGE");
    const missingAt = await post(`${server.url}api/clips/a/paste`, {});
    assert.equal(missingAt.status, 400);
    assert.equal(await readFile(entry, "utf8"), afterDelete, "falha não grava");
  }));

// EDT-45: waveform pelo servidor.
test("estúdio entrega a waveform de um clip com som e recusa o que não tem", async (t) => {
  try {
    await resolveFfmpeg();
  } catch (error) {
    t.skip(`ffmpeg indisponível: ${(error as Error).message}`);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "ff-studio-wave-"));
  const entry = join(dir, "comp.html");
  let server: StudioServer | undefined;
  try {
    await writeFile(entry, HTML, "utf8");
    server = await startStudio({ entry, waveformCacheDir: join(dir, "cache-waveform") });
    const imported = await upload(server, "trilha.wav", wav(1, 12000));
    assert.equal(imported.status, 200, JSON.stringify(imported.json));

    const ok = await fetch(`${server.url}api/waveform/${String(imported.json.id)}`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { digest: string; peaksPerSecond: number; peaks: number[]; duration: number };
    assert.equal(body.peaksPerSecond, 100);
    assert.equal(body.peaks.length, 100);
    assert.ok(body.peaks.every((peak) => peak >= 0 && peak <= 255));
    assert.ok(Math.max(...body.peaks) > 80, "o tom aparece nos picos (12000 de 32767 ≈ 93)");
    assert.match(body.digest, /^[0-9a-f]{64}$/);

    const div = await fetch(`${server.url}api/waveform/a`);
    assert.equal(div.status, 400, "um <div> não tem waveform");
    assert.equal(((await div.json()) as { code: string }).code, "E_WAVEFORM_UNSUPPORTED");

    const missing = await fetch(`${server.url}api/waveform/nao-existe`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { code: string }).code, "E_CLIP_NOT_FOUND");

    // Caminho que sai da pasta da composição ou passa por segmento oculto nunca chega ao FFmpeg.
    for (const src of ["../fora.wav", ".segredo/trilha.wav", "https://exemplo.com/a.wav"]) {
      const audio = `  <audio data-clip-id="x" src="${src}" data-start="0" data-duration="1"></audio>\n`;
      await writeFile(entry, HTML.replace("</div>\n</body>", `${audio}</div>\n</body>`), "utf8");
      const response: Response = await fetch(`${server.url}api/waveform/x`);
      assert.equal(response.status, 400, `${src} → ${response.status}`);
      assert.equal(((await response.json()) as { code: string }).code, "E_WAVEFORM_UNSUPPORTED", src);
    }
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const LAYERED = HTML.replace(
  '<div data-clip-id="a" data-start="0" data-duration="1" class="clip">Primeiro</div>',
  '<div data-clip-id="a" data-start="0" data-duration="1" data-track="1" class="clip">Primeiro</div>',
);

test("estúdio grava faixa e início num PATCH só: um passo no histórico, um desfazer byte a byte (EDT-44)", () =>
  withStudio(async (server, _dir, entry) => {
    await writeFile(entry, LAYERED, "utf8");
    const moved = await post(`${server.url}api/clips/a`, { attributes: { "data-track": "3", "data-start": "0.5" } });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    assert.equal((moved.json.history as { undo: string }).undo, "editar a");
    const clip = loadComposition(await readFile(entry, "utf8")).clips.find((item) => item.id === "a")!;
    assert.equal(clip.track, 3);
    assert.equal(clip.start, 0.5);

    const undone = await post(`${server.url}api/undo`, {});
    assert.equal(undone.status, 200);
    assert.equal(await readFile(entry, "utf8"), LAYERED, "um desfazer devolve faixa e início juntos");
    const history = (await (await fetch(`${server.url}api/history`)).json()) as { canUndo: boolean };
    assert.equal(history.canUndo, false, "só havia um passo");
  }));

test("clip de título novo nasce na faixa de cima e posicionado (EDT-44)", () =>
  withStudio(async (server, _dir, entry) => {
    await writeFile(entry, LAYERED, "utf8");
    const inserted = await post(`${server.url}api/clips`, { template: "title", start: 0, duration: 1 });
    assert.equal(inserted.status, 200, JSON.stringify(inserted.json));
    const source = await readFile(entry, "utf8");
    const clip = loadComposition(source).clips.find((item) => item.id === inserted.json.id)!;
    assert.equal(clip.track, 2, "uma acima da maior faixa visual (a está na 1)");
    assert.match(source, new RegExp(`data-clip-id="${String(inserted.json.id)}"[^>]*style="position:absolute`), "sem position o z-index não vale");
  }));

test("duplicar e colar mantêm a faixa do original (EDT-44)", () =>
  withStudio(async (server, _dir, entry) => {
    await writeFile(entry, LAYERED.replace('data-duration="2">', 'data-duration="10">'), "utf8");
    const duplicated = await post(`${server.url}api/clips/a/duplicate`, {});
    assert.equal(duplicated.status, 200, JSON.stringify(duplicated.json));
    const pasted = await post(`${server.url}api/clips/a/paste`, { at: 5 });
    assert.equal(pasted.status, 200, JSON.stringify(pasted.json));
    const clips = loadComposition(await readFile(entry, "utf8")).clips;
    assert.equal(clips.find((item) => item.id === duplicated.json.id)!.track, 1);
    assert.equal(clips.find((item) => item.id === pasted.json.id)!.track, 1);
  }));

test("exportar (EDT-46): GET /api/export traz os padrões; contrato quebrado à mão bloqueia sem job", () =>
  withStudio(async (server, _dir, entry) => {
    const state = (await (await fetch(`${server.url}api/export`)).json()) as {
      job: unknown;
      defaults: { output: string; codecs: string[]; presets: string[] };
    };
    assert.equal(state.job, null);
    assert.match(state.defaults.output, /\.mp4$/);
    assert.deepEqual(state.defaults.presets, ["draft", "standard", "high"]);
    assert.ok(state.defaults.codecs.includes("av1") && state.defaults.codecs.includes("vp9"));

    await writeFile(entry, HTML.replace('data-start="0"', 'data-start="abc"'), "utf8");
    const blocked = await post(`${server.url}api/export`, { preset: "draft", output: "saida.mp4" });
    assert.equal(blocked.status, 400, JSON.stringify(blocked.json));
    assert.equal(blocked.json.code, "E_CONTRACT_INVALID");
    assert.ok(Array.isArray(blocked.json.diagnostics) && blocked.json.diagnostics.length > 0);
    const after = (await (await fetch(`${server.url}api/export`)).json()) as { job: unknown };
    assert.equal(after.job, null, "nenhum job nasce de um pedido recusado");

    const idle = await post(`${server.url}api/export/cancel`, {});
    assert.equal(idle.status, 409);
    assert.equal(idle.json.code, "E_EXPORT_IDLE");
  }));
