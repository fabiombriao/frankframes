// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadComposition } from "@frankframes/contract";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("captions gera composição de legendas a partir do provedor", { timeout: 120_000 }, async () => {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          text: "olá mundo",
          segments: [{ start: 0, end: 1.5, text: "olá mundo", no_speech_prob: 0.01 }],
          words: [{ start: 0, end: 0.6, word: "olá" }, { start: 0.6, end: 1.5, word: "mundo" }],
        }),
      );
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;

  const dir = await mkdtemp(join(tmpdir(), "ff-captions-"));
  const audio = join(dir, "audio.wav");
  await writeFile(audio, Buffer.alloc(44));
  const out = join(dir, "legenda.html");

  try {
    await run(process.execPath, [CLI, "captions", audio, "-o", out, "--size", "1080x1920"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENAI_API_KEY: "teste",
        OPENAI_BASE_URL: `http://127.0.0.1:${port}`,
        GROQ_API_KEY: "",
      },
    });
  } finally {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }

  const html = await readFile(out, "utf8");
  const composition = loadComposition(html);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  assert.deepEqual([composition.width, composition.height], [1080, 1920]);
  assert.equal(composition.clips.length, 1);
  assert.equal(composition.clips[0]!.start, 0);
  assert.equal(composition.clips[0]!.end, 1.5);
  // O provedor devolveu `words`: a saída entra em modo karaokê.
  assert.equal((html.match(/class="w"/g) ?? []).length, 2);
  assert.ok(html.includes(">olá<") && html.includes(">mundo<"));
});
