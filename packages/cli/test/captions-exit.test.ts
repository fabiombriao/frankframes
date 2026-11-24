// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-71: `process.exit()` logo após fetch aborta no Node 24/Windows (UV_HANDLE_CLOSING, exit 127), de
// (com o Groq real reproduz 5/5). A CLI agora encerra por `process.exitCode`. Contra um servidor local
// (HTTP ou HTTPS) o aborto NÃO reproduz mesmo com o código antigo: este teste é uma guarda de contrato
// (exit 0/1, HTML escrito, stderr limpo), não um reprodutor; a prova do conserto é a execução real com Groq.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadComposition } from "@frankframes/contract";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FFMPEG = fileURLToPath(new URL(`../../../vendor/ffmpeg/bin/ffmpeg${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const RUNS = 10;

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

// `execFile` rejeita em exit ≠ 0 e esconde stderr em alguns casos; `spawn` entrega tudo cru.
function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test(
  `captions termina com exit 0 sem abortar o libuv (${RUNS} execuções seguidas)`,
  { timeout: 120_000, skip: existsSync(FFMPEG) ? false : "vendor/ffmpeg ausente (rode scripts/vendor-ffmpeg.ts)" },
  async (t) => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            text: "olá mundo",
            segments: [{ start: 0, end: 0.4, text: "olá mundo", no_speech_prob: 0.01 }],
            words: [{ start: 0, end: 0.2, word: "olá" }, { start: 0.2, end: 0.4, word: "mundo" }],
          }),
        );
      });
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "localhost", listening.resolve);
    await listening.promise;
    const { port } = server.address() as AddressInfo;

    const dir = await tempDir(t, "ff-captions-exit-");
    const audio = join(dir, "audio.wav");
    try {
      // WAV curto e real, gerado pelo FFmpeg LGPL pinado.
      await run(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.4", "-ar", "16000", "-ac", "1", audio]);

      const env = { ...process.env, OPENAI_API_KEY: "teste", OPENAI_BASE_URL: `http://localhost:${port}`, GROQ_API_KEY: "" };
      for (let i = 0; i < RUNS; i++) {
        const out = join(dir, `legenda-${i}.html`);
        const result = await runCli(["captions", audio, "-o", out, "--size", "1080x1920", "--language", "pt"], env);
        assert.equal(result.code, 0, `execução ${i + 1}: exit ${result.code}\n${result.stderr}`);
        assert.ok(!result.stderr.includes("Assertion"), `execução ${i + 1}: libuv abortou\n${result.stderr}`);
        const composition = loadComposition(await readFile(out, "utf8"));
        assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
      }
    } finally {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
  },
);

test("captions com falha do provedor sai com exit 1 e mensagem, sem abortar o libuv", { timeout: 60_000 }, async (t) => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => response.writeHead(500, { "content-type": "text/plain" }).end("falha simulada"));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "localhost", listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;

  const dir = await tempDir(t, "ff-captions-exit-");
  try {
    const audio = join(dir, "audio.wav");
    await run(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(audio)}, Buffer.alloc(44))`]);
    const env = { ...process.env, OPENAI_API_KEY: "teste", OPENAI_BASE_URL: `http://localhost:${port}`, GROQ_API_KEY: "" };
    for (let i = 0; i < 3; i++) {
      const result = await runCli(["captions", audio, "-o", join(dir, "x.html")], env);
      assert.equal(result.code, 1, `execução ${i + 1}: exit ${result.code}\n${result.stderr}`);
      assert.match(result.stderr, /E_OPENAI_HTTP/);
      assert.ok(!result.stderr.includes("Assertion"), result.stderr);
    }
  } finally {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
});
