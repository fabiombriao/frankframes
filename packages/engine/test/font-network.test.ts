// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { classifyFailure, openSession, resolveChrome, retryOnceIfTransient, startServer } from "../src/index.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const VIEWPORT = { width: 640, height: 360 };

const page = (head: string): string => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>
<div data-composition-id="main" data-root="true" data-width="640" data-height="360" data-fps="30" data-duration="1"
  style="font:600 40px Poppins,sans-serif">Texto em Poppins</div></body></html>`;

async function chromeOrSkip(t: TestContext): Promise<boolean> {
  try {
    await resolveChrome();
    return true;
  } catch {
    t.skip("Chrome não encontrado");
    return false;
  }
}

interface Proxy {
  url: string;
  /** Enquanto verdadeiro, derruba a conexão de toda requisição de fonte embarcada. */
  dropFonts: boolean;
  readonly dropped: number;
  close: () => Promise<void>;
}

/**
 * Proxy TCP na frente do servidor da página. Derrubar a conexão da requisição de fonte reproduz, sem depender
 * de máquina sobrecarregada, o que o gate vê: o Chrome reporta "A network error occurred" e o servidor não registra nada.
 */
async function proxyTo(upstreamPort: number): Promise<Proxy> {
  const sockets = new Set<Socket>();
  const state = { dropFonts: true, dropped: 0 };
  const server = createServer((client) => {
    const upstream = createConnection({ host: "127.0.0.1", port: upstreamPort });
    sockets.add(client);
    sockets.add(upstream);
    client.on("data", (chunk) => {
      if (state.dropFonts && chunk.toString("latin1", 0, 64).startsWith("GET /__ff_fonts/")) {
        state.dropped += 1;
        client.destroy();
        upstream.destroy();
        return;
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => client.write(chunk));
    // Queda de socket é o cenário do teste: só encerra o outro lado, sem engolir o resultado visto pela sessão.
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/`,
    get dropFonts() {
      return state.dropFonts;
    },
    set dropFonts(value: boolean) {
      state.dropFonts = value;
    },
    get dropped() {
      return state.dropped;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

test("fonte embarcada cuja requisição cai no caminho: E_FONT_LOAD transiente, repetido uma vez e depois carrega (EDT-72)", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  const dir = await tempDir(t, "ff-font-net-");
  const server = await startServer(dir, { page: { path: "index.html", html: page("") } });
  const proxy = await proxyTo(Number(new URL(server.url).port));
  const causes: string[] = [];
  try {
    const session = await retryOnceIfTransient(
      () => openSession({ url: `${proxy.url}index.html`, viewport: VIEWPORT, gpu: "software", serverFailures: server.failures }),
      (cause) => {
        causes.push(cause.message);
        proxy.dropFonts = false; // a rede volta antes da segunda tentativa
      },
    );
    try {
      assert.equal(causes.length, 1, "a repetição é única");
      assert.match(causes[0] ?? "", /E_FONT_LOAD: fonte declarada não carregou: .*A network error occurred/);
      assert.ok(proxy.dropped > 0, "o proxy derrubou ao menos uma requisição de fonte");
      assert.deepEqual(server.failures(), [], "o servidor não viu falha: a requisição nem chegou");
      const loaded = await session.evaluate<boolean>(`[...document.fonts].every((face) => face.status === "loaded")`);
      assert.equal(loaded, true, "na segunda tentativa toda face declarada carregou");
    } finally {
      await session.close();
    }
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("fonte embarcada que continua caindo: a segunda falha sobe como E_FONT_LOAD, sem terceira tentativa (EDT-72)", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  const dir = await tempDir(t, "ff-font-net-");
  const server = await startServer(dir, { page: { path: "index.html", html: page("") } });
  const proxy = await proxyTo(Number(new URL(server.url).port));
  let attempts = 0;
  try {
    await assert.rejects(
      retryOnceIfTransient(() => {
        attempts += 1;
        return openSession({ url: `${proxy.url}index.html`, viewport: VIEWPORT, gpu: "software", serverFailures: server.failures });
      }),
      (error: unknown) => {
        assert.match(String((error as Error).message), /^E_FONT_LOAD: fonte declarada não carregou: .*A network error occurred/);
        assert.equal(classifyFailure(error).code, "E_FONT_LOAD");
        return true;
      },
    );
    assert.equal(attempts, 2, "uma repetição, nunca mais");
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("@font-face do autor para arquivo inexistente: o servidor registra o 404 e a falha é de autoria, sem repetir (EDT-72)", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  const html = page("<style>@font-face{font-family:Quebrada;src:url(./nao-existe.woff2) format('woff2')}</style>");
  const dir = await tempDir(t, "ff-font-net-");
  const logs: string[] = [];
  const server = await startServer(dir, { page: { path: "index.html", html }, log: (line) => logs.push(line) });
  let attempts = 0;
  try {
    await assert.rejects(
      retryOnceIfTransient(() => {
        attempts += 1;
        return openSession({ url: `${server.url}index.html`, viewport: VIEWPORT, gpu: "software", serverFailures: server.failures });
      }),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /E_FONT_LOAD: fonte declarada não carregou: .*Quebrada/);
        assert.match(message, /\[servidor: .*nao-existe\.woff2/);
        assert.equal(classifyFailure(error).retryable, false);
        return true;
      },
    );
    assert.equal(attempts, 1, "erro de autoria não é repetido");
    assert.ok(logs.some((line) => line.includes("nao-existe.woff2")), "o 404 da fonte fica no log do servidor");
  } finally {
    await server.close();
  }
});
