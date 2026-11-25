// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { openSession, openSessionFor, resolveChrome, startServer } from "@frankframes/engine";
import { evaluateCurve } from "@frankframes/contract";
import { compileComposition } from "../src/compile.ts";
import { buildCaptionComposition } from "../src/captions.ts";
import { RenderError, renderComposition } from "../src/render.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

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

  const dir = await tempDir(t, "ff-motion-");
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
  const dir = await tempDir(t, "ff-motion-sub-");
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

async function openWith(t: TestContext, html: string): Promise<{ close: () => Promise<void>; run: () => ReturnType<typeof openSession> }> {
  const dir = await tempDir(t, "ff-motion-err-");
  const server = await startServer(dir, { page: { path: "index.html", html } });
  return { close: () => server.close(), run: () => openSession({ url: `${server.url}index.html`, viewport: VIEWPORT, gpu: "auto" }) };
}

test("animação CSS do autor numa propriedade possuída falha na prontidão com E_MOTION_CONFLICT", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;

  const source = page(
    "@keyframes fade{from{opacity:0}to{opacity:1}} .fx{animation:fade 1s linear forwards}",
    `<div id="a" class="box fx" data-clip-id="a" data-start="0" data-duration="3" data-enter="surgir"></div>`,
  );
  const dir = await tempDir(t, "ff-motion-conflict-");
  const compiled = await compileComposition({ entryHtml: source, entryDir: dir });
  assert.equal(compiled.composition.ok, true, "o contrato não vê animação em folha de estilo; quem pega é o runtime");

  const harness = await openWith(t, compiled.html);
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
  const ok = await openWith(t, calmCompiled.html);
  try {
    const session = await ok.run();
    await session.close();
  } finally {
    await ok.close();
  }
});

// EDT-53: motion em <video> vale quando o shim de mídia o troca por <img>; sem o shim (aqui, sem mídia
// fora de banda) o runtime recusa com E_MOTION_TARGET em vez de animar um elemento que o Chrome não decodifica.
test("o runtime recusa motion em <video> sem shim com E_MOTION_TARGET e JSON inválido com E_MOTION_RUNTIME", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;

  const video = page("", `<video id="v" data-ff-motion='{"v":1,"a":[],"s":[]}'></video>`);
  const bad = page("", `<div id="x" data-ff-motion='{nao é json'></div>`);
  for (const [html, expected] of [
    [video, /E_MOTION_TARGET: .*<video/],
    [bad, /E_MOTION_RUNTIME: data-ff-motion inválido/],
  ] as const) {
    const harness = await openWith(t, html);
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

  const workspace = await tempDir(t, "ff-motion-render-");
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

// ---------- EDT-50: keyframes visuais no Chrome ----------

const KEYFRAMES = [
  { time: 0, opacity: 0, x: 0, y: "0%", scale: 1, rotate: 0, blur: 0, clip: "inset(0% 100% 0% 0%)", curve: "freio" },
  { time: 2, opacity: 1, x: 300, y: "50%", scale: 1.5, rotate: 90, blur: 8, clip: "inset(0% 0% 0% 0%)", curve: "mola" },
  { time: 4, opacity: 0.5, x: 100, y: "0%", scale: 1, rotate: 0, blur: 0, clip: "inset(0% 50% 0% 0%)" },
];

interface Sample {
  opacity: string;
  x: string;
  y: string;
  sx: string;
  rot: string;
  blur: string;
  filter: string;
  clip: string;
}

test("keyframes visuais: cada propriedade segue a curva do trecho no Chrome e o seek é independente de ordem", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;

  const html = page(
    "",
    `<div id="k" class="box" data-clip-id="k" data-start="0" data-duration="6" data-keyframes='${JSON.stringify(KEYFRAMES)}'></div>`,
  );
  const dir = await tempDir(t, "ff-keyframes-");
  const compiled = await compileComposition({ entryHtml: html, entryDir: dir });
  assert.equal(compiled.composition.ok, true, JSON.stringify(compiled.composition.diagnostics));
  assert.ok(compiled.html.includes("data-ff-motion"));

  const server = await startServer(dir, { page: { path: "index.html", html: compiled.html } });
  // Hash por frame só é prometido em `software` (invariante 3): com GPU de hardware, blur + rotação + clip combinados variam no pixel.
  const session = await openSessionFor(server, { url: `${server.url}index.html`, viewport: VIEWPORT, gpu: "software" });
  try {
    const sample = async (frame: number): Promise<Sample> => {
      await session.seekFrame(frame, FPS);
      return session.evaluate<Sample>(`(() => {
        const cs = getComputedStyle(document.getElementById("k"));
        return {
          opacity: cs.opacity,
          x: cs.getPropertyValue("--ff-x").trim(),
          y: cs.getPropertyValue("--ff-y").trim(),
          sx: cs.getPropertyValue("--ff-sx").trim(),
          rot: cs.getPropertyValue("--ff-rot").trim(),
          blur: cs.getPropertyValue("--ff-blur").trim(),
          filter: cs.filter,
          clip: cs.clipPath,
        };
      })()`);
    };
    const near = (actual: number, expected: number, tolerance: number, what: string): void =>
      assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} esperado ${expected} ±${tolerance}`);

    // Trechos: [0 s, 2 s] com freio, [2 s, 4 s] com mola; amostras em 25 %, 50 % e 75 % de cada um.
    const segments = [
      { curve: "freio", from: KEYFRAMES[0]!, to: KEYFRAMES[1]!, frames: [15, 30, 45], start: 0 },
      { curve: "mola", from: KEYFRAMES[1]!, to: KEYFRAMES[2]!, frames: [75, 90, 105], start: 2 },
    ];
    for (const seg of segments) {
      for (const frame of seg.frames) {
        const p = (frame / 30 - seg.start) / 2;
        const e = evaluateCurve(seg.curve, p, 2);
        const lerp = (a: number, b: number): number => a + (b - a) * e;
        const got = await sample(frame);
        const where = `${seg.curve} p=${p}`;
        near(Number(got.opacity), Math.min(1, Math.max(0, lerp(seg.from.opacity, seg.to.opacity))), 0.01, `opacity ${where}`);
        near(parseFloat(got.x), lerp(seg.from.x, seg.to.x), 0.5, `x ${where}`);
        assert.ok(got.x.endsWith("px"), `x em px: ${got.x}`);
        near(parseFloat(got.y), lerp(parseFloat(seg.from.y), parseFloat(seg.to.y)), 0.5, `y ${where}`);
        assert.ok(got.y.endsWith("%"), `y em %: ${got.y}`);
        near(Number(got.sx), lerp(seg.from.scale, seg.to.scale), 0.005, `scale ${where}`);
        near(parseFloat(got.rot), lerp(seg.from.rotate, seg.to.rotate), 0.1, `rotate ${where}`);
        const blur = lerp(seg.from.blur, seg.to.blur);
        near(parseFloat(got.blur), blur, 0.1, `blur ${where}`);
        if (blur > 0.2) assert.match(got.filter, /blur\(/, `filter ${where}: ${got.filter}`);
        const right = Number(/inset\(\s*\S+\s+([\d.]+)%/.exec(got.clip)?.[1]);
        const parsed = (v: string): number => Number(/inset\(\s*\S+\s+([\d.]+)%/.exec(v)?.[1]);
        near(right, lerp(parsed(seg.from.clip), parsed(seg.to.clip)), 0.5, `clip ${where}: ${got.clip}`);
      }
    }
    // A mola passa do alvo (overshoot, pico perto de 2,2 s): o x vai de 300 a 100 px e cruza 100. Prova que linear() acima de 1 não é clampado.
    const overshoot = await sample(66);
    assert.ok(parseFloat(overshoot.x) < 100, `x com overshoot abaixo de 100 px: ${overshoot.x}`);

    // Determinismo: 20 frames em ordem, repetidos e invertidos dão o mesmo valor e o mesmo pixel.
    const frames = Array.from({ length: 20 }, (_, i) => i * 8);
    const hashOf = async (frame: number): Promise<string> => JSON.stringify(await sample(frame)) + (await session.capture()).sha256;
    const ordered = new Map<number, string>();
    for (const frame of frames) ordered.set(frame, await hashOf(frame));
    for (const frame of frames) assert.equal(await hashOf(frame), ordered.get(frame), `frame ${frame} mudou ao repetir`);
    for (const frame of [...frames].reverse()) assert.equal(await hashOf(frame), ordered.get(frame), `frame ${frame} mudou na ordem inversa`);
    assert.deepEqual(session.pageErrors(), []);
  } finally {
    await session.close();
    await server.close();
  }
});

// ---- Tipografia cinética (§7b.8) ----

const PHRASE = "Coração, ação e emoção 👍🏽";

const SPLIT = page(
  "h1{position:absolute;left:20px;top:20px;width:240px;margin:0;color:#fff;font:700 40px/1.2 Inter, sans-serif}",
  `<h1 id="t" data-clip-id="t" data-start="0" data-duration="4" data-split="letter stagger=0.05" data-enter="subir dur=0.4">${PHRASE}</h1>`,
);

test("data-split letter: texto intacto, fonte herdada, palavra sem quebra no meio e frames independentes de ordem", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;

  const dir = await tempDir(t, "ff-split-");
  const compiled = await compileComposition({ entryHtml: SPLIT, entryDir: dir });
  assert.equal(compiled.composition.ok, true, JSON.stringify(compiled.composition.diagnostics));

  const server = await startServer(dir, { page: { path: "index.html", html: compiled.html } });
  const session = await openSessionFor(server, { url: `${server.url}index.html`, viewport: VIEWPORT, gpu: "auto" });
  try {
    await session.seekFrame(90, FPS);
    const facts = await session.evaluate<{ text: string; fonts: string[]; parent: string; broken: number; units: number; opacities: string[] }>(`(() => {
      const h1 = document.getElementById("t");
      const units = [...h1.querySelectorAll("[data-ff-unit]")];
      // dentro de cada palavra (span nowrap) todas as letras ficam na mesma linha
      const words = [...h1.querySelectorAll("span:not([data-ff-unit])")];
      const broken = words.filter((w) => new Set([...w.querySelectorAll("[data-ff-unit]")].map((u) => u.offsetTop)).size > 1).length;
      return {
        text: h1.innerText,
        fonts: units.map((u) => getComputedStyle(u).fontFamily),
        parent: getComputedStyle(h1).fontFamily,
        broken,
        units: units.length,
        opacities: units.map((u) => getComputedStyle(u).opacity),
      };
    })()`);
    assert.equal(facts.text, PHRASE, "innerText igual ao original (sem acento solto, emoji inteiro)");
    assert.ok(facts.fonts.every((font) => font === facts.parent), `fonte das unidades ${new Set(facts.fonts).size} diferente da do pai`);
    assert.equal(facts.broken, 0, "nenhuma palavra quebra no meio");
    assert.equal(facts.units, [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(PHRASE.replace(/\s/g, ""))].length);
    assert.ok(facts.opacities.every((o) => o === "1"), "depois da última entrada tudo está visível");

    const frames = [0, 5, 12, 25, 40, 60];
    const hashOf = async (frame: number): Promise<string> => {
      await session.seekFrame(frame, FPS);
      return (await session.capture()).sha256;
    };
    const ordered = new Map<number, string>();
    for (const frame of frames) ordered.set(frame, await hashOf(frame));
    assert.notEqual(ordered.get(0), ordered.get(25), "as letras entram ao longo do tempo");
    for (const frame of frames) assert.equal(await hashOf(frame), ordered.get(frame), `frame ${frame} mudou ao repetir`);
    for (const frame of [...frames].reverse()) assert.equal(await hashOf(frame), ordered.get(frame), `frame ${frame} mudou na ordem inversa`);
    assert.deepEqual(session.pageErrors(), []);
  } finally {
    await session.close();
    await server.close();
  }
});

test("legendas com motion renderizam sem erro de página e as palavras entram no instante falado", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;

  const dir = await tempDir(t, "ff-caps-");
  const html = buildCaptionComposition(
    [
      {
        start: 0,
        end: 3,
        text: "olá mundo lindo",
        // pausas de 0,2 s: o segmento continua numa legenda só (acima de 0,35 s ele seria dividido)
        words: [
          { start: 0, end: 0.8, word: "olá" },
          { start: 1, end: 1.8, word: "mundo" },
          { start: 2, end: 2.5, word: "lindo" },
        ],
      },
    ],
    { width: 640, height: 360, motion: { enter: "subir dur=0.3" } },
  );
  const compiled = await compileComposition({ entryHtml: html, entryDir: dir });
  assert.equal(compiled.composition.ok, true, JSON.stringify(compiled.composition.diagnostics));

  const server = await startServer(dir, { page: { path: "index.html", html: compiled.html } });
  const session = await openSessionFor(server, { url: `${server.url}index.html`, viewport: VIEWPORT, gpu: "auto" });
  try {
    const opacities = async (frame: number): Promise<string[]> => {
      await session.seekFrame(frame, FPS);
      return session.evaluate<string[]>(`[...document.querySelectorAll("[data-ff-unit]")].map((u) => getComputedStyle(u).opacity)`);
    };
    assert.deepEqual(await opacities(0), ["0", "0", "0"], "no começo nenhuma palavra apareceu");
    assert.deepEqual(await opacities(20), ["1", "0", "0"], "aos 0,67 s só a primeira");
    assert.deepEqual(await opacities(50), ["1", "1", "0"], "aos 1,67 s as duas primeiras");
    assert.deepEqual(await opacities(80), ["1", "1", "1"], "aos 2,67 s todas");
    assert.deepEqual(session.pageErrors(), []);
  } finally {
    await session.close();
    await server.close();
  }
});
