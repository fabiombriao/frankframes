// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserError, openSessionFor, resolveChrome, startServer } from "../src/index.ts";
import type { Session } from "../src/index.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FPS = { num: 30, den: 1 };
const VIEWPORT = { width: 640, height: 360 };
/** Prazo próprio do teste: sem a mudança a espera seria infinita; com ela, a rejeição chega bem antes. */
const DEADLINE_MS = 30_000;

async function chromeOrSkip(t: TestContext): Promise<boolean> {
  try {
    await resolveChrome();
    return true;
  } catch {
    t.skip("Chrome não encontrado");
    return false;
  }
}

/** Rejeita se a promessa não se resolver no prazo: um teste que pendura vira falha, não timeout do runner. */
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

function assertBrowserError(error: unknown, code: string): true {
  assert.ok(error instanceof BrowserError, `esperava BrowserError, veio ${String(error)}`);
  assert.equal(error.code, code);
  assert.match(error.message, new RegExp(`^${code}: `));
  assert.ok(error.hint.length > 10, "o hint precisa ser acionável");
  return true;
}

async function withFixtureSession(run: (session: Session) => Promise<void>): Promise<void> {
  const server = await startServer(FIXTURES);
  let session: Session | undefined;
  try {
    session = await openSessionFor(server, { url: server.url, viewport: VIEWPORT, gpu: "software" });
    await run(session);
  } finally {
    try {
      await session?.close();
    } finally {
      await server.close();
    }
  }
}

test("Chrome morto no meio da captura rejeita com E_BROWSER_CLOSED em menos de 30 s", { timeout: 120_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  await withFixtureSession(async (session) => {
    assert.ok(session.pid !== undefined, "a sessão precisa expor o PID do Chrome");
    const capturing = (async () => {
      for (let frame = 0; ; frame = (frame + 1) % 30) {
        await session.seekFrame(frame, FPS);
        await session.capture();
      }
    })();
    setTimeout(() => process.kill(session.pid!, "SIGKILL"), 500);

    const started = Date.now();
    await within(
      assert.rejects(capturing, (error: unknown) => assertBrowserError(error, "E_BROWSER_CLOSED")),
      DEADLINE_MS,
      "a captura após derrubar o Chrome",
    );
    assert.ok(Date.now() - started < DEADLINE_MS);

    // Depois da queda, nada novo espera: tudo rejeita de imediato com o mesmo código.
    await assert.rejects(session.seekFrame(0, FPS), (error: unknown) => assertBrowserError(error, "E_BROWSER_CLOSED"));
    await assert.rejects(session.capture(), (error: unknown) => assertBrowserError(error, "E_BROWSER_CLOSED"));
  });
});

test("Chrome morto com uma avaliação que nunca resolve rejeita tudo o que estava pendente", { timeout: 120_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  await withFixtureSession(async (session) => {
    const pendings = [
      session.evaluate("new Promise(() => {})"),
      session.evaluate("new Promise(() => {})"),
      session.seekFrame(0, FPS).then(() => session.evaluate("new Promise(() => {})")),
    ];
    const settled = Promise.allSettled(pendings);
    setTimeout(() => process.kill(session.pid!, "SIGKILL"), 500);

    const results = await within(settled, DEADLINE_MS, "as operações pendentes após derrubar o Chrome");
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assertBrowserError((result as PromiseRejectedResult).reason, "E_BROWSER_CLOSED");
    }
  });
});

test("seek que nunca termina rejeita com E_BROWSER_TIMEOUT e hint, e a sessão ainda fecha", { timeout: 120_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  const server = await startServer(FIXTURES);
  let session: Session | undefined;
  try {
    session = await openSessionFor(server, {
      url: server.url,
      viewport: VIEWPORT,
      gpu: "software",
      timeouts: { seekMs: 700 },
    });
    await session.evaluate("(window.__ff.seek = () => new Promise(() => {}), true)");
    const started = Date.now();
    await within(
      assert.rejects(session.seekFrame(3, FPS), (error: unknown) => {
        assertBrowserError(error, "E_BROWSER_TIMEOUT");
        assert.match((error as BrowserError).message, /seek do frame 3/);
        return true;
      }),
      DEADLINE_MS,
      "o seek travado",
    );
    assert.ok(Date.now() - started < 10_000, "o prazo configurado (0,7 s) é o que vale");
  } finally {
    try {
      await within(Promise.resolve(session?.close()), DEADLINE_MS, "o fechamento da sessão");
    } finally {
      await server.close();
    }
  }
});

test("página que nunca termina de carregar uma imagem rejeita a prontidão com E_BROWSER_TIMEOUT", { timeout: 120_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  // Servidor que aceita a conexão e nunca responde: a imagem fica pendente para sempre.
  const stalled = createServer(() => {});
  await new Promise<void>((resolveListen) => stalled.listen(0, "127.0.0.1", resolveListen));
  const stalledPort = (stalled.address() as AddressInfo).port;
  const dir = await tempDir(t, "ff-ready-timeout-");
  await writeFile(
    join(dir, "index.html"),
    `<html><body><div data-composition-id="x" data-root="true" data-duration="1">
      <img src="http://127.0.0.1:${stalledPort}/lento.png" data-start="0" data-duration="1">
    </div></body></html>`,
  );
  const server = await startServer(dir);
  try {
    const started = Date.now();
    await within(
      assert.rejects(
        openSessionFor(server, { url: server.url, viewport: VIEWPORT, gpu: "software", timeouts: { readyMs: 1_500 } }),
        (error: unknown) => assertBrowserError(error, "E_BROWSER_TIMEOUT"),
      ),
      DEADLINE_MS,
      "a prontidão da página",
    );
    assert.ok(Date.now() - started < 20_000);
  } finally {
    stalled.closeAllConnections();
    await new Promise<void>((resolveClose) => stalled.close(() => resolveClose()));
    await server.close();
  }
});

test("E_FONT_LOAD diz o que o servidor viu: servidor: EBUSY quando a fonte não pôde ser lida", { timeout: 120_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  const dir = await tempDir(t, "ff-font-ebusy-");
  await writeFile(
    join(dir, "index.html"),
    `<html><head><style>@font-face{font-family:"Travada";src:url("/travada.woff2") format("woff2");}</style></head>
    <body><div data-composition-id="x" data-root="true" data-duration="1" style="font-family:Travada">oi</div></body></html>`,
  );
  const server = await startServer(dir, {
    readFile: async (path) => {
      if (path.endsWith("travada.woff2")) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      return readFile(path);
    },
  });
  try {
    await within(
      assert.rejects(openSessionFor(server, { url: server.url, viewport: VIEWPORT, gpu: "software" }), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /E_FONT_LOAD/);
        assert.match(message, /servidor: EBUSY ao ler travada\.woff2/);
        return true;
      }),
      DEADLINE_MS,
      "a sessão com fonte travada",
    );
    const failures = server.failures();
    assert.ok(failures.some((failure) => failure.code === "EBUSY" && failure.outcome === "failed"));
  } finally {
    await server.close();
  }
});
