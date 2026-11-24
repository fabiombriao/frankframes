// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCodexAuth, codexVersion, resolveCodex, runCodexExec, sanitizedEnv } from "../src/generate-codex.ts";
import type { CodexExecInput, ResolvedCodex } from "../src/generate-codex.ts";
import { GenerateError } from "../src/generate-errors.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const fake: ResolvedCodex = { command: process.execPath, args: [FAKE] };

function temp(t: TestContext, prefix: string): Promise<string> {
  return tempDir(t, `ff-codex-${prefix}-`);
}

const isGenerateError =
  (code: string, hint?: RegExp) =>
  (error: unknown): boolean =>
    error instanceof GenerateError && error.code === code && (hint === undefined || hint.test(error.hint));

function touch(file: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "");
}

test("resolveCodex (Windows): codex.cmd com codex.js ao lado roda `node codex.js`, sem shell", async (t) => {
  const dir = await temp(t, "cmd");
  touch(join(dir, "codex.cmd"));
  touch(join(dir, "node_modules", "@openai", "codex", "bin", "codex.js"));
  const found = resolveCodex({ env: { Path: dir }, platform: "win32" });
  assert.equal(found.command, process.execPath, "sem node.exe ao lado usa o node atual");
  assert.deepEqual(found.args, [join(dir, "node_modules", "@openai", "codex", "bin", "codex.js")]);

  touch(join(dir, "node.exe"));
  assert.equal(resolveCodex({ env: { PATH: dir }, platform: "win32" }).command, join(dir, "node.exe"));
});

test("resolveCodex (Windows): codex.exe vence codex.cmd", async (t) => {
  const dir = await temp(t, "exe");
  touch(join(dir, "codex.exe"));
  touch(join(dir, "codex.cmd"));
  assert.deepEqual(resolveCodex({ env: { PATH: dir }, platform: "win32" }), { command: join(dir, "codex.exe"), args: [] });
});

test("resolveCodex: codex.cmd sem codex.js é E_CODEX_MISSING com a dica de reinstalar", async (t) => {
  const dir = await temp(t, "nojs");
  touch(join(dir, "codex.cmd"));
  assert.throws(() => resolveCodex({ env: { PATH: dir }, platform: "win32" }), isGenerateError("E_CODEX_MISSING", /npm i -g @openai\/codex/));
});

test("resolveCodex: PATH vazio é E_CODEX_MISSING com a dica de instalar e logar", () => {
  assert.throws(() => resolveCodex({ env: { PATH: "" }, platform: "win32" }), isGenerateError("E_CODEX_MISSING", /instale o Codex CLI.*codex login/));
  assert.throws(() => resolveCodex({ env: {}, platform: "linux" }), isGenerateError("E_CODEX_MISSING"));
});

test("resolveCodex: FRANKFRAMES_CODEX inexistente não cai no PATH, mesmo com um codex válido lá", async (t) => {
  const dir = await temp(t, "forced");
  touch(join(dir, "codex.exe"));
  const env = { PATH: dir, FRANKFRAMES_CODEX: join(dir, "nao-existe.exe") };
  assert.throws(() => resolveCodex({ env, platform: "win32" }), isGenerateError("E_CODEX_MISSING", /FRANKFRAMES_CODEX/));
});

test("resolveCodex: FRANKFRAMES_CODEX para .mjs roda no node; para binário roda direto", async () => {
  assert.deepEqual(resolveCodex({ env: { FRANKFRAMES_CODEX: FAKE }, platform: process.platform }), { command: process.execPath, args: [FAKE] });
  assert.deepEqual(resolveCodex({ env: { FRANKFRAMES_CODEX: "/opt/codex" }, platform: "linux", pathExists: () => true }), { command: "/opt/codex", args: [] });
});

test("resolveCodex: codex.ps1 e o `codex` sem extensão do npm no Windows são ignorados", async (t) => {
  const dir = await temp(t, "ps1");
  touch(join(dir, "codex.ps1"));
  touch(join(dir, "codex"));
  assert.throws(() => resolveCodex({ env: { PATH: dir }, platform: "win32" }), isGenerateError("E_CODEX_MISSING"));
});

test("resolveCodex (POSIX): acha `codex` executável no PATH", () => {
  const found = resolveCodex({ env: { PATH: "/a:/usr/local/bin" }, platform: "linux", pathExists: (file) => file === "/usr/local/bin/codex" });
  assert.deepEqual(found, { command: "/usr/local/bin/codex", args: [] });
});

test("sanitizedEnv tira chaves de API e FRANKFRAMES_*, e deixa o resto", () => {
  const clean = sanitizedEnv({ OPENAI_API_KEY: "a", CODEX_API_KEY: "b", GROQ_API_KEY: "c", FRANKFRAMES_CODEX: "d", frankframes_x: "e", PATH: "p", HOME: "h" });
  assert.deepEqual(clean, { PATH: "p", HOME: "h" });
});

test("sanitizedEnv corta segredo do shell por padrão de nome e preserva o que o Codex precisa", () => {
  const secrets = { JIRA_API_TOKEN: "1", MY_SECRET: "2", AWS_SECRET_ACCESS_KEY: "3", DB_PASSWORD: "4", GITHUB_TOKEN: "5", STRIPE_KEY: "6", my_credentials_file: "7", Aws_Session_Token: "8" };
  const keep = { PATH: "p", HOME: "h", USERPROFILE: "u", APPDATA: "a", LOCALAPPDATA: "l", SystemRoot: "s", TEMP: "t", TMP: "t", CODEX_HOME: "c", LANG: "pt_BR", NODE_ENV: "test" };
  assert.deepEqual(sanitizedEnv({ ...secrets, ...keep }), keep);
});

test("codexVersion lê `codex --version`", async () => {
  assert.equal(await codexVersion(fake, process.env), "codex-cli 0.0.0-fake");
});

test("checkCodexAuth: só a conta ChatGPT passa; chave de API e deslogado são E_CODEX_AUTH", async () => {
  await checkCodexAuth(fake, { ...process.env, FAKE_CODEX_LOGIN: "chatgpt" });
  for (const login of ["apikey", "none"]) {
    await assert.rejects(checkCodexAuth(fake, { ...process.env, FAKE_CODEX_LOGIN: login }), isGenerateError("E_CODEX_AUTH", /codex login/), login);
  }
});

async function execFixture(t: TestContext, extra: Partial<CodexExecInput> = {}, env: NodeJS.ProcessEnv = {}): Promise<{ dir: string; trace: string; reply: string }> {
  const dir = await temp(t, "exec");
  const context = join(dir, "ctx");
  mkdirSync(context);
  writeFileSync(join(context, "SKILL.md"), "skill");
  writeFileSync(join(context, "schema.json"), "{}");
  const replies = join(dir, "replies.json");
  writeFileSync(replies, JSON.stringify([{ html: "<p>x</p>", blocks: [], notes: "" }]));
  const trace = join(dir, "trace.jsonl");
  const input: CodexExecInput = {
    prompt: "faça um vídeo — acentuação ok ✓",
    contextDir: context,
    schemaPath: join(context, "schema.json"),
    lastMessagePath: join(dir, "attempt-1.last.json"),
    timeoutMs: 20_000,
    logPath: join(dir, "attempt-1.log"),
    ...extra,
  };
  const reply = await runCodexExec(fake, { ...process.env, FAKE_CODEX_TRACE: trace, FAKE_CODEX_REPLIES: replies, ...env }, input);
  return { dir, trace, reply };
}

test("runCodexExec: argv fixo, prompt pelo stdin, sem imagem, cwd no contexto, env limpo", async (t) => {
  const { dir, trace, reply } = await execFixture(t, { model: "gpt-fake" }, { OPENAI_API_KEY: "sk-nao-e-real", CODEX_API_KEY: "x", FRANKFRAMES_CODEX: FAKE });
  const call = JSON.parse(readFileSync(trace, "utf8").trim()) as {
    argv: string[];
    stdin: string;
    cwd: string;
    files: string[];
    hasOpenAiKey: boolean;
    hasCodexKey: boolean;
    hasFrankframesVar: boolean;
  };
  for (const flag of ["exec", "--ephemeral", "--skip-git-repo-check", "--output-schema", "-o", "-C", "--ignore-user-config"]) {
    assert.ok(call.argv.includes(flag), `falta ${flag}`);
  }
  assert.equal(call.argv[call.argv.indexOf("-s") + 1], "read-only");
  assert.equal(call.argv[call.argv.indexOf("-m") + 1], "gpt-fake");
  assert.equal(call.argv.at(-1), "-", "o prompt vem do stdin");
  assert.ok(!call.argv.includes("-i") && !call.argv.includes("--image"), "nunca anexa imagem");
  assert.ok(!call.argv.includes("resume"), "cada tentativa é uma chamada nova");
  assert.equal(call.stdin, "faça um vídeo — acentuação ok ✓");
  assert.equal(realpathSync(call.cwd), realpathSync(join(dir, "ctx")));
  assert.deepEqual(call.files.sort(), ["SKILL.md", "schema.json"]);
  assert.equal(call.hasOpenAiKey, false, "OPENAI_API_KEY do pai não chega ao filho");
  assert.equal(call.hasCodexKey, false);
  assert.equal(call.hasFrankframesVar, false);
  assert.deepEqual(JSON.parse(reply), { html: "<p>x</p>", blocks: [], notes: "" });
  assert.match(readFileSync(join(dir, "attempt-1.log"), "utf8"), /fake-codex: ok/);
});

test("runCodexExec: sem -m quando não há modelo", async (t) => {
  const { trace } = await execFixture(t);
  const call = JSON.parse(readFileSync(trace, "utf8").trim()) as { argv: string[] };
  assert.ok(!call.argv.includes("-m"));
});

test("runCodexExec: saída diferente de zero é E_CODEX_FAILED com o caminho do log", async (t) => {
  await assert.rejects(
    execFixture(t, {}, { FAKE_CODEX_EXIT: "3" }),
    (error: unknown) => error instanceof GenerateError && error.code === "E_CODEX_FAILED" && /código 3/.test(error.message) && /attempt-1\.log/.test(error.hint),
  );
});

test("runCodexExec: estourar o tempo é E_CODEX_TIMEOUT e o processo morre", async (t) => {
  const dir = await temp(t, "timeout");
  const context = join(dir, "ctx");
  mkdirSync(context);
  const trace = join(dir, "trace.jsonl");
  const started = Date.now();
  await assert.rejects(
    runCodexExec(fake, { ...process.env, FAKE_CODEX_TRACE: trace, FAKE_CODEX_SLEEP_MS: "10000" }, {
      prompt: "x",
      contextDir: context,
      schemaPath: join(context, "s.json"),
      lastMessagePath: join(dir, "a.last.json"),
      timeoutMs: 1500,
      logPath: join(dir, "a.log"),
    }),
    isGenerateError("E_CODEX_TIMEOUT", /aumente --timeout/),
  );
  assert.ok(Date.now() - started < 8000, "não esperou o filho acabar sozinho");
  assert.ok(existsSync(trace), "o filho chegou a subir");
  const { pid } = JSON.parse(readFileSync(trace, "utf8").trim()) as { pid: number };
  assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} ainda vivo`);
});

test("runCodexExec: abortar mata o filho e vira E_CODEX_FAILED 'interrompido'", async (t) => {
  const dir = await temp(t, "abort");
  const context = join(dir, "ctx");
  mkdirSync(context);
  const trace = join(dir, "trace.jsonl");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1500);
  await assert.rejects(
    runCodexExec(fake, { ...process.env, FAKE_CODEX_TRACE: trace, FAKE_CODEX_SLEEP_MS: "10000" }, {
      prompt: "x",
      contextDir: context,
      schemaPath: join(context, "s.json"),
      lastMessagePath: join(dir, "a.last.json"),
      timeoutMs: 60_000,
      logPath: join(dir, "a.log"),
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof GenerateError && error.code === "E_CODEX_FAILED" && /interrompido/.test(error.message),
  );
  const { pid } = JSON.parse(readFileSync(trace, "utf8").trim()) as { pid: number };
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
