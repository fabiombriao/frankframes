// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Barra de controle do preview: play/pause, loop, scrub por frame e instante na URL.
 * Só é injetada quando o servidor está em modo `preview`; nunca no render.
 */
export const PREVIEW_UI_SOURCE = `(() => {
  const meta = window.__ffPreviewMeta || { fps: { num: 30, den: 1 }, frames: 90 };
  const fps = meta.fps.num / meta.fps.den;
  const total = Math.max(1, meta.frames);
  // Instante e loop salvos são por composição: abrir outro arquivo não pode herdar o estado.
  const storageKey = "__ffTime:" + (meta.id || "preview");
  const loopKey = "__ffLoop:" + (meta.id || "preview");
  const durationMs = (total / fps) * 1000;
  const frameMs = (frame) => (frame * 1000 * meta.fps.den) / meta.fps.num;
  // O relógio termina no início do último frame, nunca em durationMs.
  const lastMs = Math.max(0, durationMs - frameMs(1));
  const clampMs = (value) => Math.min(Math.max(0, value), lastMs);

  let loop = false;
  try {
    loop = sessionStorage.getItem(loopKey) === "1";
  } catch {}
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
  range.style.cssText = "flex:1;accent-color:#ff2d55";

  const label = document.createElement("span");
  label.setAttribute("data-ff-time", "");
  label.textContent = "0/" + (total - 1);

  bar.append(play, loopButton, range, label);
  document.documentElement.appendChild(bar);

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
    history.replaceState(null, "", "#f=" + frame);
    paint();
  };

  play.addEventListener("click", () => {
    if (window.__ff.playing()) {
      window.__ff.stopLive();
      return;
    }
    // No fim, Play recomeça do início em vez de ficar parado no último frame.
    if (window.__ff.now() >= lastMs - 0.5) window.__ff.seek(0);
    window.__ff.startLive(window.__ff.now());
  });

  loopButton.addEventListener("click", () => {
    loop = !loop;
    try {
      sessionStorage.setItem(loopKey, loop ? "1" : "0");
    } catch {}
    applyBounds();
    paintLoop();
  });

  range.addEventListener("input", () => {
    goToFrame(Number(range.value));
  });

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
    } catch {}
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
  window.addEventListener("pagehide", () => {
    try {
      sessionStorage.setItem(storageKey, persistValue());
    } catch {}
  });

  const fromHash = /#f=(\\d+)/.exec(location.hash);
  const fromSession = clampMs(Number(sessionStorage.getItem(storageKey) || 0));
  if (fromHash) {
    goToFrame(Math.min(total - 1, Math.max(0, Number(fromHash[1]))));
    paint();
  } else {
    window.__ff.startLive(fromSession);
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
