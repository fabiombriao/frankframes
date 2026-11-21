// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectionScript, openSession, openSessionFor, resolveChrome, startServer } from "../src/index.ts";
import type { PreviewAudioConfig } from "../src/index.ts";

/** WAV PCM mono 8 kHz com um tom de 440 Hz. */
function tone(seconds: number): Buffer {
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
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  return buffer;
}

// 6 s a 30 fps. O <audio> nativo com autoplay tem de ser silenciado: o som vem só do mix.
const PAGE = `<html><head></head><body>
  <audio id="native" src="/tone.wav" autoplay loop></audio>
  <div data-composition-id="a" data-root="true" data-duration="6">oi</div>
</body></html>`;
const META = { fps: { num: 30, den: 1 }, frames: 180 };

type Session = Awaited<ReturnType<typeof openSession>>;
type AudioState = { status: string; playing: boolean; driftMs: number; checks: number; error?: string };

const audioState = (session: Session) => session.evaluate<AudioState>("window.__ff.audioState()");

/** Espera a condição real no navegador (o `setTimeout` da página é virtual, então a espera é aqui no Node). */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  let last = await read();
  while (!done(last)) {
    if (Date.now() > deadline) throw new Error(`${what}: não aconteceu em 10 s (último valor ${JSON.stringify(last)})`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    last = await read();
  }
  return last;
}

async function withPage(
  t: { skip: (reason: string) => void },
  audio: PreviewAudioConfig,
  body: (session: Session, dir: string) => Promise<void>,
): Promise<void> {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }
  const dir = await mkdtemp(join(tmpdir(), "ff-preview-audio-"));
  await writeFile(join(dir, "index.html"), PAGE);
  await writeFile(join(dir, "tone.wav"), tone(6));
  const server = await startServer(dir, { live: true, preview: META, audio });
  const session = await openSessionFor(server, { url: server.url, viewport: { width: 640, height: 360 }, gpu: "auto" });
  try {
    await body(session, dir);
    assert.deepEqual(await session.evaluate<string[]>("window.__ff.liveErrors"), [], "nenhum erro engolido no laço");
  } finally {
    await session.close();
    await server.close();
  }
}

test("o runtime de áudio entra depois do relógio e antes da barra", () => {
  const html = injectionScript({ preview: META, audio: { src: "/__ff_audio/x.wav" } });
  const clock = html.indexOf("window.__ff =");
  const audio = html.indexOf("__ffPreviewAudio");
  const bar = html.lastIndexOf("DOMContentLoaded"); // o relógio também escuta DOMContentLoaded; a barra é o último
  assert.ok(clock >= 0 && audio > clock && bar > audio, "ordem: relógio → áudio → barra");
  assert.ok(!injectionScript({ preview: META }).includes("__ffPreviewAudio"), "sem áudio, sem runtime");
  assert.ok(!injectionScript({ preview: META, audio: { error: "</script><b>" } }).includes("</script><b>"), "mensagem de erro não fecha o <script>");
});

test("áudio do preview: carrega, toca, corrige a deriva, pausa e para no fim", { timeout: 120_000 }, (t) =>
  withPage(t, { src: "/tone.wav" }, async (session) => {
    const ready = await until(() => audioState(session), (s) => s.status === "ready", "mix chegar a ready");
    assert.equal(ready.error, undefined);

    const native = await session.evaluate<{ muted: boolean; paused: boolean }>(
      `({ muted: document.getElementById("native").muted, paused: document.getElementById("native").paused })`,
    );
    assert.deepEqual(native, { muted: true, paused: true }, "o <audio> nativo é silenciado: o som vem só do mix");

    // O preview começa tocando sozinho (a barra chama startLive).
    await until(() => audioState(session), (s) => s.playing, "o som começar a tocar");

    // Seek tocando joga o áudio para 1 s enquanto o relógio segue em ~0,5 s: a correção tem de trazê-lo de volta.
    const before = (await audioState(session)).checks;
    await session.evaluate("window.__ff.seek(1000)");
    const settled = await until(() => audioState(session), (s) => s.checks >= before + 2, "duas medições de deriva depois do seek");
    assert.ok(Math.abs(settled.driftMs) <= 1000 / 60, `deriva ${settled.driftMs.toFixed(1)} ms acima de meio frame`);
    assert.equal(settled.playing, true);

    await session.evaluate("window.__ff.stopLive()");
    assert.equal((await audioState(session)).playing, false, "pausar corta o som");

    // Chegar ao último frame (EDT-39) também para o som.
    await session.evaluate("window.__ff.seek(5800); window.__ff.startLive(5800)");
    await until(() => session.evaluate<boolean>("window.__ff.playing()"), (playing) => !playing, "o relógio chegar ao fim");
    assert.equal((await audioState(session)).playing, false, "no fim o som para");

    // Play no fim recomeça do zero, com som.
    await session.evaluate("window.__ff.seek(0); window.__ff.startLive(0)");
    await until(() => audioState(session), (s) => s.playing, "o som voltar no replay");
  }),
);

test("src do mix inexistente: erro visível na barra e em liveErrors", { timeout: 120_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }
  const dir = await mkdtemp(join(tmpdir(), "ff-preview-audio-"));
  await writeFile(join(dir, "index.html"), PAGE);
  const server = await startServer(dir, { live: true, preview: META, audio: { src: "/nao-existe.wav" } });
  const session = await openSessionFor(server, { url: server.url, viewport: { width: 640, height: 360 }, gpu: "auto" });
  try {
    const failed = await until(() => audioState(session), (s) => s.status === "error", "falha de download virar error");
    assert.match(failed.error ?? "", /E_PREVIEW_AUDIO.*404/);
    const text = await session.evaluate<string>(`document.querySelector("[data-ff-audio-status]").textContent`);
    assert.match(text, /E_PREVIEW_AUDIO.*404/, "a barra mostra a falha");
    const errors = await session.evaluate<string[]>("window.__ff.liveErrors");
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /^audio: E_PREVIEW_AUDIO/);
  } finally {
    await session.close();
    await server.close();
  }
});

test("falha do mix no servidor e composição longa aparecem na barra, sem derrubar o vídeo", { timeout: 120_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    return t.skip("Chrome não encontrado");
  }
  const dir = await mkdtemp(join(tmpdir(), "ff-preview-audio-"));
  await writeFile(join(dir, "index.html"), PAGE);

  for (const [audio, status, expected] of [
    [{ error: "E_PREVIEW_AUDIO: arquivo de áudio não encontrado: falta.wav" }, "error", /falta\.wav/],
    [{ disabled: "áudio do preview desligado acima de 20 min" }, "disabled", /20 min/],
  ] as const) {
    const server = await startServer(dir, { live: true, preview: META, audio });
    const session = await openSessionFor(server, { url: server.url, viewport: { width: 640, height: 360 }, gpu: "auto" });
    try {
      await until(() => audioState(session), (s) => s.status === status, `status ${status}`);
      const text = await session.evaluate<string>(`document.querySelector("[data-ff-audio-status]").textContent`);
      assert.match(text, expected);
      await until(() => session.evaluate<number>("window.__ff.now()"), (ms) => ms > 200, "o vídeo seguir tocando");
      const errors = await session.evaluate<string[]>("window.__ff.liveErrors");
      assert.equal(errors.length, status === "error" ? 1 : 0, "só falha real entra em liveErrors");
    } finally {
      await session.close();
      await server.close();
    }
  }
});
