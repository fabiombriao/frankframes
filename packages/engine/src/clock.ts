// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Relógio virtual. Roda DENTRO da página, antes de qualquer script da composição.
 *
 * Regras que este arquivo garante (docs/contract.md §9):
 *  - Date, performance.now, rAF, timers, Math.random e crypto são do host;
 *  - nada avança entre seeks;
 *  - exatamente UMA geração de rAF por frame;
 *  - PRNG re-semeado por frame a partir do tempo.
 *
 * O código é uma string de propósito: é injetado inline no HTML servido, sem
 * caminho de arquivo para errar.
 */
export const CLOCK_SOURCE = `(() => {
  let nowMs = 0;
  let seed = 0x9e3779b1 >>> 0;

  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const realNow = performance.now.bind(performance);
  const realRaf = window.requestAnimationFrame.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  const RealDate = Date;
  class VirtualDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(nowMs);
      else super(...args);
    }
    static now() { return nowMs; }
  }
  window.Date = VirtualDate;
  Object.defineProperty(performance, "now", { value: () => nowMs, configurable: true, writable: true });

  const frameQueue = [];
  window.requestAnimationFrame = (cb) => { frameQueue.push(cb); return frameQueue.length; };
  window.cancelAnimationFrame = () => {};

  const timers = [];
  let timerSeq = 0;
  window.setTimeout = (fn, ms = 0, ...args) => {
    timers.push({ id: ++timerSeq, fn, args, due: nowMs + Math.max(ms, 1) });
    return timerSeq;
  };
  window.setInterval = (fn, ms = 0, ...args) => {
    timers.push({ id: ++timerSeq, fn, args, due: nowMs + Math.max(ms, 1), every: Math.max(ms, 1) });
    return timerSeq;
  };
  window.clearTimeout = window.clearInterval = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  window.queueMicrotask = (fn) => Promise.resolve().then(fn);

  Math.random = random;
  if (window.crypto) {
    crypto.getRandomValues = (arr) => {
      for (let i = 0; i < arr.length; i++) arr[i] = (random() * 256) | 0;
      return arr;
    };
  }

  const scopeStart = (element) => {
    let node = element;
    while (node && node.nodeType === 1) {
      const value = node.getAttribute("data-ff-comp-start");
      if (value !== null) return Number(value);
      node = node.parentNode;
    }
    return 0;
  };

  // Ganchos de preparação (motion): rodam uma vez, com o DOM completo, antes de a
  // prontidão contar fontes e imagens. Falha de um gancho rejeita "ready", e o
  // render para com a mensagem dele. Registrado depois do DOM pronto, roda na hora.
  const prepareHooks = [];
  let prepared = false;
  const prepare = (hook) => {
    if (prepared) hook();
    else prepareHooks.push(hook);
  };

  // O script roda no <head>: document.images só existe depois do parse.
  // Prontidão = DOM completo + fontes + toda imagem decodificada.
  const readyDeferred = Promise.withResolvers();
  const ready = readyDeferred.promise;
  const settle = () => {
    prepared = true;
    try {
      for (const hook of prepareHooks) hook();
      // Congela as animações no tempo 0 JÁ, antes de esperar fontes e imagens. Sem
      // isso elas rodam em tempo real até o primeiro seek: quanto tempo passou (carga
      // da máquina) decide quais já terminaram e quais ficam promovidas a camada do
      // compositor, e o raster do texto muda de 1 px entre uma execução e outra.
      syncAnimations();
    } catch (error) {
      readyDeferred.reject(error);
      return;
    }
    // Carrega TODA face declarada: texto que só aparece no meio do clip não pode
    // trocar de fonte durante a captura. Face que não carrega é falha (E_FONT_LOAD):
    // sem isso o texto sairia na fonte de reserva, sem aviso. Vale também para a face
    // que nenhum elemento usa, porque o contrato é "toda face declarada carrega".
    const fontFailures = [];
    const faces = document.fonts
      ? [...document.fonts].map((face) =>
          face.load().catch((error) => {
            fontFailures.push(
              face.family + " (peso " + face.weight + ", estilo " + face.style + "): " + (error && error.message ? error.message : String(error)),
            );
          }),
        )
      : [];
    Promise.all([
      ...faces,
      document.fonts ? document.fonts.ready : Promise.resolve(),
      ...[...document.images].map((img) =>
        img.decode
          ? img.decode().catch(() => {
              throw new Error("imagem não decodificou: " + (img.currentSrc || img.src));
            })
          : Promise.resolve(),
      ),
    ])
      .then(() => {
        if (fontFailures.length > 0) {
          throw new Error(
            "E_FONT_LOAD: fonte declarada não carregou: " + fontFailures.join("; ") +
              " (confira o src do @font-face, caminho e arquivo, ou a fonte em vendor/fonts)",
          );
        }
      })
      .then(
        () => readyDeferred.resolve(true),
        (error) => readyDeferred.reject(error),
      );
  };
  const syncAnimations = () => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      const target = animation.effect ? animation.effect.target : null;
      animation.currentTime = Math.max(0, nowMs - scopeStart(target));
    }
  };

  // Depois de syncAnimations: settle() a chama na hora quando o DOM já está pronto.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", settle, { once: true });
  else settle();

  const syncVisibility = () => {
    for (const element of document.querySelectorAll("[data-ff-start]")) {
      const start = Number(element.getAttribute("data-ff-start"));
      const rawEnd = element.getAttribute("data-ff-end");
      const end = rawEnd === null ? Infinity : Number(rawEnd);
      element.style.visibility = nowMs >= start && nowMs < end ? "" : "hidden";
    }
  };

  const liveHooks = [];
  const liveErrors = [];
  // Eventos de transporte: { type: "start" | "stop" | "seek" | "end" | "loop", ms }.
  const transportHooks = [];
  let liveHandle = null;

  let liveToken = 0;

  // Limites do relógio ao vivo. Sem chamada a setLiveBounds, o relógio é ilimitado.
  let bounds = null;
  const setLiveBounds = (next) => {
    const endMs = Number(next.endMs);
    const frameMs = Number(next.frameMs);
    bounds = { endMs, frameMs, lastFrameMs: Math.max(0, endMs - frameMs), loop: next.loop === true };
  };
  // Sem limites o valor passa intacto (render e relógio ao vivo sem barra).
  const clampLive = (ms) => (bounds === null ? ms : Math.min(Math.max(0, ms), bounds.lastFrameMs));

  const emit = (type, ms) => {
    for (const hook of transportHooks) {
      try {
        hook({ type, ms });
      } catch (error) {
        liveErrors.push(String(error && error.message ? error.message : error));
      }
    }
  };

  const stopLive = () => {
    const wasPlaying = liveHandle !== null;
    liveToken += 1;
    liveHandle = null;
    if (wasPlaying) emit("stop", nowMs);
  };

  // O instante guardado nunca passa do último frame, mesmo na folga entre ele e o fim.
  // Falha ao gravar vai para liveErrors (uma vez só: o tick chama isto a cada 250 ms).
  let persistFailed = false;
  const persistNow = () => {
    try {
      sessionStorage.setItem("__ffTime", String(Math.round(bounds === null ? nowMs : Math.min(nowMs, bounds.lastFrameMs))));
    } catch (error) {
      if (persistFailed) return;
      persistFailed = true;
      liveErrors.push("sessionStorage: " + String(error && error.message ? error.message : error));
    }
  };

  let persistOnHide = false;
  const startLive = (requestedMs) => {
    if (liveHandle !== null) return;
    const startAtMs = clampLive(requestedMs || 0);
    const token = ++liveToken;
    if (!persistOnHide) {
      persistOnHide = true;
      // Recarregar/navegar precisa gravar o instante exato, não o último tick periódico.
      window.addEventListener("pagehide", persistNow);
      window.addEventListener("visibilitychange", persistNow);
    }
    let base = realNow() - startAtMs;
    let lastPersist = 0;
    // Primeiro passe é síncrono: nada de mostrar o estado errado antes do primeiro rAF.
    nowMs = realNow() - base;
    syncAnimations();
    syncVisibility();
    liveHandle = 0; // marca "tocando" antes do evento, para playing() já valer nos hooks
    emit("start", nowMs);
    if (token !== liveToken) return; // um hook de "start" parou o relógio
    const tick = () => {
      if (token !== liveToken) return;
      let t = realNow() - base;
      let ended = false;
      let looped = false;
      if (bounds !== null && t >= bounds.endMs) {
        if (bounds.loop) {
          t = t % bounds.endMs;
          base = realNow() - t;
          lastPersist = 0;
          looped = true;
        } else {
          t = bounds.lastFrameMs;
          ended = true;
        }
      }
      nowMs = t;
      try {
        syncAnimations();
        syncVisibility();
        for (const hook of liveHooks) hook(nowMs);
      } catch (error) {
        liveErrors.push(String(error && error.message ? error.message : error));
      }
      if (ended) {
        persistNow();
        stopLive();
        emit("end", nowMs);
        return;
      }
      if (looped) emit("loop", nowMs);
      if (nowMs - lastPersist > 250) {
        lastPersist = nowMs;
        persistNow();
      }
      liveHandle = realRaf(tick);
    };
    liveHandle = realRaf(tick);
  };

  // Dois frames reais de compositor, com teto de tempo: garante que o paint do
  // seek atual já subiu antes do screenshot.
  const settlePaint = () =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(true);
      };
      // rAF roda ANTES do paint: o setTimeout depois do segundo rAF cai após ele.
      realRaf(() => realRaf(() => realSetTimeout(finish, 0)));
      realSetTimeout(finish, 80);
    });

  window.__ff = {
    ready,
    prepare,
    settle: settlePaint,
    syncVisibility,
    syncAnimations,
    startLive,
    stopLive,
    setLiveBounds,
    playing: () => liveHandle !== null,
    transportHooks,
    liveHooks,
    liveErrors,
    now: () => nowMs,
    seek(requestedMs) {
      const ms = clampLive(requestedMs);
      nowMs = ms;
      seed = (0x9e3779b1 ^ (Math.trunc(ms) + 1)) >>> 0;
      for (const timer of [...timers]) {
        if (timer.every === undefined) {
          if (timer.due <= nowMs) timer.fn(...timer.args);
        } else {
          let guard = 0;
          while (timer.due <= nowMs && guard++ < 1000) {
            timer.fn(...timer.args);
            timer.due += timer.every;
          }
        }
      }
      for (let i = timers.length - 1; i >= 0; i--) {
        if (timers[i].every === undefined && timers[i].due <= nowMs) timers.splice(i, 1);
      }
      const generation = frameQueue.splice(0, frameQueue.length);
      for (const cb of generation) cb(nowMs);
      syncAnimations();
      syncVisibility();
      emit("seek", nowMs);
      return nowMs;
    },
  };
})();`;

/**
 * Injeta o relógio como PRIMEIRO script do documento — antes de qualquer script
 * da composição, inclusive os do `<head>`.
 */
export function injectClock(html: string): string {
  const tag = `<script>${CLOCK_SOURCE}</script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${tag}${html.slice(at)}`;
  }
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return `${html.slice(0, at)}${tag}${html.slice(at)}`;
  }
  return `${tag}${html}`;
}
