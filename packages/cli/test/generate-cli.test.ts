// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkPinnedBrowser } from "@frankframes/engine";
import { resolveFfmpeg } from "@frankframes/producer";
import { parseGenerateArgs, slugify } from "../src/generate-command.ts";
import { openBrowserCommand } from "../src/open-browser.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const VALID = readFileSync(fileURLToPath(new URL("./fixtures/video-1080p.html", import.meta.url)), "utf8");

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, "generate", ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

async function withReplies<T>(replies: unknown[], body: (env: Record<string, string>, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ff-gen-cli-"));
  try {
    const file = join(dir, "replies.json");
    writeFileSync(file, JSON.stringify(replies));
    return await body({ FRANKFRAMES_CODEX: FAKE, FAKE_CODEX_REPLIES: file }, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const good = { html: VALID, blocks: [], notes: "" };

test("generate --no-render --json com o Codex falso: ok, versão do agente e arquivos", async () => {
  await withReplies([good], async (env, dir) => {
    const out = join(dir, "saida");
    const result = await cli(["abertura", "-o", out, "--no-render", "--no-studio", "--json"], env);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { ok: boolean; agent: { name: string; version: string }; attempts: unknown[]; render: unknown; entry: string };
    assert.equal(report.ok, true);
    assert.deepEqual(report.agent, { name: "codex", version: "codex-cli 0.0.0-fake" });
    assert.equal(report.attempts.length, 1);
    assert.equal(report.render, null);
    assert.equal(readFileSync(join(out, "index.html"), "utf8"), VALID);
    assert.ok(existsSync(join(out, "generate.json")));
    assert.ok(!existsSync(join(out, "draft.mp4")));
    assert.match(result.stderr, /tentativa 1\/3/);
  });
});

test("generate sem --json imprime o caminho e as tentativas", async () => {
  await withReplies([good], async (env, dir) => {
    const out = join(dir, "saida");
    const result = await cli(["abertura", "-o", out, "--no-render", "--no-studio"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /pronto: .*index\.html/);
    assert.match(result.stdout, /1 tentativa\(s\)/);
  });
});

test("reparo pela CLI: 1ª resposta inválida, 2ª boa → 2 tentativas", async () => {
  await withReplies([{ html: "<div>x</div>", blocks: [], notes: "" }, good], async (env, dir) => {
    const result = await cli(["abertura", "-o", join(dir, "saida"), "--no-render", "--no-studio", "--json"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as { attempts: unknown[] }).attempts.length, 2);
    assert.match(result.stderr, /E_NO_ROOT/);
  });
});

test("esgotar as tentativas sai com 1, E_GEN_EXHAUSTED e dica; sem index.html", async () => {
  await withReplies([{ html: "<div>x</div>", blocks: [], notes: "" }], async (env, dir) => {
    const out = join(dir, "saida");
    const result = await cli(["abertura", "-o", out, "--attempts", "2", "--no-render", "--no-studio", "--json"], env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /erro E_GEN_EXHAUSTED/);
    const failure = JSON.parse(result.stdout) as { ok: boolean; code: string; hint: string; attempts: unknown[] };
    assert.equal(failure.ok, false);
    assert.equal(failure.code, "E_GEN_EXHAUSTED");
    assert.equal(failure.attempts.length, 2);
    assert.ok(!existsSync(join(out, "index.html")));
  });
});

test("Codex deslogado ou com chave de API: exit 1, E_CODEX_AUTH com `codex login` e nada é criado", async () => {
  for (const login of ["none", "apikey"]) {
    await withReplies([good], async (env, dir) => {
      const out = join(dir, "saida");
      const result = await cli(["abertura", "-o", out, "--no-render", "--no-studio"], { ...env, FAKE_CODEX_LOGIN: login });
      assert.equal(result.code, 1, login);
      assert.match(result.stderr, /erro E_CODEX_AUTH/, login);
      assert.match(result.stderr, /codex login/, login);
      assert.ok(!existsSync(out), `${login}: a pasta de saída não devia existir`);
    });
  }
});

test("FRANKFRAMES_CODEX inexistente: E_CODEX_MISSING, sem cair no PATH", async () => {
  const result = await cli(["abertura", "-o", join(tmpdir(), "ff-nunca-criada"), "--no-render", "--no-studio"], { FRANKFRAMES_CODEX: join(tmpdir(), "nao-existe", "codex.exe") });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /erro E_CODEX_MISSING/);
  assert.match(result.stderr, /FRANKFRAMES_CODEX/);
  assert.ok(!existsSync(join(tmpdir(), "ff-nunca-criada")));
});

test("erros de uso saem com 2", async () => {
  for (const args of [[], ["a", "b"], ["x", "--format", "4:3"], ["x", "--attempts", "9"], ["x", "--attempts", "0"], ["x", "--timeout", "-1"], ["x", "--bogus"], ["x", "-o"]]) {
    const result = await cli(args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.match(result.stderr, /uso: frankframes generate/, JSON.stringify(args));
  }
});

test("pasta de saída com index.html sem --force: E_GEN_OUT_EXISTS, e o Codex nem é chamado", async () => {
  await withReplies([good], async (env, dir) => {
    const out = join(dir, "saida");
    const first = await cli(["abertura", "-o", out, "--no-render", "--no-studio"], env);
    assert.equal(first.code, 0, first.stderr);
    const trace = join(dir, "trace.jsonl");
    const second = await cli(["abertura", "-o", out, "--no-render", "--no-studio"], { ...env, FAKE_CODEX_TRACE: trace });
    assert.equal(second.code, 1);
    assert.match(second.stderr, /E_GEN_OUT_EXISTS/);
    assert.ok(!existsSync(trace), "o exec não rodou");
    const forced = await cli(["abertura", "-o", out, "--no-render", "--no-studio", "--force"], env);
    assert.equal(forced.code, 0, forced.stderr);
  });
});

test("o Codex falso recebe o argv fixo pela CLI (stdin, sem imagem, --model repassado)", async () => {
  await withReplies([good], async (env, dir) => {
    const trace = join(dir, "trace.jsonl");
    const result = await cli(["abertura de 3 s", "-o", join(dir, "saida"), "--no-render", "--no-studio", "--model", "gpt-fake"], { ...env, FAKE_CODEX_TRACE: trace, OPENAI_API_KEY: "nao-vaza" });
    assert.equal(result.code, 0, result.stderr);
    const call = JSON.parse(readFileSync(trace, "utf8").trim()) as { argv: string[]; stdin: string; hasOpenAiKey: boolean; hasFrankframesVar: boolean };
    assert.equal(call.argv[call.argv.indexOf("-m") + 1], "gpt-fake");
    assert.equal(call.argv.at(-1), "-");
    assert.ok(!call.argv.includes("-i") && !call.argv.includes("--image"));
    assert.match(call.stdin, /abertura de 3 s/);
    assert.equal(call.hasOpenAiKey, false);
    assert.equal(call.hasFrankframesVar, false);
  });
});

test("parseGenerateArgs: padrões, slug e limites", () => {
  const args = parseGenerateArgs(["Abertura de 6 s para o relatório!"]);
  assert.equal(args.out, "out/gerado-abertura-de-6-s-para-o-relatorio");
  assert.deepEqual([args.format, args.attempts, args.timeoutSeconds, args.render, args.studio, args.force], ["16:9", 3, 600, true, true, false]);
  assert.equal(slugify("Olá, mundo!!"), "ola-mundo");
  assert.equal(slugify("???"), "video");
  assert.ok(slugify("a".repeat(100)).length <= 40);
  assert.equal(parseGenerateArgs(["x", "--format", "9:16", "--duration", "8", "--attempts", "6"]).duration, 8);
  assert.throws(() => parseGenerateArgs(["x", "--attempts", "7"]), /--attempts/);
  assert.throws(() => parseGenerateArgs(["x", "--duration", "0"]), /--duration/);
});

test("openBrowserCommand: Windows usa `cmd /c start \"\" url` (a URL nunca vira o título da janela)", () => {
  assert.deepEqual(openBrowserCommand("http://127.0.0.1:1234/", "win32"), { command: "cmd", args: ["/c", "start", "", "http://127.0.0.1:1234/"] });
  assert.equal(openBrowserCommand("http://x/", "darwin").command, "open");
  assert.equal(openBrowserCommand("http://x/", "linux").command, "xdg-open");
});

const browser = await checkPinnedBrowser().catch(() => undefined);
const ffmpeg = await resolveFfmpeg().then(
  () => true,
  () => false,
);
const missing = browser === undefined || !(browser.present && browser.matches) ? "Chrome pinado ausente (rode `frankframes browser`)" : !ffmpeg ? "FFmpeg ausente (rode `node scripts/vendor-ffmpeg.ts`)" : undefined;

test("generate com render de verdade: draft.mp4 e 3 frames conferidos", { skip: missing, timeout: 300_000 }, async () => {
  await withReplies([good], async (env, dir) => {
    const out = join(dir, "saida");
    const result = await cli(["abertura", "-o", out, "--no-studio", "--json"], env);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { render: { outPath: string; durationSeconds: number }; frames: unknown[]; warnings: unknown[] };
    assert.ok(existsSync(join(out, "draft.mp4")));
    assert.equal(report.render.durationSeconds, 3);
    assert.equal(report.frames.length, 3);
    assert.ok(existsSync(join(out, ".generate", "attempt-1.log")));
  });
});
