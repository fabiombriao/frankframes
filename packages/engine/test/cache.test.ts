// FrankFrames — proprietário. Ver LICENSE na raiz.
import { after, before, test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { evictCache, extractFramesCached, fileDigest, frameCacheKey } from "../src/cache.ts";
import { assetPath } from "../src/home.ts";

const run = promisify(execFile);

/** Diretórios que estes testes criam em os.tmpdir(). */
const TEMP_PREFIXES = ["ff-cache-", "ff-evict-"];
const listTemp = async (): Promise<string[]> => (await readdir(tmpdir())).filter((name) => TEMP_PREFIXES.some((prefix) => name.startsWith(prefix)));

// EDT-81: nenhum teste deste arquivo pode deixar diretório em %TEMP%. Compara com o que já existia antes da suíte.
let tempBefore = new Set<string>();
before(async () => {
  tempBefore = new Set(await listTemp());
});
after(async () => {
  const leaked = (await listTemp()).filter((name) => !tempBefore.has(name));
  assert.deepEqual(leaked, [], "os testes deixaram diretório temporário em os.tmpdir()");
});

/** Cada teste remove o próprio diretório; falha na remoção aparece no teste (sem force). */
async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: false }));
  return dir;
}

test("segunda extração do mesmo vídeo não chama o ffmpeg", { timeout: 300_000 }, async (t) => {
  const ffmpegPath = assetPath("ffmpeg", "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const pair = { ffmpeg: ffmpegPath };
  try {
    await run(pair.ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
  } catch {
    return t.skip("ffmpeg não encontrado");
  }

  const dir = await tempDir(t, "ff-cache-");
  const clip = join(dir, "clip.mp4");
  await run(pair.ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=1",
    "-c:v", "mpeg4", "-q:v", "5", "-pix_fmt", "yuv420p", "-y", clip,
  ]);
  const cacheRoot = join(dir, "cache");
  await mkdir(cacheRoot, { recursive: true });

  const options = { ffmpeg: pair.ffmpeg, input: clip, outDir: join(cacheRoot, "x"), fps: { num: 30, den: 1 }, offset: 0, duration: 1, root: cacheRoot };
  const first = await extractFramesCached(options);
  assert.equal(first.hit, false);
  assert.ok(first.frameCount >= 28);

  // Um binário que falha prova que a segunda chamada não extraiu nada.
  const broken = join(dir, "ffmpeg-quebrado");
  await writeFile(broken, "");
  const second = await extractFramesCached({ ...options, ffmpeg: broken });
  assert.equal(second.hit, true);
  assert.equal(second.frameCount, first.frameCount);
  assert.equal(second.dir, first.dir);
});

test("chave muda com janela e com conteúdo", () => {
  const base = { digest: "a".repeat(64), fps: { num: 30, den: 1 }, offset: 0, duration: 2 };
  assert.notEqual(frameCacheKey(base), frameCacheKey({ ...base, offset: 1 }));
  assert.notEqual(frameCacheKey(base), frameCacheKey({ ...base, duration: 3 }));
  assert.notEqual(frameCacheKey(base), frameCacheKey({ ...base, digest: "b".repeat(64), }));
  assert.equal(frameCacheKey(base), frameCacheKey({ ...base }));
});

test("evicção remove o mais antigo até caber no teto", async (t) => {
  const root = await tempDir(t, "ff-evict-");
  for (const [name, seconds] of [["velho", 1_000_000], ["novo", 1_100_000]] as const) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "frame.jpg"), Buffer.alloc(4096));
    await utimes(join(root, name), new Date(seconds * 1000), new Date(seconds * 1000));
  }
  const removed = await evictCache(root, 4096);
  assert.equal(removed, 1);
  assert.deepEqual(await readdir(root), ["novo"]);
});

test("evicção com inUse não apaga o diretório em escrita, mesmo sendo o mais antigo", async (t) => {
  const root = await tempDir(t, "ff-evict-uso-");
  for (const [name, seconds] of [["em-uso", 1_000_000], ["novo", 1_100_000]] as const) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "frame.jpg"), Buffer.alloc(4096));
    await utimes(join(root, name), new Date(seconds * 1000), new Date(seconds * 1000));
  }
  const removed = await evictCache(root, 4096, new Set([join(root, "em-uso")]));
  assert.equal(removed, 1);
  assert.deepEqual(await readdir(root), ["em-uso"], "o protegido fica; sai o que não está em uso");
});

/** Gera um clipe de teste e devolve o caminho do ffmpeg; `undefined` quando não há FFmpeg (o teste faz skip). */
async function makeClip(dir: string, seconds: number, size = "160x90"): Promise<{ ffmpeg: string; clip: string } | undefined> {
  const ffmpeg = assetPath("ffmpeg", "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  try {
    await run(ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
  } catch {
    return undefined;
  }
  const clip = join(dir, "clip.mp4");
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30:duration=${seconds}`,
    "-c:v", "mpeg4", "-q:v", "5", "-pix_fmt", "yuv420p", "-y", clip,
  ]);
  return { ffmpeg, clip };
}

test("duas extrações simultâneas do mesmo arquivo dão o mesmo dir, uma extração só e nenhum .tmp- sobrando", { timeout: 300_000 }, async (t) => {
  const dir = await tempDir(t, "ff-cache-conc-");
  const made = await makeClip(dir, 1);
  if (made === undefined) return t.skip("ffmpeg não encontrado");
  const cacheRoot = join(dir, "cache");
  const options = { ffmpeg: made.ffmpeg, input: made.clip, outDir: join(cacheRoot, "x"), fps: { num: 30, den: 1 }, offset: 0, duration: 1, root: cacheRoot };

  const [a, b, c] = await Promise.all([extractFramesCached(options), extractFramesCached(options), extractFramesCached(options)]);
  assert.equal(a.dir, b.dir);
  assert.equal(a.dir, c.dir);
  assert.equal(a.frameCount, b.frameCount);
  assert.equal([a, b, c].filter((item) => !item.hit).length, 1, "só uma das chamadas extraiu; as outras reaproveitaram");
  const entries = await readdir(cacheRoot);
  assert.deepEqual(entries.filter((name) => name.includes(".tmp-")), [], "sem diretório temporário");
  assert.equal(entries.length, 1);
});

test("cancelar no meio da extração não deixa .tmp- nem .complete falso, e a chamada seguinte extrai de verdade", { timeout: 300_000 }, async (t) => {
  const dir = await tempDir(t, "ff-cache-cancel-");
  // Um clipe longo o bastante para o abort cair no meio da extração.
  const made = await makeClip(dir, 40, "640x360");
  if (made === undefined) return t.skip("ffmpeg não encontrado");
  const cacheRoot = join(dir, "cache");
  const options = { ffmpeg: made.ffmpeg, input: made.clip, outDir: join(cacheRoot, "x"), fps: { num: 30, den: 1 }, offset: 0, duration: 40, root: cacheRoot };

  const controller = new AbortController();
  const pending = extractFramesCached({ ...options, signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(pending);
  assert.deepEqual(await readdir(cacheRoot), [], "nada sobra no cache depois do cancelamento");

  const again = await extractFramesCached(options);
  assert.equal(again.hit, false, "sem .complete falso: a extração acontece de novo");
  assert.ok(again.frameCount > 0);
});

/** `readdir` que devolve [] só para ENOENT (o temporário ainda não existe ou já foi limpo); qualquer outro erro sobe. */
async function listOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("cancelamentos em paralelo, com o FFmpeg escrevendo, não deixam .tmp- nem trocam o erro de cancelamento", { timeout: 300_000 }, async (t) => {
  const dir = await tempDir(t, "ff-cache-cancel-par-");
  const made = await makeClip(dir, 40, "640x360");
  if (made === undefined) return t.skip("ffmpeg não encontrado");
  const cacheRoot = join(dir, "cache");
  const digest = await fileDigest(made.clip);
  const fps = { num: 30, den: 1 };

  // Janelas distintas = chaves distintas: cada chamada é dona da própria extração (nenhuma só espera outra).
  // Rodadas de 12 em paralelo: carga alta demais atrasa o início do FFmpeg e o abort cai antes de ele escrever.
  const cancelOne = async (index: number): Promise<void> => {
    const offset = index * 0.05;
    const key = frameCacheKey({ digest, fps, offset, duration: 30 });
    const controller = new AbortController();
    const pending = extractFramesCached({
      ffmpeg: made.ffmpeg, input: made.clip, outDir: join(cacheRoot, "x"), fps,
      offset, duration: 30, root: cacheRoot, signal: controller.signal,
    });
    // O abort cai com o FFmpeg já escrevendo, em pontos diferentes (1, 5, 9... frames no temporário).
    const frames = 1 + (index % 6) * 4;
    // Vigia sequencial: no máximo uma leitura em voo e nenhuma depois do abort, para que nenhum handle do teste
    // esteja aberto no temporário quando a limpeza do extractInto rodar (no Windows isso vira EBUSY/ENOTEMPTY).
    let finished = false;
    let watcherError: unknown;
    const watcher = (async (): Promise<void> => {
      while (!finished) {
        const temp = (await listOrEmpty(cacheRoot)).find((name) => name.startsWith(`${key}.tmp-`));
        if (temp !== undefined && (await listOrEmpty(join(cacheRoot, temp))).length >= frames) {
          controller.abort();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })().catch((error: unknown) => {
      // Erro real de leitura (não ENOENT): encerra a chamada e o teste falha com ele, em vez de sumir.
      watcherError = error;
      controller.abort();
    });
    try {
      // O cancelamento tem de chegar como cancelamento, nunca como falha da limpeza (EBUSY, ENOTEMPTY...).
      await assert.rejects(pending, (error: Error) => error.name === "AbortError", `chamada ${index}`);
    } finally {
      finished = true;
      await watcher;
    }
    if (watcherError !== undefined) throw watcherError;
    // A promessa só rejeita depois da limpeza: conferir na hora, sem esperar. Só o temporário desta chamada
    // (o das outras ainda em extração é legítimo).
    const left = (await readdir(cacheRoot)).filter((name) => name.startsWith(`${key}.tmp-`));
    assert.deepEqual(left, [], `chamada ${index} deixou temporário`);
  };
  for (let round = 0; round < 8; round += 1) {
    await Promise.all(Array.from({ length: 12 }, (_, i) => cancelOne(round * 12 + i)));
  }
  assert.deepEqual(await readdir(cacheRoot), [], "nada sobra no cache depois de todos os cancelamentos");
});

test("evicção: remoção que falha avisa no stderr com o caminho e não conta como removida (EDT-83)", async (t) => {
  // Falha de remoção portátil não existe: no Windows um diretório que é o cwd de um processo vivo dá EBUSY.
  // Em POSIX seria preciso chmod/root, que varia entre ambientes; fica sem teste lá, de forma explícita.
  if (process.platform !== "win32") return t.skip("simulação de falha de remoção só implementada para Windows (cwd de processo vivo)");
  const root = await tempDir(t, "ff-evict-falha-");
  for (const [name, seconds] of [["preso", 1_000_000], ["livre", 1_100_000]] as const) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "frame.jpg"), Buffer.alloc(4096));
    await utimes(join(root, name), new Date(seconds * 1000), new Date(seconds * 1000));
  }
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: join(root, "preso"), stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  let removed: number;
  try {
    removed = await evictCache(root, 4096);
  } finally {
    process.stderr.write = original;
    // O processo solta o diretório antes de o `tempDir` apagá-lo (os hooks `t.after` rodam na ordem de registro).
    holder.kill();
    await new Promise((resolve) => holder.once("exit", resolve));
  }

  // O mais antigo ("preso") não saiu: não conta nem desconta; a evicção segue e tira o "livre".
  assert.equal(removed, 1);
  assert.deepEqual(await readdir(root), ["preso"]);
  assert.ok(stderr.includes("[frankframes] não consegui remover") && stderr.includes(join(root, "preso")), `stderr sem aviso com o caminho: ${JSON.stringify(stderr)}`);
});
