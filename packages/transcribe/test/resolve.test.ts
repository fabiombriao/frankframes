// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolveProvider } from "../src/resolve.ts";

const ENV_KEYS = [
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "FRANKFRAMES_WHISPER_BIN",
  "FRANKFRAMES_WHISPER_MODEL",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function snapshotEnv(): Map<string, string | undefined> {
  return new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("sem env e sem arquivos rejeita E_TRANSCRIBE_UNAVAILABLE rapidamente, sem fetch", async () => {
  const snapshot = snapshotEnv();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  const forbiddenFetch: typeof fetch = async () => {
    fetchCalls++;
    throw new Error("resolveProvider não pode chamar fetch");
  };
  globalThis.fetch = forbiddenFetch;

  try {
    clearEnv();
    const started = performance.now();
    await assert.rejects(
      () => resolveProvider(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("code" in error);
        assert.equal(error.code, "E_TRANSCRIBE_UNAVAILABLE");
        for (const required of ["GROQ_API_KEY", "OPENAI_API_KEY", "whisper.cpp", "550 MB", "1.5 GB f16"]) {
          assert.ok(error.message.includes(required), `mensagem deveria citar ${required}`);
        }
        return true;
      },
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 100, `resolveProvider levou ${elapsed.toFixed(1)} ms`);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(snapshot);
  }
});

test("GROQ_API_KEY tem precedência sobre OPENAI_API_KEY", async () => {
  const snapshot = snapshotEnv();
  try {
    clearEnv();
    process.env.GROQ_API_KEY = "groq-key";
    process.env.OPENAI_API_KEY = "openai-key";
    const transcriber = await resolveProvider();
    assert.equal(transcriber.name, "groq");
  } finally {
    restoreEnv(snapshot);
  }
});

test("configuração explícita vence as variáveis de ambiente", async () => {
  const snapshot = snapshotEnv();
  try {
    clearEnv();
    process.env.GROQ_API_KEY = "groq-key";
    const transcriber = await resolveProvider({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "explicit-key",
      model: "whisper-custom",
    });
    assert.equal(transcriber.name, "openai");
  } finally {
    restoreEnv(snapshot);
  }
});
