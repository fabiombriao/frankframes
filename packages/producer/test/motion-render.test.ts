// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openSession, openSessionFor, resolveChrome, startServer } from "@frankframes/engine";
import { compileComposition } from "../src/compile.ts";
import { RenderError, renderComposition } from "../src/render.ts";

const run = promisify(execFile);
const FPS = { num: 30, den: 1 };
const VIEWPORT = { width: 640, height: 360 };

const page = (head: string, body: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#0b0b0f}
  .box{position:absolute;left:40px;top:40px;width:200px;height:80px;background:#ff2d55}
  .dot{position:absolute;left:320px;top:40px;width:80px;height:80px;background:#34c759}
  ${head}
</style></head><body>
<div data-composition-id="main" data-root="true" data-width="640" data-height="360" data-fps="30" data-duration="6">
${body}
</div></body></html>`;

const MOTION = page(
  "",
  `<div id="a" class="box" data-clip-id="a" data-start="1" data-duration="3" data-enter="surgir dur=1" data-exit="apagar dur=1"></div>
<div id="p" class="dot" data-clip-id="p" data-start="0" data-duration="6" data-emphasis="pulsar at=2 dur=1 amount=1.5"></div>`,
);

async function chromeOrSkip(t: TestContext): Promise<boolean> {
  try {
    await resolveChrome();
    return true;
  } catch {
    t.skip("Chrome não encontrado");
    return false;
  }
}

interface Probe {
  opacity: string;
  sx: string;
}

test("o motion anima pelo relógio e seek fora de ordem dá o mesmo frame", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;

  const dir = await mkdtemp(join(tmpdir(), "ff-motion-"));
  const compiled = await compileComposition({ entryHtml: MOTION, entryDir: dir });
  assert.equal(compiled.composition.ok, true, JSON.stringify(compiled.composition.diagnostics));
  assert.ok(compiled.html.includes("data-ff-motion"));

  const server = await startServer(dir, { page: { path: "index.html", html: compiled.html } });
  const session = await openSessionFor(server, { url: `${server.url}index.html`, viewport: VIEWPORT, gpu: "auto" });
  try {
    const probe = async (frame: number): Promise<Probe> => {
      await session.seekFrame(frame, FPS);
      return session.evaluate<Probe>(`({
        opacity: getComputedStyle(document.getElementById("a")).opacity,
        sx: getComputedStyle(document.getElementById("p")).getPropertyValue("--ff-sx").trim(),
      })`);
    };

    // Valores conhecidos: entrada [1s,2s], saída [3s,4s], pulso [2s,3s] com pico em 2,5 s.
    assert.equal((await probe(30)).opacity, "0", "início da entrada");
    const mid = Number((await probe(45)).opacity);
    assert.ok(mid > 0.2 && mid < 0.95, `meio da entrada: ${mid}`);
    assert.equal((await probe(60)).opacity, "1", "fim da entrada");
    assert.equal((await probe(89)).opacity, "1", "parado entre entrada e saída");
    const out = Number((await probe(105)).opacity);
    assert.ok(out > 0.05 && out < 0.8, `meio da saída: ${out}`);
    assert.equal((await probe(75)).sx, "1.5", "pico do pulso");
    assert.equal((await probe(0)).sx, "1", "antes do pulso o valor é o neutro");
    assert.equal((await probe(150)).sx, "1", "depois do pulso volta ao neutro");

    // Determinismo: a mesma lista de frames, em ordens diferentes, dá os mesmos valores e os mesmos pixels.
    const frames = [0, 15, 30, 38, 45, 59, 60, 75, 82, 100, 105, 119];
    const ordered = new Map<number, string>();
    for (const frame of frames) {
      const values = await probe(frame);
      ordered.set(frame, JSON.stringify(values) + (await session.capture()).sha256);
    }
    const shuffled = [...frames].reverse().sort((a, b) => ((a * 7) % 13) - ((b * 7) % 13));
    assert.notDeepEqual(shuffled, frames, "a ordem de teste precisa ser diferente");
    for (const frame of shuffled) {
      const values = await probe(frame);
      assert.equal(JSON.stringify(values) + (await session.capture()).sha256, ordered.get(frame), `frame ${frame} mudou com a ordem do seek`);
    }
    assert.deepEqual(session.pageErrors(), []);
  } finally {
    await session.close();
    await server.close();
  }
});

test("clip dentro de sub-composição anima a partir do início do host", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;

  const html = page(
    "",
    `<div data-composition-id="host" data-clip-id="host" data-start="2" data-duration="3">
  <div data-composition-id="host-root" data-duration="3">
    <div id="c" class="box" data-clip-id="c" data-start="1" data-duration="2" data-enter="surgir dur=1"></div>
  </div>
</div>`,
  );
  const dir = await mkdtemp(join(tmpdir(), "ff-motion-sub-"));
  const compiled = await compileComposition({ entryHtml: html, entryDir: dir });
  assert.equal(compiled.composition.ok, true, JSON.stringify(compiled.composition.diagnostics));

  const server = await startServer(dir, { page: { path: "index.html", html: compiled.html } });
  const session = await openSessionFor(server, { url: `${server.url}index.html`, viewport: VIEWPORT, gpu: "auto" });
  try {
    const opacity = async (frame: number): Promise<number> => {
      await session.seekFrame(frame, FPS);
      return Number(await session.evaluate<string>('getComputedStyle(document.getElementById("c")).opacity'));
    };
    // O clip começa em 3 s absolutos (host em 2 s + 1 s local); a entrada dura 1 s.
    assert.equal(await opacity(90), 0, "no início do clip");
    const half = await opacity(105);
    assert.ok(half > 0.2 && half < 0.95, `meio da entrada: ${half}`);
    assert.equal(await opacity(120), 1, "entrada concluída");
  } finally {
    await session.close();
    await server.close();
  }
});

async function openWith(html: string): Promise<{ close: () => Promise<void>; run: () => ReturnType<typeof openSession> }> {
  const dir = await mkdtemp(join(tmpdir(), "ff-motion-err-"));
  const server = await startServer(dir, { page: { path: "index.html", html } });
  return { close: () => server.close(), run: () => openSession({ url: `${server.url}index.html`, viewport: VIEWPORT, gpu: "auto" }) };
}

test("animação CSS do autor numa propriedade possuída falha na prontidão com E_MOTION_CONFLICT", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;

  const source = page(
    "@keyframes fade{from{opacity:0}to{opacity:1}} .fx{animation:fade 1s linear forwards}",
    `<div id="a" class="box fx" data-clip-id="a" data-start="0" data-duration="3" data-enter="surgir"></div>`,
  );
  const dir = await mkdtemp(join(tmpdir(), "ff-motion-conflict-"));
  const compiled = await compileComposition({ entryHtml: source, entryDir: dir });
  assert.equal(compiled.composition.ok, true, "o contrato não vê animação em folha de estilo; quem pega é o runtime");

  const harness = await openWith(compiled.html);
  try {
    await assert.rejects(harness.run(), /E_MOTION_CONFLICT: .*opacity/);
  } finally {
    await harness.close();
  }

  // Animação em propriedade que o motion não possui convive com ele.
  const calm = page(
    "@keyframes tint{from{background:#f00}to{background:#00f}} .fx{animation:tint 1s linear forwards}",
    `<div id="a" class="box fx" data-clip-id="a" data-start="0" data-duration="3" data-enter="surgir"></div>`,
  );
  const calmCompiled = await compileComposition({ entryHtml: calm, entryDir: dir });
  const ok = await openWith(calmCompiled.html);
  try {
    const session = await ok.run();
    await session.close();
  } finally {
    await ok.close();
  }
});

test("o runtime recusa motion em <video> com E_MOTION_TARGET e JSON inválido com E_MOTION_RUNTIME", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;

  const video = page("", `<video id="v" data-ff-motion='{"v":1,"a":[],"s":[]}'></video>`);
  const bad = page("", `<div id="x" data-ff-motion='{nao é json'></div>`);
  for (const [html, expected] of [
    [video, /E_MOTION_TARGET: .*<video/],
    [bad, /E_MOTION_RUNTIME: data-ff-motion inválido/],
  ] as const) {
    const harness = await openWith(html);
    try {
      await assert.rejects(harness.run(), expected);
    } finally {
      await harness.close();
    }
  }
});

async function ffmpegAvailable(ffmpeg: string, ffprobe: string): Promise<boolean> {
  try {
    await run(ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
    await run(ffprobe, ["-hide_banner", "-version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

test("render real: conflito de posse sai como E_MOTION_RUNTIME na etapa capture; sem conflito renderiza", { timeout: 600_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
  if (!(await ffmpegAvailable(ffmpeg, ffprobe))) return t.skip("ffmpeg/ffprobe não encontrados");

  const workspace = await mkdtemp(join(tmpdir(), "ff-motion-render-"));
  const entry = join(workspace, "index.html");
  const small = (head: string, cls: string): string =>
    page(head, `<div id="a" class="box ${cls}" data-clip-id="a" data-start="0" data-duration="1" data-enter="surgir dur=0.5"></div>`).replace('data-duration="6"', 'data-duration="1"');

  await writeFile(entry, small("@keyframes f{from{opacity:0}to{opacity:1}} .fx{animation:f 1s linear forwards}", "fx"));
  await assert.rejects(
    renderComposition({ entry, outPath: join(workspace, "a.mp4"), ffmpeg, ffprobe, codec: "av1", preset: "draft", workers: 1 }),
    (error: unknown) =>
      error instanceof RenderError && error.code === "E_MOTION_RUNTIME" && error.stage === "capture" && /E_MOTION_CONFLICT/.test(error.message),
  );

  await writeFile(entry, small("", ""));
  const first = await renderComposition({ entry, outPath: join(workspace, "b.mp4"), ffmpeg, ffprobe, codec: "av1", preset: "draft", workers: 1 });
  const second = await renderComposition({ entry, outPath: join(workspace, "c.mp4"), ffmpeg, ffprobe, codec: "av1", preset: "draft", workers: 2 });
  assert.equal(first.frames, 30);
  const divergent = [...first.hashes.keys()].filter((frame) => first.hashes.get(frame) !== second.hashes.get(frame));
  assert.deepEqual(divergent, [], "dois renders com motion têm que dar os mesmos hashes por frame");
  assert.notEqual(first.hashes.get(0), first.hashes.get(29), "o motion muda o frame ao longo do tempo");
});
