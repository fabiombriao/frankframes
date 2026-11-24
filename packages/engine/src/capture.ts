// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createHash } from "node:crypto";
import puppeteer from "puppeteer-core";
import type { Browser, CDPSession, Page } from "puppeteer-core";
import { timeOfFrame } from "@frankframes/contract";
import { chromeArgs } from "./args.ts";
import type { GpuMode, ResolvedGpuMode, Viewport } from "./args.ts";
import { BrowserError } from "./failures.ts";
import { resolveChrome } from "./launch.ts";
import { probeRenderer, resolveGpuMode } from "./probe.ts";
import { browserSignalOptions } from "./signals.ts";
import type { RendererInfo } from "./probe.ts";
import type { ServerFailure, StaticServer } from "./server.ts";

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

/** Limites de espera, em ms. Estourar um deles rejeita com `E_BROWSER_TIMEOUT` em vez de esperar para sempre. */
export interface SessionTimeouts {
  /** Abrir o Chrome. */
  launchMs?: number;
  /** Carregar a página e ficar pronta (fontes, imagens, vídeo fora de banda). */
  readyMs?: number;
  /** Cada seek de frame. */
  seekMs?: number;
  /** Cada captura de frame (inclui as leituras de aquecimento do primeiro). */
  captureMs?: number;
}

export const DEFAULT_SESSION_TIMEOUTS: Required<SessionTimeouts> = {
  launchMs: 60_000,
  readyMs: 120_000,
  seekMs: 60_000,
  captureMs: 120_000,
};

/** Quanto o `close` espera o Chrome sair antes de matar o processo. */
const CLOSE_GRACE_MS = 15_000;

/**
 * Parâmetros do `Page.captureScreenshot` de todo frame. `optimizeForSpeed: true` pede ao Chrome um PNG com
 * compressão mais barata: os pixels são os mesmos (conferido contra os goldens), os bytes são outros e
 * o arquivo fica ~2× maior. O hash por frame é do PNG, então muda junto com este parâmetro.
 */
const SCREENSHOT_PARAMS = { format: "png", captureBeyondViewport: false, optimizeForSpeed: true } as const;

export interface SessionOptions {
  url: string;
  viewport: Viewport;
  gpu: GpuMode;
  executablePath?: string;
  /** Leituras consecutivas idênticas exigidas por frame (padrão 1; verificação usa 3). */
  captureShots?: number;
  timeouts?: SessionTimeouts;
  /** Falhas recentes do servidor que serve a página (`StaticServer.failures`): entram na mensagem de erro. */
  serverFailures?: () => ServerFailure[];
}

export interface Session {
  /** Leva a composição ao tempo exato do frame. Idempotente e fora de ordem. */
  seekFrame: (frame: number, fps: { num: number; den: number }) => Promise<void>;
  /** PNG do frame atual + hash. Em software depende do `seekFrame` anterior ter assentado o paint (uma espera por frame); em hardware espera de novo. */
  capture: () => Promise<{ png: Buffer; sha256: string }>;
  /** Erros de script na página: qualquer um derruba o render. */
  pageErrors: () => string[];
  /** Modo efetivo depois de resolver `auto`. */
  gpu: ResolvedGpuMode;
  /** Renderer real reportado pelo Chrome. */
  renderer: string;
  /** PID do processo do Chrome (o teste que derruba o browser no meio da captura precisa dele). */
  pid: number | undefined;
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

interface Limit {
  label: string;
  ms: number;
  hint: string;
}

/** Execução de uma operação da sessão, vigiada contra queda do browser e contra espera infinita. */
interface Watch {
  guard: <T>(operation: () => Promise<T>, limit?: Limit) => Promise<T>;
  /** Chamado antes de fechar de propósito: a saída do Chrome deixa de contar como queda. */
  release: () => void;
}

/** Resumo das falhas do servidor para a mensagem (sem barra inicial: o caminho não vira "<arquivo>"). */
function describeServerFailures(failures: ServerFailure[]): string {
  const groups = new Map<string, { code: string; path: string; count: number; last: ServerFailure }>();
  for (const failure of failures) {
    const key = `${failure.code}|${failure.path}`;
    const group = groups.get(key);
    groups.set(key, { code: failure.code, path: failure.path, count: (group?.count ?? 0) + 1, last: failure });
  }
  return [...groups.values()]
    .map(({ code, path, count, last }) => {
      const outcome = last.outcome === "failed" ? "sem sucesso" : "leu depois";
      return `${code} ao ler ${path.replace(/^\//, "")} (${count} falha(s), ${outcome})`;
    })
    .join("; ");
}

const annotated = new WeakSet<Error>();

/** Anexa à mensagem o que o servidor registrou: "A network error occurred" passa a dizer "servidor: EBUSY ...". */
function annotateWithServer(error: unknown, failures: ServerFailure[] | undefined): void {
  if (!(error instanceof Error) || annotated.has(error) || failures === undefined || failures.length === 0) return;
  annotated.add(error);
  error.message += ` [servidor: ${describeServerFailures(failures)}]`;
}

function browserClosed(cause?: unknown): BrowserError {
  return new BrowserError(
    "E_BROWSER_CLOSED",
    "o Chrome da captura caiu ou foi encerrado antes de a operação terminar",
    "confira memória livre e antivírus, rode de novo e, se repetir, rode `frankframes doctor`",
    cause === undefined ? undefined : { cause },
  );
}

function watchBrowser(browser: Browser, options: SessionOptions): Watch {
  const closed = Promise.withResolvers<never>();
  // A rejeição chega a quem espera pela corrida em `guard`; sem espera pendente ela não pode ficar solta.
  closed.promise.catch(() => {});
  let released = false;
  let gone: BrowserError | undefined;

  const onGone = (): void => {
    if (released || gone !== undefined) return;
    gone = browserClosed();
    closed.reject(gone);
  };
  browser.on("disconnected", onGone);
  browser.process()?.once("exit", onGone);

  return {
    release: () => {
      released = true;
    },
    guard: async <T,>(operation: () => Promise<T>, limit?: Limit): Promise<T> => {
      if (gone !== undefined) throw gone;
      let timer: NodeJS.Timeout | undefined;
      const work = operation();
      // Se a operação perder a corrida, a falha tardia dela não pode virar rejeição solta.
      work.catch(() => {});
      const pieces: Array<Promise<T>> = [work, closed.promise];
      if (limit !== undefined) {
        pieces.push(
          new Promise<T>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new BrowserError("E_BROWSER_TIMEOUT", `${limit.label} passou de ${limit.ms / 1000} s sem responder`, limit.hint)),
              limit.ms,
            );
          }),
        );
      }
      try {
        return await Promise.race(pieces);
      } catch (error) {
        annotateWithServer(error, options.serverFailures?.());
        // O Chrome morreu e o protocolo rejeitou antes do evento: é a mesma queda.
        if (!(error instanceof BrowserError) && !browser.connected && !released) throw browserClosed(error);
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

/** Mata o processo do Chrome sem esperar por ele (já caiu, ou não fechou no prazo). */
function killBrowserProcess(browser: Browser): void {
  try {
    browser.process()?.kill("SIGKILL");
  } catch {
    /* processo já morto */
  }
}

/** Fecha o Chrome; se ele não sair no prazo, mata o processo. É limpeza: não mascara o erro que a motivou. */
async function closeBrowser(browser: Browser, watch: Watch): Promise<void> {
  liveBrowsers.delete(browser);
  watch.release();
  if (!browser.connected) {
    killBrowserProcess(browser);
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const overdue = new Promise<"overdue">((resolveOverdue) => {
    timer = setTimeout(() => resolveOverdue("overdue"), CLOSE_GRACE_MS);
  });
  try {
    const outcome = await Promise.race([browser.close().then(() => "closed" as const), overdue]);
    if (outcome === "overdue") killBrowserProcess(browser);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function openSession(options: SessionOptions): Promise<Session> {
  const limits = { ...DEFAULT_SESSION_TIMEOUTS, ...options.timeouts };
  const chrome = await resolveChrome(options.executablePath);
  const gpu = await resolveGpuMode(options.gpu, chrome.path);
  const probe = gpu === "hardware" ? await probeRenderer(chrome.path) : undefined;
  let browser: Browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chrome.path,
      headless: true,
      args: chromeArgs({ viewport: options.viewport, gpu }),
      defaultViewport: { ...options.viewport, deviceScaleFactor: 1 },
      timeout: limits.launchMs,
      ...browserSignalOptions(),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new BrowserError(
        "E_BROWSER_TIMEOUT",
        `o Chrome não abriu em ${limits.launchMs / 1000} s`,
        "a máquina está sobrecarregada ou há um Chrome órfão preso: feche processos do Chrome e rode de novo",
        { cause: error },
      );
    }
    throw error;
  }

  trackBrowser(browser);
  const watch = watchBrowser(browser, options);
  try {
    return await startSession(browser, watch, options, limits, gpu, probe);
  } catch (error) {
    await closeBrowser(browser, watch);
    throw error;
  }
}

/**
 * Abre a sessão de uma página servida por `server`. Se a abertura falhar, o servidor é fechado antes
 * de rejeitar (nenhum handle fica aberto e o processo consegue sair) e as falhas dele entram na mensagem.
 */
export async function openSessionFor(
  server: Pick<StaticServer, "close" | "failures">,
  options: Omit<SessionOptions, "serverFailures">,
): Promise<Session> {
  try {
    return await openSession({ ...options, serverFailures: server.failures });
  } catch (error) {
    try {
      await server.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "falha ao abrir a sessão e, depois, ao fechar o servidor");
    }
    throw error;
  }
}

async function startSession(
  browser: Browser,
  watch: Watch,
  options: SessionOptions,
  limits: Required<SessionTimeouts>,
  gpu: ResolvedGpuMode,
  probe: RendererInfo | undefined,
): Promise<Session> {
  const page: Page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  const readyLimit: Limit = {
    label: "a prontidão da página (fontes, imagens e vídeo fora de banda)",
    ms: limits.readyMs,
    hint: "confira se alguma imagem, vídeo ou fonte da página nunca termina de carregar",
  };
  const cdp: CDPSession = await watch.guard(async () => {
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: limits.readyMs + 5_000 });

    const clockReady = await page.evaluate(async () => {
      const clock = (globalThis as unknown as VirtualClockWindow).__ff;
      if (!clock) return "clock-ausente";
      await clock.ready;
      return "ok";
    });
    if (clockReady !== "ok") {
      throw new Error(`relógio virtual não disponível (${clockReady}): o HTML não foi servido pelo engine`);
    }

    await page.evaluate(async () => {
      const scope = globalThis as unknown as { __ffMediaReady?: Promise<boolean> };
      if (scope.__ffMediaReady) await scope.__ffMediaReady;
    });

    // Só com FRANKFRAMES_CAPTURE_PROFILE=1: conta cada espera de paint em `__ff.settleCount`
    // (seek e captura passam por `__ff.settle`). Sem a variável, a página não muda.
    if (process.env.FRANKFRAMES_CAPTURE_PROFILE === "1") {
      const installed = await page.evaluate(() => {
        const clock = (globalThis as unknown as { __ff?: { settle?: () => Promise<boolean>; settleCount?: number } }).__ff;
        if (!clock?.settle) return false;
        const original = clock.settle.bind(clock);
        clock.settleCount = 0;
        clock.settle = () => {
          clock.settleCount = (clock.settleCount ?? 0) + 1;
          return original();
        };
        return true;
      });
      if (!installed) throw new Error("FRANKFRAMES_CAPTURE_PROFILE=1: o relógio da página não expõe settle()");
    }

    const session = await page.createCDPSession();
    // Estado inicial totalmente pintado (fontes, layout) antes de qualquer medição.
    await page.evaluate(async () => {
      const clock = (globalThis as unknown as VirtualClockWindow).__ff;
      await (clock as unknown as { settle?: () => Promise<boolean> })?.settle?.();
    });
    // Primeira captura descartada: força um frame completo antes de qualquer medição.
    await session.send("Page.captureScreenshot", SCREENSHOT_PARAMS);
    return session;
  }, readyLimit);

  const seekHint = "a animação ou um script da página está travando o seek (laço infinito ou promessa que nunca resolve)";
  const captureHint = "o Chrome não devolveu o screenshot: reduza a resolução ou os workers e confira a memória livre";

  let primed = false;

  return {
    seekFrame: (frame, fps) => {
      const ms = timeOfFrame(frame, fps) * 1000;
      return watch.guard(
        () =>
          page.evaluate(async (value) => {
            const clock = (globalThis as unknown as VirtualClockWindow).__ff!;
            await clock.seek(value);
            await (clock as unknown as { settle?: () => Promise<boolean> }).settle?.();
          }, ms),
        { label: `o seek do frame ${frame}`, ms: limits.seekMs, hint: seekHint },
      );
    },
    capture: () =>
      watch.guard(
        async () => {
          const shot = async (): Promise<Buffer> => {
            const { data } = await cdp.send("Page.captureScreenshot", SCREENSHOT_PARAMS);
            return Buffer.from(data, "base64");
          };
          const settlePaint = async (): Promise<void> => {
            await page.evaluate(async () => {
              const clock = (globalThis as unknown as VirtualClockWindow).__ff!;
              await (clock as unknown as { settle?: () => Promise<boolean> }).settle?.();
            });
          };

          // O primeiro frame da sessão é o único que ainda pega estado de aquecimento:
          // exige três leituras iguais. Os demais saem com uma leitura só.
          const first = !primed;
          if (first) {
            primed = true;
            await shot();
            await settlePaint();
          }

          const conservative = Math.min(
            5,
            Math.max(1, options.captureShots ?? (Number(process.env.FRANKFRAMES_CAPTURE_SHOTS) || 1)),
          );
          const required = first ? 3 : conservative;
          if (required === 1) {
            // Software: o seek já assentou o paint (`seekFrame` espera `__ff.settle`), uma espera por frame.
            // Hardware mantém a segunda espera: sem ela os hashes com vários workers pioram (EDT-77).
            if (gpu === "hardware") await settlePaint();
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
        { label: "a captura do frame", ms: limits.captureMs, hint: captureHint },
      ),
    pageErrors: () => [...pageErrors],
    evaluate: <T,>(expression: string) => watch.guard(() => page.evaluate(expression) as Promise<T>),
    reload: () => watch.guard(() => page.reload({ waitUntil: "domcontentloaded" }).then(() => undefined)),
    gpu,
    renderer: probe?.renderer ?? "ANGLE SwiftShader (software)",
    pid: browser.process()?.pid,
    close: () => closeBrowser(browser, watch),
  };
}
