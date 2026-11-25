// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadComposition } from "@frankframes/contract";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Roda `captions` contra um provedor falso que devolve `reply`; entrega o stdout e o HTML escrito. */
async function runCaptions(t: TestContext, reply: unknown, extra: string[] = []): Promise<{ out: string; stdout: string; html: string }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;

  const dir = await tempDir(t, "ff-captions-");
  const audio = join(dir, "audio.wav");
  await writeFile(audio, Buffer.alloc(44));
  const out = join(dir, "legenda.html");

  try {
    const { stdout } = await run(process.execPath, [CLI, "captions", audio, "-o", out, "--size", "1080x1920", ...extra], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENAI_API_KEY: "teste",
        OPENAI_BASE_URL: `http://127.0.0.1:${port}`,
        GROQ_API_KEY: "",
      },
    });
    return { out, stdout, html: await readFile(out, "utf8") };
  } finally {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
}

const SEGMENTS = [{ start: 0, end: 1.5, text: "olá mundo", no_speech_prob: 0.01 }];

test("captions com tempo por palavra sai em karaokê e a linha diz quantas palavras (EDT-93)", { timeout: 120_000 }, async (t) => {
  // A palavra em branco não acende: a contagem é a do producer, não o tamanho da lista do provedor.
  const { out, stdout, html } = await runCaptions(t, {
    text: "olá mundo",
    segments: SEGMENTS,
    words: [{ start: 0, end: 0.6, word: "olá" }, { start: 0.6, end: 1.5, word: "mundo" }, { start: 1.2, end: 1.4, word: " " }],
  });

  assert.equal(stdout, `${out} · 1 segmento(s) · openai · karaokê (2 palavras)\n`);
  const composition = loadComposition(html);
  assert.equal(composition.ok, true, JSON.stringify(composition.diagnostics));
  assert.deepEqual([composition.width, composition.height], [1080, 1920]);
  assert.equal(composition.clips.length, 1);
  assert.equal(composition.clips[0]!.start, 0);
  assert.equal(composition.clips[0]!.end, 1.5);
  assert.equal((html.match(/class="w"/g) ?? []).length, 2);
  assert.ok(html.includes(">olá<") && html.includes(">mundo<"));
});

const SIX_WORDS = {
  text: "um dois três quatro cinco seis",
  segments: [{ start: 0, end: 1.5, text: "um dois três quatro cinco seis", no_speech_prob: 0.01 }],
  words: ["um", "dois", "três", "quatro", "cinco", "seis"].map((word, i) => ({ word, start: i * 0.25, end: i * 0.25 + 0.2 })),
};

test("captions --max-words muda quantas palavras cabem por legenda; o padrão é 4 (EDT-95)", { timeout: 120_000 }, async (t) => {
  const standard = await runCaptions(t, SIX_WORDS);
  assert.deepEqual(loadComposition(standard.html).clips.map((clip) => [clip.start, clip.end]), [[0, 1], [1, 1.5]]);

  const { out, stdout, html } = await runCaptions(t, SIX_WORDS, ["--max-words", "2"]);
  assert.deepEqual(loadComposition(html).clips.map((clip) => [clip.id, clip.start, clip.end]), [["cap-0", 0, 0.5], ["cap-1", 0.5, 1], ["cap-2", 1, 1.5]]);
  // a linha continua contando segmentos do provedor e palavras
  assert.equal(stdout, `${out} · 1 segmento(s) · openai · karaokê (6 palavras)\n`);
});

test("captions --max-words que não é inteiro ≥ 1 falha alto antes de transcrever (EDT-95)", { timeout: 120_000 }, async () => {
  for (const bad of [["0"], ["-2"], ["2.5"], ["quatro"], [] as string[]]) {
    await assert.rejects(
      run(process.execPath, [CLI, "captions", "audio-que-nao-existe.wav", "--max-words", ...bad], { encoding: "utf8" }),
      (error: { code?: number; stderr?: string }) => {
        assert.equal(error.code, 2, `valor ${JSON.stringify(bad)}`);
        assert.match(error.stderr ?? "", /E_CAPTIONS: --max-words precisa de um inteiro maior ou igual a 1/);
        return true;
      },
    );
  }
});

test("captions sem tempo por palavra sai por frase e a linha diz o motivo (EDT-93)", { timeout: 120_000 }, async (t) => {
  const { out, stdout, html } = await runCaptions(t, { text: "olá mundo", segments: SEGMENTS });

  assert.equal(stdout, `${out} · 1 segmento(s) · openai · por frase: o provedor não devolveu tempo por palavra\n`);
  assert.equal(loadComposition(html).ok, true);
  assert.equal((html.match(/class="w"/g) ?? []).length, 0);
});
