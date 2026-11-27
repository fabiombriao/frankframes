// FrankFrames — proprietário. Ver LICENSE na raiz.
import { frameFromPointer, initialTransport } from "./preview-logic.ts";

/**
 * Barra de controle do preview: play/pause, loop, scrub por frame e instante na URL.
 * Só é injetada quando o servidor está em modo `preview`; nunca no render.
 * As contas do scrub e do estado inicial vêm de `preview-logic.ts` (testadas no Node) e entram pelo `toString()`.
 */
export const PREVIEW_UI_SOURCE = `(() => {
  const frameFromPointer = ${frameFromPointer.toString()};
  const initialTransport = ${initialTransport.toString()};
  const meta = window.__ffPreviewMeta || { fps: { num: 30, den: 1 }, frames: 90 };
  const fps = meta.fps.num / meta.fps.den;
  const total = Math.max(1, meta.frames);
  // Instante e loop salvos são por composição: abrir outro arquivo não pode herdar o estado.
  const storageKey = "__ffTime:" + (meta.id || "preview");
  const loopKey = "__ffLoop:" + (meta.id || "preview");
  const playingKey = "__ffPlaying:" + (meta.id || "preview");
  const durationMs = (total / fps) * 1000;
  const frameMs = (frame) => (frame * 1000 * meta.fps.den) / meta.fps.num;
  // O relógio termina no início do último frame, nunca em durationMs.
  const lastMs = Math.max(0, durationMs - frameMs(1));
  const clampMs = (value) => Math.min(Math.max(0, value), lastMs);

  // sessionStorage pode estar bloqueado: o erro aparece em liveErrors (uma vez), nunca some.
  let storageReported = false;
  const storageFailed = (error) => {
    if (storageReported) return;
    storageReported = true;
    window.__ff.liveErrors.push("sessionStorage: " + String(error && error.message ? error.message : error));
  };

  let loop = false;
  try {
    loop = sessionStorage.getItem(loopKey) === "1";
  } catch (error) {
    storageFailed(error);
  }
  const applyBounds = () => window.__ff.setLiveBounds({ endMs: durationMs, frameMs: frameMs(1), loop });
  applyBounds();

  const bar = document.createElement("div");
  bar.setAttribute("data-ff-ui", "");
  bar.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;height:42px;display:flex;gap:10px;align-items:center;" +
    "padding:0 12px;background:rgba(17,17,17,.82);color:#fff;font:13px/1 ui-monospace,monospace;" +
    "z-index:2147483647;backdrop-filter:blur(6px)";

  const buttonCss = "height:26px;border:0;border-radius:6px;cursor:pointer;font:600 12px system-ui;";
  const play = document.createElement("button");
  play.setAttribute("data-ff-play", "");
  play.textContent = "pause";
  play.style.cssText = buttonCss + "min-width:56px;background:#fff;color:#111";

  const loopButton = document.createElement("button");
  loopButton.setAttribute("data-ff-loop", "");
  loopButton.textContent = "⟳ Loop";
  const paintLoop = () => {
    loopButton.setAttribute("aria-pressed", String(loop));
    loopButton.style.cssText = buttonCss + "padding:0 10px;" + (loop ? "background:#ff2d55;color:#fff" : "background:#fff;color:#111");
  };
  paintLoop();

  const range = document.createElement("input");
  range.type = "range";
  range.min = "0";
  range.max = String(total - 1);
  range.value = "0";
  range.setAttribute("data-ff-scrub", "");
  range.style.cssText = "flex:1;accent-color:#ff2d55;touch-action:none";

  const label = document.createElement("span");
  label.setAttribute("data-ff-time", "");
  label.textContent = "0/" + (total - 1);

  // Estado do áudio do preview (vazio quando está tudo bem): o runtime de áudio o preenche.
  const audioStatus = document.createElement("button");
  audioStatus.setAttribute("data-ff-audio-status", "");
  audioStatus.hidden = true;
  audioStatus.style.cssText = buttonCss + "padding:0 10px;max-width:40vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#ffd60a;color:#111";

  bar.append(play, loopButton, range, audioStatus, label);
  document.documentElement.appendChild(bar);
  if (window.__ffAudioPaint) window.__ffAudioPaint();

  const paint = () => {
    const ms = window.__ff.now();
    const frame = Math.min(total - 1, Math.max(0, Math.round((ms * fps) / 1000)));
    range.value = String(frame);
    label.textContent = frame + "/" + (total - 1) + " · " + (ms / 1000).toFixed(2) + "s";
  };

  const paintPlay = () => {
    play.textContent = window.__ff.playing() ? "pause" : "play";
  };

  const goToFrame = (frame) => {
    const ms = clampMs(frameMs(frame));
    window.__ff.stopLive();
    window.__ff.seek(ms);
    // Caminho absoluto: um "#f=" relativo resolveria contra o <base href> do Studio e o reload cairia em /__ff_site/.
    history.replaceState(null, "", location.pathname + location.search + "#f=" + frame);
    paint();
  };

  const togglePlay = () => {
    if (window.__ff.playing()) {
      window.__ff.stopLive();
      return;
    }
    // No fim, Play recomeça do início em vez de ficar parado no último frame.
    if (window.__ff.now() >= lastMs - 0.5) window.__ff.seek(0);
    window.__ff.startLive(window.__ff.now());
  };
  play.addEventListener("click", togglePlay);
  if (meta.clickToToggle) {
    document.addEventListener("click", (event) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      if (event.target.closest("[data-ff-ui],a,button,input,textarea,select,label,[contenteditable],video[controls]")) return;
      if (document.getSelection()?.type === "Range") return;
      togglePlay();
    });
  }

  loopButton.addEventListener("click", () => {
    loop = !loop;
    try {
      sessionStorage.setItem(loopKey, loop ? "1" : "0");
    } catch (error) {
      storageFailed(error);
    }
    applyBounds();
    paintLoop();
  });

  // Teclado (setas, Home, End) segue o controle nativo; o ponteiro usa a conta própria, com as pontas em 0 e no último frame.
  let scrubbing = false;
  range.addEventListener("input", () => {
    if (scrubbing) return;
    goToFrame(Number(range.value));
  });
  const scrubTo = (event) => {
    const box = range.getBoundingClientRect();
    const frame = frameFromPointer(event.clientX, box.left, box.width, total);
    range.value = String(frame);
    goToFrame(frame);
  };
  range.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    // Cancelar o pointerdown impede o arrasto nativo, que mapearia o ponteiro pela trilha encurtada pelo polegar.
    event.preventDefault();
    range.focus();
    scrubbing = true;
    scrubTo(event);
  });
  document.addEventListener("pointermove", (event) => {
    if (scrubbing) scrubTo(event);
  });
  const endScrub = () => {
    scrubbing = false;
  };
  document.addEventListener("pointerup", endScrub);
  document.addEventListener("pointercancel", endScrub);

  // Instante salvo por composição, e sempre dentro da duração: abrir outro
  // arquivo (ou um arquivo mais curto) não pode herdar um tempo inválido.
  let lastPersist = -Infinity;
  const persistValue = () => String(Math.round(Math.min(window.__ff.now(), lastMs)));
  const persist = (force) => {
    const now = window.__ff.now();
    // Em loop o relógio volta: a distância precisa ser absoluta.
    if (!force && Math.abs(now - lastPersist) < 250) return;
    lastPersist = now;
    try {
      sessionStorage.setItem(storageKey, persistValue());
    } catch (error) {
      storageFailed(error);
    }
  };

  window.__ff.liveHooks.push(paint);
  window.__ff.liveHooks.push(() => persist(false));
  window.__ff.transportHooks.push((event) => {
    paintPlay();
    if (event.type === "end") {
      paint();
      persist(true);
    }
  });
  // Estado de transporte (tocando ou parado) guardado junto do instante: recarregar o preview depois de
  // uma edição não pode religar o play, senão o relógio corre até o fim e o instante parado se perde.
  const writePlaying = () => {
    try {
      sessionStorage.setItem(playingKey, window.__ff.playing() ? "1" : "0");
    } catch (error) {
      storageFailed(error);
    }
  };
  window.__ff.transportHooks.push(writePlaying);
  window.addEventListener("pagehide", () => {
    try {
      sessionStorage.setItem(storageKey, persistValue());
    } catch (error) {
      storageFailed(error);
    }
    writePlaying();
  });

  // Leitura do estado salvo. Valor ausente é normal (primeira abertura); valor inválido ou storage
  // bloqueado vira erro visível em liveErrors, nunca um zero silencioso.
  let savedMs = null;
  let savedPlaying = null;
  try {
    const rawTime = sessionStorage.getItem(storageKey);
    if (rawTime !== null) {
      const parsed = Number(rawTime);
      if (rawTime.trim() === "" || !Number.isFinite(parsed)) {
        window.__ff.liveErrors.push("sessionStorage: instante salvo inválido em " + storageKey + ": " + rawTime);
      } else {
        savedMs = clampMs(parsed);
      }
    }
    const rawPlaying = sessionStorage.getItem(playingKey);
    if (rawPlaying === "1" || rawPlaying === "0") savedPlaying = rawPlaying === "1";
    else if (rawPlaying !== null) window.__ff.liveErrors.push("sessionStorage: estado de play inválido em " + playingKey + ": " + rawPlaying);
  } catch (error) {
    storageFailed(error);
  }

  // Recarga (F5, edição no Studio): o instante guardado vale mais que o "#f=" da URL, que só reflete o
  // último scrub feito na barra e ficaria velho depois de um seek vindo de fora.
  const navigation = performance.getEntriesByType("navigation")[0];
  const isReload = navigation !== undefined && navigation.type === "reload";
  const fromHash = /#f=(\\d+)/.exec(location.hash);
  if (fromHash && !(isReload && savedMs !== null)) {
    goToFrame(Math.min(total - 1, Math.max(0, Number(fromHash[1]))));
    paint();
  } else {
    // Preview avulso abre tocando; o Studio (autoplay false) abre pausado no 0 e só a recarga restaura o estado.
    const entry = initialTransport({ savedMs, savedPlaying, isReload, autoplay: meta.autoplay !== false });
    if (entry.playing) {
      window.__ff.startLive(entry.ms);
    } else {
      window.__ff.stopLive();
      window.__ff.seek(entry.ms);
    }
    paint();
  }
  paintPlay();

})();`;

/**
 * Recarga por SSE do servidor de preview. Fica fora da barra para a injeção poder
 * omiti-la: o Studio recarrega pelo próprio `/api/events` e não tem `/__ff_reload`.
 */
export const PREVIEW_RELOAD_SOURCE = `(() => {
  const events = new EventSource("/__ff_reload");
  events.onmessage = () => location.reload();
})();`;
