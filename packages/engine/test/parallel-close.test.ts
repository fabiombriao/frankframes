// FrankFrames — proprietário. Ver LICENSE na raiz.
// Render paralelo: a falha de um worker fecha os outros, inclusive os que ainda estão abrindo, antes de a rejeição sair.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { openSession } from "../src/capture.ts";
import type { Session } from "../src/capture.ts";
import { resolveChrome } from "../src/launch.ts";
import { captureFramesInParallel } from "../src/parallel.ts";
import type { ParallelCaptureOptions } from "../src/parallel.ts";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "support", "parallel-late-open.ts");
/** Prazo próprio dos casos com sessão falsa: nada aqui espera mais que algumas dezenas de ms. */
const DEADLINE_MS = 2_000;

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function within<T>(promise: Promise<T>, what: string, ms = DEADLINE_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`pendurou: ${what} não terminou em ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

interface FakeSession {
  session: Session;
  seeks: number;
  closes: number;
}

function fakeSession(behavior: { seek?: () => Promise<void>; close?: () => Promise<void> } = {}): FakeSession {
  const fake: FakeSession = { seeks: 0, closes: 0, session: undefined as unknown as Session };
  fake.session = {
    seekFrame: async () => {
      fake.seeks += 1;
      await behavior.seek?.();
    },
    capture: async () => ({ png: Buffer.alloc(0), sha256: "x" }),
    pageErrors: () => [],
    close: async () => {
      fake.closes += 1;
      await behavior.close?.();
    },
  } as Partial<Session> as Session;
  return fake;
}

/** Cada chamada de `open` devolve uma abertura que o teste resolve ou rejeita quando quiser, na ordem dos workers. */
function manualOpenings(count: number): { open: NonNullable<ParallelCaptureOptions["open"]>; slots: Array<PromiseWithResolvers<Session>>; opened: () => number } {
  const slots = Array.from({ length: count }, () => Promise.withResolvers<Session>());
  let opened = 0;
  return { slots, opened: () => opened, open: () => slots[opened++]!.promise };
}

function capture(workers: number, extra: Partial<ParallelCaptureOptions>): { done: Promise<unknown>; settled: () => boolean } {
  let settled = false;
  const done = captureFramesInParallel({
    url: "http://127.0.0.1:0/",
    viewport: { width: 320, height: 180 },
    gpu: "software",
    fps: { num: 30, den: 1 },
    frames: [...Array(workers * 8).keys()],
    workers,
    ...extra,
  }).finally(() => {
    settled = true;
  });
  done.catch(() => undefined); // ignora-erro: cada teste confere a rejeição depois, com `assert.rejects`
  return { done, settled: () => settled };
}

test("falha na abertura de um worker: a abertura em andamento é esperada, fechada e não captura", async () => {
  const openings = manualOpenings(2);
  const run = capture(2, { open: openings.open });
  const boom = new Error("o worker A não abriu");
  const late = fakeSession();
  openings.slots[0]!.reject(boom);
  await tick(50);
  assert.equal(run.settled(), false, "rejeitou com a abertura do worker B ainda em andamento");
  openings.slots[1]!.resolve(late.session);
  await within(assert.rejects(run.done, (error) => error === boom), "a rejeição");
  assert.equal(openings.opened(), 2);
  assert.equal(late.closes, 1, "a sessão que abriu depois da falha ficou aberta");
  assert.equal(late.seeks, 0, "a sessão atrasada começou a capturar");
});

test("falha no meio da captura: cada sessão atrasada é fechada assim que abre", async () => {
  const openings = manualOpenings(3);
  const run = capture(3, { open: openings.open });
  const boom = new Error("o seek do worker A falhou");
  const first = fakeSession({ seek: async () => Promise.reject(boom) });
  const second = fakeSession();
  const third = fakeSession();
  openings.slots[0]!.resolve(first.session);
  await tick(20);
  openings.slots[1]!.resolve(second.session);
  await tick(20);
  assert.equal(second.closes, 1, "esperou a terceira abertura para fechar a segunda sessão");
  assert.equal(run.settled(), false, "rejeitou com a terceira abertura em andamento");
  openings.slots[2]!.resolve(third.session);
  await within(assert.rejects(run.done, (error) => error === boom), "a rejeição");
  assert.deepEqual([first, second, third].map((fake) => fake.closes), [1, 1, 1], "aberturas e fechamentos não batem");
  assert.deepEqual([second.seeks, third.seeks], [0, 0], "sessão atrasada começou a capturar");
});

test("falha de um worker não espera outro parado em onFrame (backpressure)", async () => {
  const openings = manualOpenings(2);
  const boom = new Error("o worker B falhou");
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = capture(2, { open: openings.open, onFrame: () => blocked });
  const stuck = fakeSession();
  const failing = fakeSession({ seek: async () => Promise.reject(boom) });
  openings.slots[0]!.resolve(stuck.session);
  await tick(20);
  openings.slots[1]!.resolve(failing.session);
  await within(assert.rejects(run.done, (error) => error === boom), "a rejeição");
  assert.deepEqual([stuck.closes, failing.closes], [1, 1]);
  release();
});

test("fechar também falha: o erro do worker continua principal e a falha do fechamento vai como causa", async () => {
  const closeBoom = new Error("o Chrome não fechou");
  const run = async (boom: Error): Promise<void> => {
    const openings = manualOpenings(2);
    const started = capture(2, { open: openings.open });
    openings.slots[0]!.resolve(fakeSession({ seek: async () => Promise.reject(boom) }).session);
    openings.slots[1]!.resolve(fakeSession({ close: async () => Promise.reject(closeBoom) }).session);
    await within(assert.rejects(started.done, (error) => error === boom), "a rejeição");
  };

  const plain = new Error("falha do worker");
  await run(plain);
  assert.equal(plain.cause, closeBoom);

  // Quem já tinha causa não a perde.
  const original = new Error("causa de antes");
  const caused = new Error("falha do worker", { cause: original });
  await run(caused);
  assert.ok(caused.cause instanceof AggregateError, `causa inesperada: ${String(caused.cause)}`);
  assert.deepEqual(caused.cause.errors, [original, closeBoom]);
});

test("captura completa com Chrome que não fecha: a chamada rejeita dizendo por quê", async () => {
  const openings = manualOpenings(2);
  const closeBoom = new Error("o Chrome não fechou");
  const run = capture(2, { open: openings.open });
  openings.slots[0]!.resolve(fakeSession().session);
  openings.slots[1]!.resolve(fakeSession({ close: async () => Promise.reject(closeBoom) }).session);
  await within(
    assert.rejects(run.done, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /fechar o Chrome falhou: o Chrome não fechou/);
      assert.deepEqual(error.errors, [closeBoom]);
      return true;
    }),
    "a rejeição",
  );
});

async function chromeOrSkip(t: TestContext): Promise<boolean> {
  try {
    await resolveChrome();
    return true;
  } catch {
    t.skip("Chrome não encontrado");
    return false;
  }
}

test("Chrome real, abertura que falha com um Chrome que não fecha: o erro da abertura vence e o processo é morto", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  const closeBoom = new Error("o Chrome não fechou");
  const launch = puppeteer.launch.bind(puppeteer);
  let chrome: ChildProcess | undefined;
  t.mock.method(puppeteer, "launch", async (options: Parameters<typeof launch>[0]) => {
    const browser = await launch(options);
    chrome = browser.process() ?? undefined;
    browser.close = async () => Promise.reject(closeBoom);
    return browser;
  });
  const alive = (): boolean => chrome !== undefined && chrome.exitCode === null && chrome.signalCode === null;
  t.after(() => {
    if (alive()) chrome?.kill("SIGKILL");
  });

  await assert.rejects(
    openSession({ url: "data:text/html,<p>sem relogio</p>", viewport: { width: 320, height: 180 }, gpu: "software" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /relógio virtual não disponível \(clock-ausente\)/);
      assert.equal(error.cause, closeBoom);
      return true;
    },
  );
  assert.ok(chrome !== undefined, "o Chrome não foi aberto");
  if (alive()) await within(once(chrome, "exit"), "a saída do processo do Chrome", 10_000);
});

test("Chrome real, 2 workers e um falhando na abertura: o processo sai sozinho", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  const child = await new Promise<{ code: number | string | null; output: string }>((resolve) => {
    execFile(process.execPath, [CHILD], { timeout: 240_000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : (error.code ?? error.signal ?? null), output: `${stdout}${stderr}` });
    });
  });
  assert.match(child.output, /rejeitou: relógio virtual não disponível \(clock-ausente\)/);
  assert.equal(child.code, 0, `o processo não saiu sozinho:\n${child.output}`);
});
