// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Laboratório do EDT-77: por que `examples/cena-dupla` em `--gpu auto` (hardware) com vários workers dá
 * hashes diferentes por frame entre rodadas na mesma máquina. Só diagnóstico; nenhum arquivo de `packages/`
 * muda e o produto não usa nada daqui.
 *
 *   node scripts/bench/hw-determinism-lab.ts --list
 *   node scripts/bench/hw-determinism-lab.ts --exp base-w6,w1,w2 [--rounds 5] [--frames 240] [--variants]
 *
 * Cada experimento (`EXPERIMENTS`) muda UMA variável em relação ao `base-w6` (o caminho do produto:
 * 6 browsers, fila dinâmica de lotes de 8 frames, hardware, 2 esperas de paint por frame):
 *   H1 agendamento/concorrência : workers 1/2/3/6; browsers abertos mas só um trabalha por vez (`serial`)
 *   H2 ordem dos frames          : fatias contíguas fixas, intercaladas fixas, ordem embaralhada com 1 worker
 *   H3 compositor de GPU         : um browser com N abas (um processo de GPU) vs N browsers; --disable-gpu-compositing
 *   H4 seek -> captura           : 1/2/3 esperas de paint e atraso fixo antes do screenshot
 *   H5 aquecimento               : posição dos frames divergentes dentro do lote e da sequência do worker
 *
 * A sessão do laboratório repete a de `packages/engine/src/capture.ts` (mesmas flags via `chromeArgs`, mesmos
 * parâmetros de screenshot, primeira captura com 3 leituras iguais). O experimento `engine-w6` usa o motor de
 * verdade (`captureFramesInParallel`) e `render-w6` o render completo, para provar que o laboratório reproduz o produto.
 *
 * Saída: tabela no stdout e JSON em `out/hw-lab/` (ignorado pelo git). Mede só hash por frame; nada de vídeo.
 */
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { parseArgs } from "node:util";
import puppeteer from "puppeteer-core";
import type { Browser, CDPSession, Page } from "puppeteer-core";
import { timeOfFrame } from "@frankframes/contract";
import { captureFramesInParallel, chromeArgs, resolveChrome, resolveGpuMode, startServer } from "@frankframes/engine";
import { prepare, renderComposition, resolveFfmpeg } from "@frankframes/producer";
import { REPO_ROOT, stamp } from "./common.ts";

const SHOT = { format: "png", captureBeyondViewport: false, optimizeForSpeed: true } as const;
const BATCH = 8;

type Assign = "dynamic" | "static-contig" | "static-interleave" | "single-shuffled";

interface Config {
  workers: number;
  /** `per-worker`: um Chrome (e um processo de GPU) por worker; `shared`: um Chrome com N abas. */
  browsers: "per-worker" | "shared";
  assign: Assign;
  /** Só uma sessão trabalha por vez (seek + captura), embora todos os browsers estejam abertos. */
  serial: boolean;
  /** Esperas de paint dentro de `capture()` depois da espera do seek (produto em hardware: 1; em software: 0). */
  captureSettles: number;
  /** Atraso fixo, em ms, entre a última espera e o screenshot. */
  delayMs: number;
  /** Flags extras do Chrome, depois das do motor. */
  flags: string[];
  note: string;
}

const BASE: Config = {
  workers: 6,
  browsers: "per-worker",
  assign: "dynamic",
  serial: false,
  captureSettles: 1,
  delayMs: 0,
  flags: [],
  note: "caminho do produto: 6 browsers, fila dinâmica de lotes de 8, hardware, 2 esperas",
};

const EXPERIMENTS: Record<string, Config> = {
  "base-w6": BASE,
  // H1: quantos browsers trabalham ao mesmo tempo
  w1: { ...BASE, workers: 1, note: "H1: 1 worker" },
  w2: { ...BASE, workers: 2, note: "H1: 2 workers" },
  w3: { ...BASE, workers: 3, note: "H1: 3 workers" },
  "w6-serial": { ...BASE, serial: true, note: "H1: 6 browsers abertos, só um trabalha por vez (fila dinâmica)" },
  // H2: ordem dos frames por worker
  "w6-contig": { ...BASE, assign: "static-contig", note: "H2: 6 workers, cada um com a mesma fatia contígua fixa de 40 frames" },
  "w6-interleave": { ...BASE, assign: "static-interleave", note: "H2: 6 workers, frame i sempre no worker i % 6" },
  "w1-shuffled": { ...BASE, workers: 1, assign: "single-shuffled", note: "H2: 1 worker, lotes em ordem embaralhada (muda a cada rodada)" },
  "w6-serial-shuffled": { ...BASE, assign: "single-shuffled", serial: true, note: "H2: 6 browsers abertos, lotes embaralhados entre eles, um por vez" },
  // H3: compositor de GPU
  "w6-shared": { ...BASE, browsers: "shared", note: "H3: 1 Chrome com 6 abas (um processo de GPU)" },
  "w6-nogpucomp": { ...BASE, flags: ["--disable-gpu-compositing"], note: "H3: 6 browsers com --disable-gpu-compositing" },
  "w6-nogpucomp-settle0": { ...BASE, captureSettles: 0, flags: ["--disable-gpu-compositing"], note: "EDT-77 passo 2: --disable-gpu-compositing sem a espera extra da captura em hardware" },
  "w1-nogpucomp": { ...BASE, workers: 1, flags: ["--disable-gpu-compositing"], note: "H3: 1 browser com --disable-gpu-compositing" },
  // H4: tempo entre seek e captura
  "w6-settle0": { ...BASE, captureSettles: 0, note: "H4: 1 espera por frame (a do seek)" },
  "w6-settle2": { ...BASE, captureSettles: 2, note: "H4: 3 esperas por frame" },
  "w6-settle3": { ...BASE, captureSettles: 3, note: "H4: 4 esperas por frame" },
  "w6-delay100": { ...BASE, delayMs: 100, note: "H4: 100 ms de atraso fixo antes do screenshot" },
  "w6-delay250": { ...BASE, delayMs: 250, note: "H4: 250 ms de atraso fixo antes do screenshot" },
};

const SPECIAL = ["engine-w6", "render-w6"] as const;

const { values } = parseArgs({
  options: {
    exp: { type: "string", default: "" },
    rounds: { type: "string", default: "5" },
    frames: { type: "string", default: "240" },
    out: { type: "string", default: "out/hw-lab" },
    variants: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    // Alterna os experimentos rodada a rodada, para a carga da máquina pesar igual em todos.
    interleave: { type: "boolean", default: false },
    entry: { type: "string", default: "examples/cena-dupla/index.html" },
  },
  strict: true,
});

if (values.list) {
  for (const [name, config] of Object.entries(EXPERIMENTS)) process.stdout.write(`${name.padEnd(20)} ${config.note}\n`);
  for (const name of SPECIAL) process.stdout.write(`${name.padEnd(20)} ${name === "engine-w6" ? "motor real (captureFramesInParallel), 6 workers" : "render completo (com encode), 6 workers"}\n`);
  process.exit(0);
}

const names = values.exp!.split(",").map((name) => name.trim()).filter((name) => name !== "");
if (names.length === 0) throw new Error("--exp vazio: use --list para ver os experimentos");
for (const name of names) {
  if (!(name in EXPERIMENTS) && !(SPECIAL as readonly string[]).includes(name)) throw new Error(`experimento desconhecido: ${name}`);
}
const rounds = Math.floor(Number(values.rounds));
const frameCount = Math.floor(Number(values.frames));
if (!Number.isFinite(rounds) || rounds < 2) throw new Error("--rounds precisa ser um inteiro >= 2");
if (!Number.isFinite(frameCount) || frameCount < 8) throw new Error("--frames precisa ser um inteiro >= 8");
const outDir = resolve(REPO_ROOT, values.out!);

interface ClockPage {
  __ff?: { ready: Promise<boolean>; seek: (ms: number) => number | Promise<number>; settle: () => Promise<boolean> };
  __ffMediaReady?: Promise<boolean>;
}

/** Uma captura observada: o hash e o contexto em que ela aconteceu. */
interface Obs {
  frame: number;
  hash: string;
  worker: number;
  /** Índice do frame na sequência do próprio worker (0 = primeira captura da sessão). */
  seq: number;
  /** Posição dentro do lote de 8 (0..7). */
  batchPos: number;
  /** Frame capturado logo antes, na mesma sessão (-1 = nenhum). */
  prev: number;
  /** Alguma espera de paint do frame (seek ou captura) levou 80 ms ou mais: o teto de `settlePaint` disparou (-1 = não medido). */
  capHit: number;
  /** Quantas esperas de paint do frame (seek + captura) bateram o teto de 80 ms (-1 = não medido). */
  capCount: number;
  /** Quantas esperas de paint o frame fez no total (-1 = não medido). */
  settleCalls: number;
  /** Maior espera de paint do frame, em ms (-1 = não medido). */
  settleMaxMs: number;
}

interface Prepared {
  url: string;
  viewport: { width: number; height: number };
  fps: { num: number; den: number };
  totalFrames: number;
  chromePath: string;
  close: () => Promise<void>;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Sessão do laboratório: a de `capture.ts`, com as variáveis do experimento. */
interface LabSession {
  seek: (frame: number) => Promise<void>;
  capture: () => Promise<Buffer>;
  /** Esperas de paint (ms, tempo real) desde a última leitura; zera o contador. */
  takeSettleMs: () => Promise<number[]>;
  /** Todas as esperas da sessão: `ms` = o que o `settlePaint` levou; `shadowMs` = quando a cadeia sem teto terminou (-1 = ainda não). */
  takeAllEntries: () => Promise<Array<{ ms: number; shadowMs: number }>>;
}

async function openLabPage(
  page: Page,
  prepared: Prepared,
  config: Config,
): Promise<LabSession> {
  // Só laboratório: guarda o rAF/setTimeout reais ANTES de o relógio virtual os trocar (o relógio os captura depois deste script).
  await page.evaluateOnNewDocument(() => {
    (globalThis as unknown as { __labReal: unknown }).__labReal = {
      raf: window.requestAnimationFrame.bind(window),
      timeout: window.setTimeout.bind(window),
    };
  });
  await page.goto(prepared.url, { waitUntil: "domcontentloaded", timeout: 125_000 });
  await page.evaluate(async () => {
    const scope = globalThis as unknown as ClockPage;
    if (!scope.__ff) throw new Error("relógio virtual ausente");
    await scope.__ff.ready;
    if (scope.__ffMediaReady) await scope.__ffMediaReady;
  });
  // Mede cada espera de paint em tempo real (o relógio virtual esconde `performance.now`; o protótipo não).
  // Cadeia-sombra (só laboratório, não muda o `settlePaint`): rAF -> rAF -> setTimeout(0) com os timers reais, sem teto;
  // `shadowMs` é quanto o paint "de verdade" levou, mesmo quando o teto de 80 ms resolveu a espera antes.
  await page.evaluate(() => {
    interface Entry { ms: number; shadowMs: number }
    const scope = globalThis as unknown as {
      __ff: { settle: () => Promise<boolean> };
      __labSettleMs: Entry[];
      __labAllEntries: Entry[];
      __labReal: { raf: (cb: () => void) => number; timeout: (cb: () => void, ms: number) => number };
    };
    const original = scope.__ff.settle.bind(scope.__ff);
    const realNow = (): number => Performance.prototype.now.call(performance);
    scope.__labSettleMs = [];
    scope.__labAllEntries = [];
    scope.__ff.settle = async () => {
      const started = realNow();
      const entry: Entry = { ms: -1, shadowMs: -1 };
      scope.__labReal.raf(() => scope.__labReal.raf(() => scope.__labReal.timeout(() => { entry.shadowMs = realNow() - started; }, 0)));
      const result = await original();
      entry.ms = realNow() - started;
      scope.__labSettleMs.push(entry);
      scope.__labAllEntries.push(entry);
      return result;
    };
  });
  const cdp: CDPSession = await page.createCDPSession();
  const settle = (): Promise<unknown> =>
    page.evaluate(async () => {
      await (globalThis as unknown as ClockPage).__ff!.settle();
    });
  await settle();
  await cdp.send("Page.captureScreenshot", SHOT);
  const shot = async (): Promise<Buffer> => {
    const { data } = await cdp.send("Page.captureScreenshot", SHOT);
    return Buffer.from(data, "base64");
  };
  let primed = false;
  return {
    takeSettleMs: () =>
      page.evaluate(() => {
        const scope = globalThis as unknown as { __labSettleMs: Array<{ ms: number }> };
        const taken = scope.__labSettleMs.map((entry) => entry.ms);
        scope.__labSettleMs = [];
        return taken;
      }),
    takeAllEntries: () =>
      page.evaluate(() => {
        const scope = globalThis as unknown as { __labAllEntries: Array<{ ms: number; shadowMs: number }> };
        return scope.__labAllEntries.map((entry) => ({ ms: entry.ms, shadowMs: entry.shadowMs }));
      }),
    seek: (frame) => {
      const ms = timeOfFrame(frame, prepared.fps) * 1000;
      return page.evaluate(async (value) => {
        const clock = (globalThis as unknown as ClockPage).__ff!;
        await clock.seek(value);
        await clock.settle();
      }, ms);
    },
    capture: async () => {
      if (!primed) {
        // Igual ao motor: primeira captura da sessão = leitura, espera, e três leituras iguais.
        primed = true;
        await shot();
        await settle();
        let previous = await shot();
        let identical = 0;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await settle();
          const current = await shot();
          identical = current.equals(previous) ? identical + 1 : 0;
          previous = current;
          if (identical >= 2) return current;
        }
        return previous;
      }
      for (let i = 0; i < config.captureSettles; i += 1) await settle();
      if (config.delayMs > 0) await new Promise<void>((done) => setTimeout(done, config.delayMs));
      return shot();
    },
  };
}

/** Embaralhamento determinístico por semente (para o experimento de ordem embaralhada ser reproduzível). */
function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function batchesOf(frames: number[]): number[][] {
  const out: number[][] = [];
  for (let offset = 0; offset < frames.length; offset += BATCH) out.push(frames.slice(offset, offset + BATCH));
  return out;
}

interface RoundResult {
  obs: Obs[];
  seconds: number;
  png?: Map<number, Buffer>;
  /** Todas as esperas de paint da rodada (todas as sessões): ver `LabSession.takeAllEntries`. */
  entries: Array<{ ms: number; shadowMs: number }>;
}

async function runLabRound(prepared: Prepared, config: Config, round: number, keepPng: boolean): Promise<RoundResult> {
  const frames = [...Array(frameCount).keys()];
  const chromeArgsList = [...chromeArgs({ viewport: prepared.viewport, gpu: "hardware" }), ...config.flags];
  const launch = (): Promise<Browser> =>
    puppeteer.launch({
      executablePath: prepared.chromePath,
      headless: true,
      args: chromeArgsList,
      defaultViewport: { ...prepared.viewport, deviceScaleFactor: 1 },
    });

  const browsers: Browser[] = [];
  const pages: Page[] = [];
  try {
    if (config.browsers === "shared") {
      const browser = await launch();
      browsers.push(browser);
      for (let i = 0; i < config.workers; i += 1) pages.push(await browser.newPage());
    } else {
      for (let i = 0; i < config.workers; i += 1) {
        const browser = await launch();
        browsers.push(browser);
        pages.push(await browser.newPage());
      }
    }
    const sessions: LabSession[] = [];
    // Abre as sessões em sequência: a prontidão não compete com a captura dos outros.
    for (const page of pages) sessions.push(await openLabPage(page, prepared, config));

    // Plano de lotes por worker.
    const allBatches = batchesOf(frames);
    const plan: number[][][] = Array.from({ length: config.workers }, () => []);
    let queue: number[][] | undefined;
    if (config.assign === "dynamic") {
      queue = [...allBatches];
    } else if (config.assign === "single-shuffled") {
      queue = shuffle(allBatches, 1000 + round);
    } else if (config.assign === "static-contig") {
      const per = Math.ceil(frames.length / config.workers);
      for (let w = 0; w < config.workers; w += 1) plan[w] = batchesOf(frames.slice(w * per, (w + 1) * per));
    } else {
      for (let w = 0; w < config.workers; w += 1) plan[w] = batchesOf(frames.filter((frame) => frame % config.workers === w));
    }

    const mutex = new Mutex();
    const obs: Obs[] = [];
    const png = new Map<number, Buffer>();
    const started = performance.now();

    const work = async (w: number): Promise<void> => {
      const session = sessions[w] as LabSession;
      let seq = 0;
      let prev = -1;
      const step = async (frame: number, batchPos: number): Promise<void> => {
        const one = async (): Promise<void> => {
          await session.seek(frame);
          const buffer = await session.capture();
          const settleMs = await session.takeSettleMs();
          const settleMaxMs = Math.max(0, ...settleMs);
          obs.push({ frame, hash: createHash("sha256").update(buffer).digest("hex"), worker: w, seq, batchPos, prev, capHit: settleMaxMs >= 80 ? 1 : 0, capCount: settleMs.filter((ms) => ms >= 80).length, settleCalls: settleMs.length, settleMaxMs });
          if (keepPng) png.set(frame, buffer);
          seq += 1;
          prev = frame;
        };
        if (config.serial) await mutex.run(one);
        else await one();
      };
      for (;;) {
        const batch = queue !== undefined ? queue.shift() : plan[w]!.shift();
        if (batch === undefined) return;
        for (let i = 0; i < batch.length; i += 1) await step(batch[i] as number, i);
      }
    };
    await Promise.all(Array.from({ length: config.workers }, (_, w) => work(w)));
    const seconds = (performance.now() - started) / 1000;
    // Dá tempo para as cadeias-sombra dos frames com teto terminarem antes de ler.
    await new Promise<void>((done) => setTimeout(done, 600));
    const entries = (await Promise.all(sessions.map((session) => session.takeAllEntries()))).flat();
    return { obs, seconds, entries, ...(keepPng ? { png } : {}) };
  } finally {
    await Promise.allSettled(browsers.map((browser) => browser.close()));
  }
}

// ---------- análise ----------

interface Analysis {
  rounds: number;
  frames: number;
  unstableFrames: number;
  /** frames por número de variantes distintas (2, 3, ...). */
  variantHistogram: Record<string, number>;
  /** observações que diferem da moda do frame (nas rodadas em que o frame é instável). */
  minorityObservations: number;
  /** nas observações divergentes: posição dentro do lote (0..7). */
  minorityByBatchPos: number[];
  /** nas observações divergentes: seq do worker (0, 1..7, 8+). */
  minorityBySeq: { first: number; upTo8: number; later: number };
  /** nas observações em geral (todas), mesma distribuição, para comparar com a taxa-base. */
  allByBatchPos: number[];
  minorityByScene: { a: number; b: number };
  unstableByScene: { a: number; b: number };
  /** frames instáveis cujo hash é função do predecessor (prev) entre as rodadas. */
  explainedByPrev: number;
  /** frames instáveis cujo hash é função do worker entre as rodadas. */
  explainedByWorker: number;
  unstableList: number[];
  /** observações com o teto de 80 ms disparado / total (só laboratório). */
  capHits: number;
  observations: number;
  /** divergentes (vs. moda do frame) entre as observações com / sem teto disparado. */
  minorityWithCap: number;
  minorityWithoutCap: number;
  /** frames instáveis olhando só as observações em que o teto NÃO disparou. */
  unstableWithoutCapOnly: number;
  /** mediana e p95 da maior espera de paint por frame, em ms. */
  settleMedianMs: number;
  settleP95Ms: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number) * 10) / 10;
}

function analyze(perRound: Obs[][]): Analysis {
  const byFrame = new Map<number, Obs[]>();
  for (const roundObs of perRound) for (const o of roundObs) byFrame.set(o.frame, [...(byFrame.get(o.frame) ?? []), o]);
  const histogram: Record<string, number> = {};
  const minorityByBatchPos = Array<number>(BATCH).fill(0);
  const allByBatchPos = Array<number>(BATCH).fill(0);
  const minorityBySeq = { first: 0, upTo8: 0, later: 0 };
  const minorityByScene = { a: 0, b: 0 };
  const unstableByScene = { a: 0, b: 0 };
  const unstable: number[] = [];
  let minorityTotal = 0;
  let explainedByPrev = 0;
  let explainedByWorker = 0;
  const half = frameCount / 2;
  let capHits = 0;
  let observations = 0;
  let minorityWithCap = 0;
  let minorityWithoutCap = 0;
  let unstableWithoutCapOnly = 0;
  const settleMaxes: number[] = [];

  for (const [frame, list] of [...byFrame].sort((a, b) => a[0] - b[0])) {
    for (const o of list) {
      allByBatchPos[o.batchPos] = (allByBatchPos[o.batchPos] ?? 0) + 1;
      observations += 1;
      if (o.capHit === 1) capHits += 1;
      if (o.settleMaxMs >= 0) settleMaxes.push(o.settleMaxMs);
    }
    const counts = new Map<string, number>();
    for (const o of list) counts.set(o.hash, (counts.get(o.hash) ?? 0) + 1);
    if (new Set(list.filter((o) => o.capHit !== 1).map((o) => o.hash)).size > 1) unstableWithoutCapOnly += 1;
    if (counts.size <= 1) continue;
    unstable.push(frame);
    histogram[String(counts.size)] = (histogram[String(counts.size)] ?? 0) + 1;
    if (frame < half) unstableByScene.a += 1;
    else unstableByScene.b += 1;
    // Moda; empate -> o hash da primeira rodada.
    const first = list[0] as Obs;
    let modal = first.hash;
    for (const [hash, count] of counts) if (count > (counts.get(modal) ?? 0)) modal = hash;
    for (const o of list) {
      if (o.hash === modal) continue;
      minorityTotal += 1;
      if (o.capHit === 1) minorityWithCap += 1;
      else minorityWithoutCap += 1;
      minorityByBatchPos[o.batchPos] = (minorityByBatchPos[o.batchPos] ?? 0) + 1;
      if (o.seq === 0) minorityBySeq.first += 1;
      else if (o.seq < BATCH) minorityBySeq.upTo8 += 1;
      else minorityBySeq.later += 1;
      if (frame < half) minorityByScene.a += 1;
      else minorityByScene.b += 1;
    }
    const isFunctionOf = (key: (o: Obs) => number): boolean => {
      const seen = new Map<number, string>();
      let repeated = false;
      for (const o of list) {
        const k = key(o);
        const previous = seen.get(k);
        if (previous === undefined) seen.set(k, o.hash);
        else {
          repeated = true;
          if (previous !== o.hash) return false;
        }
      }
      return repeated;
    };
    if (isFunctionOf((o) => o.prev)) explainedByPrev += 1;
    if (isFunctionOf((o) => o.worker)) explainedByWorker += 1;
  }

  return {
    rounds: perRound.length,
    frames: byFrame.size,
    unstableFrames: unstable.length,
    variantHistogram: histogram,
    minorityObservations: minorityTotal,
    minorityByBatchPos,
    minorityBySeq,
    allByBatchPos,
    minorityByScene,
    unstableByScene,
    explainedByPrev,
    explainedByWorker,
    unstableList: unstable,
    capHits,
    observations,
    minorityWithCap,
    minorityWithoutCap,
    unstableWithoutCapOnly,
    settleMedianMs: percentile(settleMaxes, 0.5),
    settleP95Ms: percentile(settleMaxes, 0.95),
  };
}

// ---------- decodificador mínimo de PNG, para medir a diferença entre variantes ----------

interface Raw {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}

function decodePng(buffer: Buffer): Raw {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`PNG fora do formato esperado (depth ${depth}, color ${colorType}, interlace ${interlace})`);
      }
      channels = colorType === 2 ? 3 : 4;
    } else if (type === "IDAT") idat.push(body);
    offset += 12 + length;
  }
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (stride + 1)] as number;
    const line = inflated.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? (out[y * stride + x - channels] as number) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + x] as number) : 0;
      const upLeft = y > 0 && x >= channels ? (out[(y - 1) * stride + x - channels] as number) : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[y * stride + x] = ((line[x] as number) + predicted) & 255;
    }
  }
  return { width, height, channels, data: out };
}

function diffPng(a: Buffer, b: Buffer): { differingPixels: number; maxChannelDiff: number; bbox: string } {
  const left = decodePng(a);
  const right = decodePng(b);
  if (left.width !== right.width || left.height !== right.height) throw new Error("variantes com tamanhos diferentes");
  let differing = 0;
  let max = 0;
  let minX = left.width;
  let minY = left.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < left.height; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      const base = (y * left.width + x) * left.channels;
      let pixelDiff = 0;
      for (let c = 0; c < left.channels; c += 1) pixelDiff = Math.max(pixelDiff, Math.abs((left.data[base + c] as number) - (right.data[base + c] as number)));
      if (pixelDiff > 0) {
        differing += 1;
        max = Math.max(max, pixelDiff);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { differingPixels: differing, maxChannelDiff: max, bbox: differing === 0 ? "-" : `${minX},${minY}..${maxX},${maxY}` };
}

// ---------- execução ----------

function cpuSnapshot(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.idle + cpu.times.user + cpu.times.sys + cpu.times.nice + cpu.times.irq;
  }
  return { idle, total };
}

/** Carga ambiente (CPU ocupada, %) medida por 2 s antes do experimento, sem nenhum Chrome nosso rodando. */
async function ambientBusyPct(): Promise<number> {
  const before = cpuSnapshot();
  await new Promise<void>((done) => setTimeout(done, 2000));
  const after = cpuSnapshot();
  const total = after.total - before.total;
  return total <= 0 ? 0 : Math.round((1 - (after.idle - before.idle) / total) * 100);
}

const pair = await resolveFfmpeg();
const chrome = await resolveChrome();
const gpu = await resolveGpuMode("auto", chrome.path);
if (gpu !== "hardware") throw new Error(`auto resolveu como ${gpu}: esta máquina não tem GPU de hardware, o laboratório não tem o que medir`);
const entry = resolve(REPO_ROOT, values.entry!);
const prepared0 = await prepare({ entry, ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe });
const server = await startServer(dirname(entry), { page: { path: basename(entry), html: prepared0.compiledHtml } });
const prepared: Prepared = {
  url: `${server.url}${basename(entry)}`,
  viewport: prepared0.viewport,
  fps: prepared0.fps,
  totalFrames: prepared0.totalFrames,
  chromePath: chrome.path,
  close: () => server.close(),
};
if (frameCount > prepared.totalFrames) throw new Error(`--frames ${frameCount} passa do total da composição (${prepared.totalFrames})`);

const runId = stamp();
await mkdir(outDir, { recursive: true });
const summary: Array<Record<string, unknown>> = [];

interface State {
  perRound: Obs[][];
  seconds: number[];
  busy: number[];
  variantPng: Map<number, Map<string, Buffer>>;
  /** Esperas de paint por rodada (só laboratório). */
  entries: Array<Array<{ ms: number; shadowMs: number }>>;
}
const states = new Map<string, State>(names.map((name) => [name, { perRound: [], seconds: [], busy: [], variantPng: new Map(), entries: [] }]));

async function runRound(name: string, round: number): Promise<void> {
  const state = states.get(name) as State;
  const cpuBefore = cpuSnapshot();
  let obs: Obs[];
  let elapsed: number;
  if (name === "engine-w6") {
    const started = performance.now();
    const hashes = await captureFramesInParallel({
      url: prepared.url,
      viewport: prepared.viewport,
      gpu: "auto",
      fps: prepared.fps,
      frames: [...Array(frameCount).keys()],
      workers: 6,
      serverFailures: server.failures,
    });
    elapsed = (performance.now() - started) / 1000;
    obs = [...hashes].map(([frame, hash]) => ({ frame, hash, worker: -1, seq: -1, batchPos: frame % BATCH, prev: -1, capHit: -1, capCount: -1, settleCalls: -1, settleMaxMs: -1 }));
  } else if (name === "render-w6") {
    const work = join(outDir, `render-${runId}`);
    await mkdir(work, { recursive: true });
    const started = performance.now();
    const result = await renderComposition({
      entry,
      outPath: join(work, `r${round}.mp4`),
      ffmpeg: pair.ffmpeg,
      ffprobe: pair.ffprobe,
      codec: "av1",
      preset: "draft",
      workers: 6,
      gpu: "auto",
    });
    elapsed = (performance.now() - started) / 1000;
    obs = [...result.hashes].map(([frame, hash]) => ({ frame, hash, worker: -1, seq: -1, batchPos: frame % BATCH, prev: -1, capHit: -1, capCount: -1, settleCalls: -1, settleMaxMs: -1 }));
    await rm(work, { recursive: true, force: true });
  } else {
    const config = EXPERIMENTS[name] as Config;
    const result = await runLabRound(prepared, config, round, values.variants === true);
    obs = result.obs;
    elapsed = result.seconds;
    state.entries.push(result.entries);
    if (result.png !== undefined) {
      for (const [frame, buffer] of result.png) {
        const hash = createHash("sha256").update(buffer).digest("hex");
        const known = state.variantPng.get(frame) ?? new Map<string, Buffer>();
        if (!known.has(hash) && known.size < 3) known.set(hash, buffer);
        state.variantPng.set(frame, known);
      }
    }
  }
  const cpuAfter = cpuSnapshot();
  const totalTicks = cpuAfter.total - cpuBefore.total;
  const busy = totalTicks <= 0 ? 0 : Math.round((1 - (cpuAfter.idle - cpuBefore.idle) / totalTicks) * 100);
  state.perRound.push(obs);
  state.seconds.push(elapsed);
  state.busy.push(busy);
  const hashesThisRound = new Set(obs.map((o) => o.hash)).size;
  process.stdout.write(
    `  [${name}] rodada ${round + 1}/${rounds}: ${obs.length} frames, ${elapsed.toFixed(1)} s (${(obs.length / elapsed).toFixed(1)} fps), hashes distintos ${hashesThisRound}, CPU da máquina ${busy}%\n`,
  );
}

try {
  const ambient = await ambientBusyPct();
  process.stdout.write(`\nCPU ocupada antes de começar (sem nosso Chrome): ${ambient}%  | intercalado: ${values.interleave === true}\n`);
  // Só laboratório: uma rodada que falha (ex.: E_FONT_LOAD esporádico) não joga fora as já medidas; a análise segue com elas.
  try {
    if (values.interleave === true) {
      for (let round = 0; round < rounds; round += 1) for (const name of names) await runRound(name, round);
    } else {
      for (const name of names) for (let round = 0; round < rounds; round += 1) await runRound(name, round);
    }
  } catch (error) {
    process.stdout.write(`
!! RODADA ABORTADA: ${error instanceof Error ? error.message : String(error)}
   a análise abaixo usa só as rodadas concluídas: ${names.map((n) => `${n}=${(states.get(n) as State).perRound.length}`).join(" ")}
`);
  }

  for (const name of names) {
    const state = states.get(name) as State;
    const analysis = analyze(state.perRound);
    const config = name in EXPERIMENTS ? (EXPERIMENTS[name] as Config) : undefined;
    process.stdout.write(
      `\n== RESULTADO ${name}: ${analysis.unstableFrames}/${analysis.frames} frames instáveis em ${rounds} rodadas; ` +
        `variantes por frame ${JSON.stringify(analysis.variantHistogram)}; observações divergentes ${analysis.minorityObservations}; ` +
        `CPU da máquina por rodada ${state.busy.join("/")}%\n`,
    );
    // Por rodada: frames cujo hash difere da moda do frame nas outras rodadas (empate -> primeira rodada).
    {
      const modalOf = new Map<number, string>();
      const byFrame = new Map<number, Obs[]>();
      for (const roundObs of state.perRound) for (const o of roundObs) byFrame.set(o.frame, [...(byFrame.get(o.frame) ?? []), o]);
      for (const [frame, list] of byFrame) {
        const counts = new Map<string, number>();
        for (const o of list) counts.set(o.hash, (counts.get(o.hash) ?? 0) + 1);
        let modal = (list[0] as Obs).hash;
        for (const [hash, count] of counts) if (count > (counts.get(modal) ?? 0)) modal = hash;
        modalOf.set(frame, modal);
      }
      const perRoundDivergent = state.perRound.map((roundObs) => roundObs.filter((o) => o.hash !== modalOf.get(o.frame)).length);
      const perRoundVsFirst = state.perRound.map((roundObs, r) => {
        if (r === 0) return 0;
        const first = new Map((state.perRound[0] as Obs[]).map((o) => [o.frame, o.hash] as const));
        return roundObs.filter((o) => o.hash !== first.get(o.frame)).length;
      });
      process.stdout.write(`    por rodada: frames divergentes da moda ${perRoundDivergent.join("/")}; diferentes da rodada 1 ${perRoundVsFirst.join("/")}
`);
      const capPerFrame = new Map<number, number>();
      let settleCalls = 0;
      const capsByRound = state.perRound.map((roundObs) => roundObs.filter((o) => o.capCount > 0).length);
      for (const roundObs of state.perRound) for (const o of roundObs) if (o.capCount >= 0) { capPerFrame.set(o.capCount, (capPerFrame.get(o.capCount) ?? 0) + 1); settleCalls += o.settleCalls; }
      const all = state.entries.flat();
      const capped = all.filter((e) => e.ms >= 80);
      const shadow = capped.map((e) => e.shadowMs).filter((v) => v >= 0);
      if (all.length > 0) {
        process.stdout.write(
          `    teto de 80 ms: ${capped.length}/${all.length} esperas (${(100 * capped.length / all.length).toFixed(1)}%); frames com N tetos ${JSON.stringify(Object.fromEntries([...capPerFrame].sort((a, b) => a[0] - b[0])))}; frames com teto por rodada ${capsByRound.join("/")}; ` +
            `paint real nas esperas com teto (n=${shadow.length}, sem terminar ${capped.length - shadow.length}): mediana ${percentile(shadow, 0.5)} ms, p95 ${percentile(shadow, 0.95)} ms, máx ${percentile(shadow, 1)} ms; esperas sem teto: mediana ${percentile(all.filter((e) => e.ms < 80).map((e) => e.ms), 0.5)} ms
`,
        );
      }
    }
    if (analysis.settleMedianMs >= 0) {
      process.stdout.write(
        `    espera de paint por frame (maior de seek+captura): mediana ${analysis.settleMedianMs} ms, p95 ${analysis.settleP95Ms} ms; teto de 80 ms disparou em ${analysis.capHits}/${analysis.observations} frames; ` +
          `divergentes com teto ${analysis.minorityWithCap}, sem teto ${analysis.minorityWithoutCap}; frames instáveis só com observações sem teto: ${analysis.unstableWithoutCapOnly}
`,
      );
    }
    if (analysis.unstableFrames > 0) {
      process.stdout.write(
        `    cena A/B (frames instáveis): ${analysis.unstableByScene.a}/${analysis.unstableByScene.b}; divergentes por posição no lote 0..7: ${analysis.minorityByBatchPos.join(",")} ` +
          `(todas as observações: ${analysis.allByBatchPos.join(",")})\n` +
          `    divergentes por seq do worker: primeira ${analysis.minorityBySeq.first}, 1..7 ${analysis.minorityBySeq.upTo8}, 8+ ${analysis.minorityBySeq.later}\n` +
          `    hash é função do predecessor em ${analysis.explainedByPrev}/${analysis.unstableFrames} frames instáveis; do worker em ${analysis.explainedByWorker}/${analysis.unstableFrames}\n` +
          `    frames instáveis: ${analysis.unstableList.slice(0, 40).join(",")}${analysis.unstableList.length > 40 ? ",..." : ""}\n`,
      );
    }

    if (values.variants === true && analysis.unstableFrames > 0) {
      const vdir = join(outDir, `${name}-${runId}-variants`);
      await mkdir(vdir, { recursive: true });
      let shown = 0;
      for (const frame of analysis.unstableList) {
        const known = state.variantPng.get(frame);
        if (known === undefined || known.size < 2 || shown >= 6) continue;
        const entries = [...known];
        for (const [hash, buffer] of entries) await writeFile(join(vdir, `frame_${frame}_${hash.slice(0, 8)}.png`), buffer);
        const base = entries[0] as [string, Buffer];
        for (const other of entries.slice(1)) {
          const diff = diffPng(base[1], other[1]);
          process.stdout.write(
            `    frame ${frame}: ${base[0].slice(0, 8)} x ${other[0].slice(0, 8)} -> ${diff.differingPixels} px diferentes, maior diferença por canal ${diff.maxChannelDiff}, caixa ${diff.bbox}\n`,
          );
        }
        shown += 1;
      }
    }

    summary.push({ name, config, ambientBusyPct: ambient, rounds, seconds: state.seconds, busyPct: state.busy, analysis });
  }
} finally {
  await prepared.close();
}

const file = join(outDir, `lab-${runId}-${names.join("+").slice(0, 60)}.json`);
await writeFile(file, JSON.stringify({ machine: { gpu, chrome: chrome.path, node: process.version }, frames: frameCount, summary }, null, 2));
process.stdout.write(`\nJSON: ${file}\n`);
