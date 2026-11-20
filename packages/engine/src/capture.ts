// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createHash } from "node:crypto";
import puppeteer from "puppeteer-core";
import type { Browser, CDPSession, Page } from "puppeteer-core";
import { timeOfFrame } from "@frankframes/contract";
import { chromeArgs } from "./args.ts";
import type { GpuMode, ResolvedGpuMode, Viewport } from "./args.ts";
import { resolveChrome } from "./launch.ts";
import { probeRenderer, resolveGpuMode } from "./probe.ts";
import type { RendererInfo } from "./probe.ts";

/**
 * Browsers vivos deste processo. No Windows um Chrome órfão sobrevive ao Ctrl+C
 * e trava a porta de depuração do próximo render; matar no exit cobre isso.
 */
const liveBrowsers = new Set<Browser>();
let exitHookInstalled = false;

function trackBrowser(browser: Browser): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const tracked of liveBrowsers) {
        try {
          tracked.process()?.kill("SIGKILL");
        } catch {
          /* processo já morto */
        }
      }
      liveBrowsers.clear();
    });
  }
  liveBrowsers.add(browser);
}

export interface SessionOptions {
  url: string;
  viewport: Viewport;
  gpu: GpuMode;
  executablePath?: string;
}

export interface Session {
  /** Leva a composição ao tempo exato do frame. Idempotente e fora de ordem. */
  seekFrame: (frame: number, fps: { num: number; den: number }) => Promise<void>;
  /** PNG do frame atual + hash. */
  capture: () => Promise<{ png: Buffer; sha256: string }>;
  /** Erros de script na página: qualquer um derruba o render. */
  pageErrors: () => string[];
  /** Modo efetivo depois de resolver `auto`. */
  gpu: ResolvedGpuMode;
  /** Renderer real reportado pelo Chrome. */
  renderer: string;
  /** Avaliação no contexto da página (sonda de estado em teste). */
  evaluate: <T>(expression: string) => Promise<T>;
  close: () => Promise<void>;
}

interface VirtualClockWindow {
  __ff?: { ready: Promise<boolean>; seek: (ms: number) => number | Promise<number> };
  __ffMediaReady?: Promise<boolean>;
}

export async function openSession(options: SessionOptions): Promise<Session> {
  const chrome = await resolveChrome(options.executablePath);
  const gpu = await resolveGpuMode(options.gpu, chrome.path);
  const probe = gpu === "hardware" ? await probeRenderer(chrome.path) : undefined;
  const browser: Browser = await puppeteer.launch({
    executablePath: chrome.path,
    headless: true,
    args: chromeArgs({ viewport: options.viewport, gpu }),
    defaultViewport: { ...options.viewport, deviceScaleFactor: 1 },
  });

  trackBrowser(browser);
  try {
    return await startSession(browser, options, gpu, probe);
  } catch (error) {
    liveBrowsers.delete(browser);
    await browser.close().catch(() => {});
    throw error;
  }
}

async function startSession(
  browser: Browser,
  options: SessionOptions,
  gpu: ResolvedGpuMode,
  probe: RendererInfo | undefined,
): Promise<Session> {
  const page: Page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const clockReady = await page.evaluate(async () => {
    const clock = (globalThis as unknown as VirtualClockWindow).__ff;
    if (!clock) return "clock-ausente";
    await clock.ready;
    return "ok";
  });
  if (clockReady !== "ok") {
    await browser.close();
    throw new Error(`relógio virtual não disponível (${clockReady}): o HTML não foi servido pelo engine`);
  }

  await page.evaluate(async () => {
    const scope = globalThis as unknown as { __ffMediaReady?: Promise<boolean> };
    if (scope.__ffMediaReady) await scope.__ffMediaReady;
  });

  const cdp: CDPSession = await page.createCDPSession();

  return {
    seekFrame: async (frame, fps) => {
      const ms = timeOfFrame(frame, fps) * 1000;
      await page.evaluate((value) => (globalThis as unknown as VirtualClockWindow).__ff!.seek(value), ms);
    },
    capture: async () => {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const png = Buffer.from(data, "base64");
      return { png, sha256: createHash("sha256").update(png).digest("hex") };
    },
    pageErrors: () => [...pageErrors],
    evaluate: <T,>(expression: string) => page.evaluate(expression) as Promise<T>,
    gpu,
    renderer: probe?.renderer ?? "ANGLE SwiftShader (software)",
    close: async () => {
      liveBrowsers.delete(browser);
      await browser.close();
    },
  };
}
