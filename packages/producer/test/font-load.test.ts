// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openSession, resolveChrome, startServer } from "@frankframes/engine";
import { RENDER_ERROR_CODES, toErrorPayload } from "../src/errors.ts";
import { RenderError, renderComposition } from "../src/render.ts";

const run = promisify(execFile);
const VIEWPORT = { width: 640, height: 360 };

const page = (head: string, body: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#0b0b0f;color:#f2efe6}
  ${head}
</style></head><body>
<div data-composition-id="main" data-root="true" data-width="640" data-height="360" data-fps="30" data-duration="1">
${body}
</div></body></html>`;

// Face que aponta para um arquivo que não existe, e um elemento que a usa.
const BROKEN_USED = page(
  "@font-face{font-family:Quebrada;src:url(./nao-existe.woff2) format('woff2')} .t{font:700 40px Quebrada,sans-serif}",
  `<div class="t" style="position:absolute;left:40px;top:40px">Texto na fonte quebrada</div>`,
);
// A mesma face quebrada, mas nenhum elemento usa a família.
const BROKEN_UNUSED = page(
  "@font-face{font-family:Orfa;src:url(./tambem-nao-existe.woff2) format('woff2')}",
  `<div style="position:absolute;left:40px;top:40px;font:700 40px Inter,sans-serif">Ninguém usa a Orfa</div>`,
);
// Só fontes que existem (a Inter embarcada): tem que abrir como sempre.
const HEALTHY = page("", `<div style="position:absolute;left:40px;top:40px;font:700 40px Inter,sans-serif">Fonte que carrega</div>`);

async function chromeOrSkip(t: TestContext): Promise<boolean> {
  try {
    await resolveChrome();
    return true;
  } catch {
    t.skip("Chrome não encontrado");
    return false;
  }
}

async function ffmpegAvailable(ffmpeg: string, ffprobe: string): Promise<boolean> {
  try {
    await run(ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
    await run(ffprobe, ["-hide_banner", "-version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

interface Harness {
  close: () => Promise<void>;
  /** Abre a sessão; a prontidão pode rejeitar. */
  open: () => ReturnType<typeof openSession>;
  /** Como `open`, mas fecha a sessão se ela abrir por engano: o teste falha rápido, sem Chrome pendurado. */
  mustReject: () => Promise<never>;
}

async function openWith(html: string): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "ff-font-"));
  const server = await startServer(dir, { page: { path: "index.html", html } });
  const open = () => openSession({ url: `${server.url}index.html`, viewport: VIEWPORT, gpu: "software" });
  const mustReject = async (): Promise<never> => {
    const session = await open();
    await session.close();
    throw new Error("a prontidão deveria ter rejeitado");
  };
  return { close: () => server.close(), open, mustReject };
}

test("E_FONT_LOAD é um código de render publicado", () => {
  assert.ok(RENDER_ERROR_CODES.includes("E_FONT_LOAD"));
  const payload = toErrorPayload({ code: "E_FONT_LOAD", stage: "capture", message: "x" });
  assert.equal(payload.code, "E_FONT_LOAD");
  assert.equal(payload.stage, "capture");
});

test("a prontidão rejeita com E_FONT_LOAD e a família quando uma face declarada não carrega", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;

  const harness = await openWith(BROKEN_USED);
  try {
    await assert.rejects(harness.mustReject(), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /E_FONT_LOAD: fonte declarada não carregou: .*Quebrada/);
      assert.match(message, /peso normal, estilo normal/);
      assert.match(message, /confira o src do @font-face.*vendor\/fonts/);
      return true;
    });
  } finally {
    await harness.close();
  }
});

test("face declarada que nenhum elemento usa também falha; fontes que existem seguem abrindo", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;

  const unused = await openWith(BROKEN_UNUSED);
  try {
    await assert.rejects(unused.mustReject(), /E_FONT_LOAD: .*Orfa/);
  } finally {
    await unused.close();
  }

  const healthy = await openWith(HEALTHY);
  try {
    const session = await healthy.open();
    assert.deepEqual(session.pageErrors().filter((line) => /E_FONT_LOAD/.test(line)), []);
    await session.close();
  } finally {
    await healthy.close();
  }
});

test("render real: fonte que não carrega para na etapa capture com E_FONT_LOAD; sem a face quebrada renderiza", { timeout: 600_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
  if (!(await ffmpegAvailable(ffmpeg, ffprobe))) return t.skip("ffmpeg/ffprobe não encontrados");

  const workspace = await mkdtemp(join(tmpdir(), "ff-font-render-"));
  const entry = join(workspace, "index.html");

  await writeFile(entry, BROKEN_USED);
  await assert.rejects(
    renderComposition({ entry, outPath: join(workspace, "a.mp4"), ffmpeg, ffprobe, codec: "av1", preset: "draft", workers: 1 }),
    (error: unknown) =>
      error instanceof RenderError && error.code === "E_FONT_LOAD" && error.stage === "capture" && /Quebrada/.test(error.message),
  );

  await writeFile(entry, HEALTHY);
  const done = await renderComposition({ entry, outPath: join(workspace, "b.mp4"), ffmpeg, ffprobe, codec: "av1", preset: "draft", workers: 1 });
  assert.equal(done.frames, 30);
});
