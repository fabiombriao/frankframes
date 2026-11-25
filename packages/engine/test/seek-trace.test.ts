// FrankFrames — proprietário. Ver LICENSE na raiz.
/** EDT-91: o estouro de prazo do seek e da captura diz em que etapa parou, em que frame e o que estava pendente. */
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserError, classifyFailure, openSessionFor, resolveChrome, startServer } from "../src/index.ts";
import type { ServerOptions, Session, SessionTimeouts } from "../src/index.ts";
import type { MediaManifest } from "../src/media.ts";
import { createStageTrail } from "../src/seek-trace.ts";
import { sanitizeMessage } from "../../producer/src/errors.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FPS = { num: 30, den: 1 };
const VIEWPORT = { width: 640, height: 360 };
const DEADLINE_MS = 30_000;
/** PNG 1×1: o Chrome decodifica pelo conteúdo, então serve de "frame extraído" sem precisar de FFmpeg. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhWMjWwAAAABJRU5ErkJggg==",
  "base64",
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

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`pendurou: ${what} não terminou em ${ms / 1000} s`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withSession(
  dir: string,
  options: { server?: ServerOptions; timeouts: SessionTimeouts },
  run: (session: Session) => Promise<void>,
): Promise<void> {
  const server = await startServer(dir, options.server ?? {});
  let session: Session | undefined;
  try {
    session = await openSessionFor(server, { url: server.url, viewport: VIEWPORT, gpu: "software", timeouts: options.timeouts });
    await run(session);
  } finally {
    try {
      await within(Promise.resolve(session?.close()), DEADLINE_MS, "o fechamento da sessão");
    } finally {
      await server.close();
    }
  }
}

/** Mensagem do `E_BROWSER_TIMEOUT` da operação, que continua sendo falha de tempo sem retry. */
async function timeoutMessage(operation: Promise<unknown>): Promise<string> {
  let message = "";
  await within(
    assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof BrowserError, `esperava BrowserError, veio ${String(error)}`);
      assert.equal(error.code, "E_BROWSER_TIMEOUT");
      message = error.message;
      return true;
    }),
    DEADLINE_MS,
    "a operação travada",
  );
  const failure = classifyFailure(new Error(message));
  assert.deepEqual([failure.code, failure.retryable], ["E_BROWSER_TIMEOUT", false]);
  return message;
}

test("frame de vídeo que o servidor nunca entrega: o erro diz img.decode(), o frame, o tempo e a <img> pendente", { timeout: 120_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  const dir = await tempDir(t, "ff-seek-decode-");
  await writeFile(
    join(dir, "index.html"),
    `<html><body><div data-composition-id="v" data-root="true" data-duration="1">
      <video data-clip-id="v" data-start="0" data-duration="1" style="position:fixed;left:0;top:0;width:320px;height:180px"></video>
    </div></body></html>`,
  );
  const manifest: MediaManifest = {
    fps: FPS,
    clips: [{ clipId: "v", start: 0, duration: 1, offset: 0, playbackRate: 1, dir: "v", frameCount: 30 }],
  };
  const server: ServerOptions = {
    mediaRoot: join(dir, "media"),
    manifest,
    // Segura a resposta do frame 3 para sempre; os outros frames saem na hora.
    readFile: async (path) => {
      if (path.endsWith("000003.jpg")) return new Promise<Buffer>(() => {});
      return path.endsWith(".jpg") ? PIXEL : readFile(path);
    },
  };
  await withSession(dir, { server, timeouts: { seekMs: 1_500 } }, async (session) => {
    await session.seekFrame(0, FPS);
    const message = await timeoutMessage(session.seekFrame(3, FPS));
    assert.match(message, /^E_BROWSER_TIMEOUT: o seek do frame 3 passou de 1\.5 s sem responder; /);
    assert.match(message, /frame 3 \(t=0,100 s\), parou na etapa "img\.decode\(\) de frame de vídeo" há \d+,\d s/);
    assert.match(message, /<img> pendentes: __ff_media\/v\/000003\.jpg \(carregando\) \(a animação/);
    // O nome do recurso sobrevive à limpeza de caminhos do `render --json` e do Studio.
    assert.ok(sanitizeMessage(message).includes("__ff_media/v/000003.jpg"));
  });
});

const STUCK_STAGES = [
  {
    name: "laço síncrono num requestAnimationFrame da composição",
    inject: "(requestAnimationFrame(() => { for (;;) {} }), true)",
    stage: "timers e requestAnimationFrame da composição",
    rest: /a página não respondeu à sonda em 2 s: thread principal presa/,
  },
  {
    name: "syncAnimations que não volta",
    inject: "(document.getAnimations = () => { for (;;) {} }, true)",
    stage: "syncAnimations",
    rest: /a página não respondeu à sonda em 2 s: thread principal presa/,
  },
  {
    name: "gancho de seek que não volta",
    inject: "(window.__ff.transportHooks.push(() => { for (;;) {} }), true)",
    stage: "visibilidade e ganchos de seek",
    rest: /a página não respondeu à sonda em 2 s/,
  },
  {
    name: "settle que nunca resolve",
    inject: "(window.__ff.settle = () => new Promise(() => {}), true)",
    stage: "settle (requestAnimationFrame)",
    rest: /<img> pendentes: nenhuma/,
  },
  {
    name: "__ff.seek que nunca resolve e não anuncia etapa",
    inject: "(window.__ff.seek = () => new Promise(() => {}), true)",
    stage: "entrada do __ff.seek",
    rest: /<img> pendentes: nenhuma/,
  },
];

for (const stuck of STUCK_STAGES) {
  test(`seek travado (${stuck.name}) nomeia a etapa`, { timeout: 120_000 }, async (t) => {
    if (!(await chromeOrSkip(t))) return;
    await withSession(FIXTURES, { timeouts: { seekMs: 1_500 } }, async (session) => {
      await session.seekFrame(1, FPS);
      await session.evaluate(stuck.inject);
      const message = await timeoutMessage(session.seekFrame(2, FPS));
      assert.ok(message.includes(`frame 2 (t=0,067 s), parou na etapa "${stuck.stage}" há `), message);
      assert.match(message, stuck.rest);
    });
  });
}

test("as etapas continuam anunciadas depois de um reload da página", { timeout: 120_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  await withSession(FIXTURES, { timeouts: { seekMs: 1_500 } }, async (session) => {
    await session.reload();
    await session.evaluate("window.__ff.ready");
    await session.evaluate("(window.__ff.settle = () => new Promise(() => {}), true)");
    const message = await timeoutMessage(session.seekFrame(2, FPS));
    assert.ok(message.includes('parou na etapa "settle (requestAnimationFrame)"'), message);
  });
});

test("captura travada diz o frame e que parou no screenshot", { timeout: 120_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  await withSession(FIXTURES, { timeouts: { captureMs: 2_000 } }, async (session) => {
    await session.seekFrame(5, FPS);
    // A tarefa roda depois de o evaluate responder e prende a thread: o screenshot nunca sai.
    await session.evaluate(
      "(() => { const channel = new MessageChannel(); channel.port1.onmessage = () => { for (;;) {} }; channel.port2.postMessage(0); return true; })()",
    );
    const message = await timeoutMessage(session.capture());
    assert.match(message, /^E_BROWSER_TIMEOUT: a captura do frame 5 passou de 2 s sem responder; /);
    assert.ok(message.includes('frame 5 (t=0,167 s), parou na etapa "screenshot" há '), message);
  });
});

test("rastro: sem resposta da sonda o erro lista o que a etapa pediu; nomes saem sem esquema, query nem conteúdo", async () => {
  const trail = createStageTrail("http://127.0.0.1:4000/");
  trail.startSeek(41, 41 / 30);
  trail.enter("video-frame-decode http://127.0.0.1:4000/__ff_media/clip/000041.jpg");
  const silent = await trail.describe(() => new Promise(() => {}));
  assert.match(silent, /^; frame 41 \(t=1,367 s\), parou na etapa "img\.decode\(\) de frame de vídeo" há \d+,\d s; /);
  assert.ok(silent.endsWith("<img> pedidas nessa etapa: __ff_media/clip/000041.jpg"), silent);

  const broken = await trail.describe(() => Promise.reject(new Error("Target closed")));
  assert.match(broken, /a sonda da página falhou: Target closed/);

  const answered = await trail.describe(async () => ({
    images: [
      { url: "https://usuario:senha@cdn.exemplo.com/fotos/a.png?token=segredo#x", state: "carregando" },
      { url: "data:image/png;base64,AAAA", state: "carregando" },
      ...[1, 2, 3, 4, 5].map((n) => ({ url: `http://127.0.0.1:4000/img/${n}.png`, state: "carregando" })),
    ],
    fonts: ["Inter"],
  }));
  assert.ok(answered.includes("cdn.exemplo.com/fotos/a.png (carregando), data:… (carregando), img/1.png"), answered);
  assert.ok(answered.includes("e mais 2; fontes carregando: Inter"), answered);
  assert.doesNotMatch(answered, /segredo|senha|AAAA/);
});
