// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEAK_LIST_LIMIT, formatLeaks, guardTempLeaks, newTempEntries, snapshotTemp } from "../../../scripts/test-support/temp-leaks.ts";
import { makeTempDir, tempDir, withTempDir } from "../../../scripts/test-support/temp.ts";

interface Step {
  ok: boolean;
  detail?: string;
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

test("newTempEntries conta só ff-* novos e ignora o que já existia e o que não é ff-", async (t) => {
  const fake = await tempDir(t, "ff-leaks-fake-");
  await mkdir(join(fake, "ff-antigo"));
  await mkdir(join(fake, "outro-programa"));
  const before = await snapshotTemp(fake);
  assert.deepEqual([...before], ["ff-antigo"]);

  await mkdir(join(fake, "ff-novo-b"));
  await writeFile(join(fake, "ff-novo-a.json"), "{}");
  await mkdir(join(fake, "nao-ff-novo"));
  assert.deepEqual(await newTempEntries(before, fake), ["ff-novo-a.json", "ff-novo-b"]);
});

test("guardTempLeaks reprova a etapa que deixa ff-* novo, nomeia o diretório e mantém os antigos", async (t) => {
  const fake = await tempDir(t, "ff-leaks-gate-");
  await mkdir(join(fake, "ff-de-execucao-antiga"));
  const messages: string[] = [];

  const result = await guardTempLeaks(
    "testes rápidos",
    async (): Promise<Step> => {
      await mkdir(join(fake, "ff-esqueceu-de-limpar-123"));
      return { ok: true };
    },
    { dir: fake, report: (text) => messages.push(text) },
  );

  assert.equal(result.ok, false, "etapa que vazou diretório tem de reprovar");
  assert.match(result.detail ?? "", /1 ff-\* novo\(s\)/);
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /testes rápidos: 1 diretório\(s\) ff-\* novo\(s\)/);
  assert.match(messages[0] ?? "", /ff-esqueceu-de-limpar-123/);
  assert.doesNotMatch(messages[0] ?? "", /ff-de-execucao-antiga/, "o antigo não conta");
  assert.ok(await exists(join(fake, "ff-de-execucao-antiga")), "o gate nunca apaga nada do usuário");
  assert.ok(await exists(join(fake, "ff-esqueceu-de-limpar-123")), "nem o que ele reprovou");
});

test("guardTempLeaks deixa passar a etapa que limpa depois de si e preserva o resultado", async (t) => {
  const fake = await tempDir(t, "ff-leaks-clean-");
  await mkdir(join(fake, "ff-antigo"));
  const messages: string[] = [];
  const result = await guardTempLeaks(
    "suíte completa",
    async () => {
      const { remove } = await makeTempDir("ff-leaks-inner-");
      await remove();
      return { ok: true, detail: "tudo certo", ms: 7 };
    },
    { dir: fake, report: (text) => messages.push(text) },
  );
  assert.deepEqual(result, { ok: true, detail: "tudo certo", ms: 7 });
  assert.deepEqual(messages, []);
});

test("guardTempLeaks: etapa já reprovada continua reprovada e soma a sobra ao detalhe", async (t) => {
  const fake = await tempDir(t, "ff-leaks-both-");
  const result = await guardTempLeaks(
    "testes rápidos",
    async () => {
      await mkdir(join(fake, "ff-sobra"));
      return { ok: false, detail: "exit 1" };
    },
    { dir: fake, report: () => {} },
  );
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /^exit 1; 1 ff-\* novo\(s\)/);
});

test("a mensagem lista no máximo 20 nomes e informa o total", () => {
  const leaked = Array.from({ length: 27 }, (_, index) => `ff-x-${String(index).padStart(2, "0")}`);
  const text = formatLeaks("suíte completa", leaked, "C:\Temp");
  assert.equal(LEAK_LIST_LIMIT, 20);
  assert.match(text, /27 diretório\(s\) ff-\* novo\(s\) ficaram em C:\Temp/);
  assert.equal(text.split("\n").filter((line) => line.startsWith("  - ")).length, 20);
  assert.match(text, /… e mais 7/);
  assert.match(text, /ff-x-19/);
  assert.doesNotMatch(text, /ff-x-20/);
});

test("tempDir remove o diretório quando o teste termina", async (t) => {
  let dir = "";
  await t.test("filho cria", async (child) => {
    dir = await tempDir(child, "ff-leaks-child-");
    await writeFile(join(dir, "arquivo.txt"), "x");
    assert.ok(await exists(dir));
  });
  assert.notEqual(dir, "");
  assert.equal(await exists(dir), false, "o diretório do filho some quando o filho termina");
});

test("o prefixo precisa começar com ff-", async (t) => {
  await assert.rejects(tempDir(t, "sem-prefixo-"), /precisa começar com "ff-"/);
  await assert.rejects(makeTempDir("frankframes-"), /precisa começar com "ff-"/);
  await assert.rejects(withTempDir("x-", async () => undefined), /precisa começar com "ff-"/);
});

test("withTempDir remove no fim, também quando o corpo falha, e não mascara falha de remoção", async () => {
  let kept = "";
  const value = await withTempDir("ff-leaks-with-", async (dir) => {
    kept = dir;
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(await exists(kept), false);

  await assert.rejects(
    withTempDir("ff-leaks-with-", async (dir) => {
      kept = dir;
      throw new Error("corpo falhou");
    }),
    /corpo falhou/,
  );
  assert.equal(await exists(kept), false, "remove mesmo com o corpo falhando");

  // force:false de propósito: diretório que o corpo já apagou é erro visível, não sucesso silencioso.
  await assert.rejects(
    withTempDir("ff-leaks-with-", async (dir) => {
      await rm(dir, { recursive: true });
    }),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("o helper cria dentro de os.tmpdir()", async (t) => {
  const dir = await tempDir(t, "ff-leaks-where-");
  assert.ok(dir.startsWith(tmpdir()));
});
