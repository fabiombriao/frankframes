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
  /** Recarrega a página mantendo o mesmo contexto de sessão (preview). */
  reload: () => Promise<void>;
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
  // Primeira captura descartada: força um frame completo antes de qualquer medição.
  await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });

  let primed = false;

  return {
    seekFrame: async (frame, fps) => {
      const ms = timeOfFrame(frame, fps) * 1000;
      await page.evaluate(async (value) => {
        const clock = (globalThis as unknown as VirtualClockWindow).__ff!;
        await clock.seek(value);
        await (clock as unknown as { settle?: () => Promise<boolean> }).settle?.();
      }, ms);
    },
    capture: async () => {
      const shot = async (): Promise<Buffer> => {
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        return Buffer.from(data, "base64");
      };
      const settlePaint = async (): Promise<void> => {
        await page.evaluate(async () => {
          const clock = (globalThis as unknown as VirtualClockWindow).__ff!;
          await (clock as unknown as { settle?: () => Promise<boolean> }).settle?.();
        });
      };

      // A primeira captura de uma sessão pode pegar o frame composto antes do seek.
      if (!primed) {
        primed = true;
        await shot();
        await settlePaint();
      }

      // Quantas capturas consecutivas iguais antes de aceitar o frame.
      // Padrão 1: com software + settle pós-paint + descarte da primeira captura,
      // uma leitura já é estável (medido: 3 comparações de 24 blocos e 2 renders de
      // vídeo real sem divergência). `FRANKFRAMES_CAPTURE_SHOTS=3` religa o modo
      // conservador para investigar hardware ou máquina sob carga.
      const required = Math.min(5, Math.max(1, Number(process.env.FRANKFRAMES_CAPTURE_SHOTS ?? 1) || 1));
      if (required === 1) {
        await settlePaint();
        const single = await shot();
        return { png: single, sha256: createHash("sha256").update(single).digest("hex") };
      }

      let previous = await shot();
      let identical = 0;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await settlePaint();
        const current = await shot();
        identical = current.equals(previous) ? identical + 1 : 0;
        previous = current;
        if (identical >= required - 1) {
          return { png: current, sha256: createHash("sha256").update(current).digest("hex") };
        }
      }
      return { png: previous, sha256: createHash("sha256").update(previous).digest("hex") };
    },
    pageErrors: () => [...pageErrors],
    evaluate: <T,>(expression: string) => page.evaluate(expression) as Promise<T>,
    reload: async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
    },
    gpu,
    renderer: probe?.renderer ?? "ANGLE SwiftShader (software)",
    close: async () => {
      liveBrowsers.delete(browser);
      await browser.close();
    },
  };
}
