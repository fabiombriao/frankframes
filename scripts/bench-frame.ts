// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Custo por frame, por fase (EDT-62). Uma sessão de Chrome, cenário `motion`, o mesmo caminho do `Session`
 * do motor (seek + settle, depois settle de novo, depois `Page.captureScreenshot`), mas com cada fase
 * cronometrada. Serve para confirmar ou derrubar H0/H1/H4 antes de tocar no motor.
 *
 *   node scripts/bench-frame.ts [--frames 120] [--gpu software|hardware] [--warmup 5] [--out out/bench]
 *
 * O `Session` público não expõe o CDP, então este script abre o Chrome com `puppeteer-core` e as mesmas
 * peças públicas do motor (`resolveChrome`, `resolveGpuMode`, `chromeArgs`, `startServer`) e do producer
 * (`prepare`). Nenhum arquivo de `packages/` muda.
 *
 * Fases (ms por frame, mediana dos frames depois do aquecimento):
 *   seekFrame        seek + settle numa única `evaluate` (o que `Session.seekFrame` faz)        — frames pares
 *   seekOnly         só o `clock.seek`                                                           — frames ímpares
 *   settleAfterSeek  o settle logo depois do seek, em `evaluate` separada                        — frames ímpares
 *   settlePaint      o segundo settle, o que `Session.capture` repete antes do screenshot        — todos
 *   captureScreenshot  `Page.captureScreenshot` como o produto faz hoje (`optimizeForSpeed: true`, H4),
 *                      incluindo trazer o base64                                                   — todos
 *   base64Decode / sha256  decodificar e hashear no Node                                          — todos
 * Variantes de screenshot, só medição, rodando em rodízio de ordem no mesmo frame já assentado:
 *   shotDefault (o PNG padrão do Chrome, o que o produto fazia antes do H4), shotSpeedTrue
 *   (`optimizeForSpeed: true`), shotSpeedFalse (`false`, igual ao padrão).
 * No baseline (anterior ao H4), `captureScreenshot` media o PNG padrão.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import puppeteer from "puppeteer-core";
import type { CDPSession, Page } from "puppeteer-core";
import { timeOfFrame } from "@frankframes/contract";
import { chromeArgs, resolveChrome, resolveGpuMode, startServer } from "@frankframes/engine";
import { prepare, resolveFfmpeg } from "@frankframes/producer";
import { REPO_ROOT, machineInfo, median, stageScenario, stamp } from "./bench/common.ts";

const { values } = parseArgs({
  options: {
    frames: { type: "string", default: "120" },
    gpu: { type: "string", default: "software" },
    warmup: { type: "string", default: "5" },
    out: { type: "string", default: "out/bench" },
  },
  strict: true,
});

const gpuFlag = values.gpu!;
if (gpuFlag !== "software" && gpuFlag !== "hardware") throw new Error(`--gpu "${gpuFlag}" inválido (use software ou hardware)`);
const sampleCount = Math.floor(Number(values.frames));
const warmup = Math.floor(Number(values.warmup));
if (!Number.isFinite(sampleCount) || sampleCount < 10) throw new Error("--frames precisa ser um inteiro >= 10");
if (!Number.isFinite(warmup) || warmup < 0 || warmup >= sampleCount - 2) throw new Error("--warmup precisa ser >= 0 e menor que --frames - 2");
const outDir = resolve(REPO_ROOT, values.out!);

/** Mesmos parâmetros do `Session.capture` (packages/engine/src/capture.ts). Se o motor mudar, atualize aqui. */
const PRODUCT_SHOT = { format: "png", captureBeyondViewport: false, optimizeForSpeed: true } as const;

interface ClockPage {
  __ff?: { ready: Promise<boolean>; seek: (ms: number) => number | Promise<number>; settle: () => Promise<boolean> };
  __ffMediaReady?: Promise<boolean>;
}

type Phase = "seekFrame" | "seekOnly" | "settleAfterSeek" | "settlePaint" | "captureScreenshot" | "base64Decode" | "sha256" | "shotDefault" | "shotSpeedTrue" | "shotSpeedFalse";
const PHASES: readonly Phase[] = ["seekFrame", "seekOnly", "settleAfterSeek", "settlePaint", "captureScreenshot", "base64Decode", "sha256", "shotDefault", "shotSpeedTrue", "shotSpeedFalse"];

const samples: Record<Phase, number[]> = Object.fromEntries(PHASES.map((phase) => [phase, [] as number[]])) as Record<Phase, number[]>;
const bytes = { shotDefault: [] as number[], shotSpeedTrue: [] as number[], shotSpeedFalse: [] as number[] };
let settleAtCap = 0;
let settleCount = 0;
let defaultEqualsFalse = 0;
let defaultEqualsTrue = 0;
let compared = 0;

const SETTLE_CAP_MS = 80;

async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - started };
}

const pair = await resolveFfmpeg();
const machine = await machineInfo(pair.ffmpeg);
const chrome = await resolveChrome();
const gpu = await resolveGpuMode(gpuFlag, chrome.path);
if (gpu !== gpuFlag) throw new Error(`o modo ${gpuFlag} não resolveu como pedido (veio ${gpu})`);

const stagedDir = join(outDir, "frame-bench");
const entry = await stageScenario("motion", stagedDir, 10);
const prepared = await prepare({ entry, ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe });
const server = await startServer(dirname(entry), { page: { path: basename(entry), html: prepared.compiledHtml } });

const browser = await puppeteer.launch({
  executablePath: chrome.path,
  headless: true,
  args: chromeArgs({ viewport: prepared.viewport, gpu }),
  defaultViewport: { ...prepared.viewport, deviceScaleFactor: 1 },
});

try {
  const page: Page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  await page.goto(`${server.url}${basename(entry)}`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const scope = globalThis as unknown as ClockPage;
    if (!scope.__ff) throw new Error("relógio virtual ausente");
    await scope.__ff.ready;
    if (scope.__ffMediaReady) await scope.__ffMediaReady;
    await scope.__ff.settle();
  });
  const cdp: CDPSession = await page.createCDPSession();
  // Mesma descartada de aquecimento que o motor faz na abertura da sessão.
  await cdp.send("Page.captureScreenshot", PRODUCT_SHOT);

  const settle = (): Promise<unknown> =>
    page.evaluate(async () => {
      await (globalThis as unknown as ClockPage).__ff!.settle();
    });
  const seekOnly = (ms: number): Promise<unknown> =>
    page.evaluate(async (value) => {
      await (globalThis as unknown as ClockPage).__ff!.seek(value);
    }, ms);
  const seekAndSettle = (ms: number): Promise<unknown> =>
    page.evaluate(async (value) => {
      const clock = (globalThis as unknown as ClockPage).__ff!;
      await clock.seek(value);
      await clock.settle();
    }, ms);
  const shot = async (extra: { optimizeForSpeed?: boolean }): Promise<Buffer> => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...extra });
    return Buffer.from(data, "base64");
  };

  // Frames espalhados pela composição inteira, em ordem crescente (como cada worker os percorre).
  const total = prepared.totalFrames;
  const stride = Math.max(1, Math.floor(total / sampleCount));
  const frames = Array.from({ length: sampleCount }, (_, index) => Math.min(total - 1, index * stride));

  for (const [index, frame] of frames.entries()) {
    const ms = timeOfFrame(frame, prepared.fps) * 1000;
    const record = index >= warmup;
    const push = (phase: Phase, value: number): void => {
      if (record) samples[phase].push(value);
    };

    if (index % 2 === 0) {
      push("seekFrame", (await timed(() => seekAndSettle(ms))).ms);
    } else {
      push("seekOnly", (await timed(() => seekOnly(ms))).ms);
      const after = (await timed(settle)).ms;
      push("settleAfterSeek", after);
      if (record) {
        settleCount += 1;
        if (after >= SETTLE_CAP_MS - 5) settleAtCap += 1;
      }
    }

    const again = (await timed(settle)).ms;
    push("settlePaint", again);
    if (record) {
      settleCount += 1;
      if (again >= SETTLE_CAP_MS - 5) settleAtCap += 1;
    }

    // O screenshot "do produto": PNG padrão, depois decodificação e hash, como em `Session.capture`.
    const base = await timed(() => cdp.send("Page.captureScreenshot", PRODUCT_SHOT));
    push("captureScreenshot", base.ms);
    const decoded = await timed(async () => Buffer.from(base.value.data, "base64"));
    push("base64Decode", decoded.ms);
    const hashed = await timed(async () => createHash("sha256").update(decoded.value).digest("hex"));
    push("sha256", hashed.ms);

    // Variantes, em rodízio de ordem para a ordem não favorecer ninguém. O frame já está assentado.
    const order: Array<["shotDefault" | "shotSpeedTrue" | "shotSpeedFalse", { optimizeForSpeed?: boolean }]> = [
      ["shotDefault", {}],
      ["shotSpeedTrue", { optimizeForSpeed: true }],
      ["shotSpeedFalse", { optimizeForSpeed: false }],
    ];
    const rotation = index % 3;
    const rotated = [...order.slice(rotation), ...order.slice(0, rotation)];
    const pngs = new Map<string, Buffer>();
    for (const [name, extra] of rotated) {
      const result = await timed(() => shot(extra));
      push(name, result.ms);
      if (record) bytes[name].push(result.value.length);
      pngs.set(name, result.value);
    }
    if (record) {
      compared += 1;
      if (pngs.get("shotDefault")!.equals(pngs.get("shotSpeedFalse")!)) defaultEqualsFalse += 1;
      if (pngs.get("shotDefault")!.equals(pngs.get("shotSpeedTrue")!)) defaultEqualsTrue += 1;
    }
  }

  if (pageErrors.length > 0) throw new Error(`erro de script na página: ${pageErrors[0]}`);
} finally {
  await browser.close();
  await server.close();
  await rm(prepared.workDir, { recursive: true, force: true });
}

const summary = Object.fromEntries(
  PHASES.filter((phase) => samples[phase].length > 0).map((phase) => {
    const list = samples[phase];
    return [phase, { n: list.length, medianMs: median(list), minMs: Math.min(...list), maxMs: Math.max(...list) }];
  }),
);

const sizeSummary = Object.fromEntries(
  (Object.keys(bytes) as Array<keyof typeof bytes>).map((name) => [name, { medianBytes: median(bytes[name]) }]),
);

const document = {
  startedAt: new Date().toISOString(),
  gpuRequested: gpuFlag,
  gpuEffective: gpu,
  frames: sampleCount,
  warmup,
  totalFramesInComposition: prepared.totalFrames,
  machine,
  summary,
  sizeSummary,
  settleCapShare: { atCap: settleAtCap, of: settleCount, capMs: SETTLE_CAP_MS },
  pngIdentity: { compared, defaultEqualsOptimizeFalse: defaultEqualsFalse, defaultEqualsOptimizeTrue: defaultEqualsTrue },
  samples,
};

await mkdir(outDir, { recursive: true });
const jsonPath = join(outDir, `frame-${gpu}-${stamp()}.json`);
await writeFile(jsonPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

const fmt = (value: number): string => value.toFixed(2);
const lines = [
  `### bench-frame — gpu ${gpu} — ${machine.cpu}, GPU: ${machine.gpuRenderer}`,
  "",
  `${sampleCount - warmup} frames medidos (${warmup} de aquecimento descartados), cenário motion 1080p. Tempos em ms.`,
  "",
  "| fase | n | mediana | mín | máx |",
  "|---|---|---|---|---|",
  ...Object.entries(summary).map(([phase, item]) => `| ${phase} | ${item.n} | ${fmt(item.medianMs)} | ${fmt(item.minMs)} | ${fmt(item.maxMs)} |`),
  "",
  `settle no teto de ${SETTLE_CAP_MS} ms: ${settleAtCap} de ${settleCount} medições (${((settleAtCap / Math.max(1, settleCount)) * 100).toFixed(0)} %).`,
  `PNG por variante (mediana de bytes): padrão ${Math.round(sizeSummary.shotDefault!.medianBytes)}, optimizeForSpeed true ${Math.round(sizeSummary.shotSpeedTrue!.medianBytes)}, false ${Math.round(sizeSummary.shotSpeedFalse!.medianBytes)}.`,
  `bytes idênticos ao padrão: optimizeForSpeed false ${defaultEqualsFalse}/${compared}, true ${defaultEqualsTrue}/${compared}.`,
  "",
  `JSON: ${jsonPath}`,
];
process.stdout.write(`${lines.join("\n")}\n`);
