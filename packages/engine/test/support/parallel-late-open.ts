// FrankFrames — proprietário. Ver LICENSE na raiz.
// Processo filho de `parallel-close.test.ts`, com Chrome de verdade: um worker falha na abertura enquanto o outro
// ainda carrega a página. O processo tem que sair sozinho; se um Chrome sobrar aberto, ele fica vivo.
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureFramesInParallel } from "../../src/parallel.ts";
import { startServer } from "../../src/server.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
/** Atraso da página boa: a outra abertura falha bem antes. */
const LATE_PAGE_MS = 3_000;
/** O servidor segue de pé depois da rejeição, como no render (repetição) e no Studio: a abertura atrasada tem onde carregar. */
const SERVER_AFTER_MS = 8_000;
/** Quanto o processo tem para sair depois de fechar tudo o que é dele. */
const EXIT_MS = 20_000;

const engine = await startServer(FIXTURES);
let pages = 0;
const front = createServer((request, response) => {
  const url = new URL(request.url ?? "/", engine.url);
  const isPage = url.pathname === "/";
  // 1º pedido da página: sem relógio virtual, a abertura falha na hora. Os demais: a página boa, atrasada.
  if (isPage && (pages += 1) === 1) {
    response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><p>sem relógio</p>");
    return;
  }
  setTimeout(() => {
    get(url, (upstream) => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(response);
    });
  }, isPage ? LATE_PAGE_MS : 0);
});
await new Promise<void>((done) => front.listen(0, "127.0.0.1", done));

try {
  await captureFramesInParallel({
    url: `http://127.0.0.1:${(front.address() as AddressInfo).port}/`,
    viewport: { width: 320, height: 180 },
    gpu: "software",
    fps: { num: 30, den: 1 },
    frames: [...Array(32).keys()],
    workers: 2,
  });
  console.log("resolveu");
  process.exitCode = 2;
} catch (error) {
  console.log(`rejeitou: ${(error as Error).message.split("\n")[0]}`);
}

await new Promise((done) => setTimeout(done, SERVER_AFTER_MS));
front.close();
front.closeAllConnections();
await engine.close();
// `unref`: este timer só dispara se outra coisa mantiver o processo vivo. O `exit` mata o Chrome que sobrou.
setTimeout(() => {
  console.log(`travou: processo vivo ${EXIT_MS / 1000} s depois; recursos: ${process.getActiveResourcesInfo().join(",")}`);
  process.exit(3);
}, EXIT_MS).unref();
