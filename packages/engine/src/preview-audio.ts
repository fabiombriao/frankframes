// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Áudio do preview: toca o mix que o servidor fez com o mesmo grafo do render
 * (`window.__ffPreviewAudio = { src } | { error } | { disabled }`) e o mantém
 * sincronizado com o relógio ao vivo. Roda no `<head>`, depois do relógio e antes
 * da barra: os hooks precisam existir antes do primeiro `startLive`.
 *
 * Os temporizadores da página são virtuais (só andam com o relógio), então a
 * correção de deriva pega carona nos `liveHooks`, nunca em setInterval.
 */
export const PREVIEW_AUDIO_SOURCE = `(() => {
  const ff = window.__ff;
  const config = window.__ffPreviewAudio;
  if (!ff || !config) return;

  const LEAD_S = 0.05; // folga para agendar o nó sem estourar o relógio de áudio
  const CHECK_MS = 250; // intervalo entre medições de deriva

  const state = { status: "none", driftMs: 0, checks: 0, error: undefined };
  let ctx = null;
  let buffer = null;
  let source = null;
  let anchor = null; // { ctxT0, ms0 }: o áudio está em ms0 no instante ctxT0 do AudioContext
  let lastCheck = -Infinity;

  const frameMs = () => {
    const meta = window.__ffPreviewMeta;
    return meta ? (1000 * meta.fps.den) / meta.fps.num : 1000 / 30;
  };
  const latencyMs = () => (ctx && ctx.outputLatency ? ctx.outputLatency * 1000 : 0);

  const label = () => {
    if (state.status === "error") return state.error;
    if (state.status === "disabled") return config.disabled;
    if (state.status === "loading") return "Carregando áudio…";
    if (state.status === "suspended") return "Som bloqueado — clique para ativar";
    return "";
  };
  // O elemento nasce na barra (DOMContentLoaded) depois deste script: a barra chama
  // __ffAudioPaint ao montá-lo, e cada mudança de estado repinta.
  const paint = () => {
    const element = document.querySelector("[data-ff-audio-status]");
    if (!element) return;
    const text = label() || "";
    element.textContent = text;
    element.title = text;
    element.hidden = text === "";
    element.setAttribute("data-state", state.status);
    const failed = state.status === "error";
    element.style.background = failed ? "#ff453a" : "#ffd60a";
    element.style.color = failed ? "#fff" : "#111";
  };
  window.__ffAudioPaint = paint;

  const fail = (text) => {
    state.status = "error";
    state.error = text;
    ff.liveErrors.push("audio: " + text);
    paint();
  };

  const stopSource = () => {
    if (source !== null) {
      source.onended = null;
      source.stop();
      source.disconnect();
      source = null;
    }
    anchor = null;
  };

  const startAt = (ms) => {
    stopSource();
    if (buffer === null || ctx.state !== "running") return;
    // O nó começa LEAD_S depois de agora e só é ouvido outputLatency depois disso:
    // o ponto de partida já adianta os dois, senão o som nasceria atrasado.
    const offsetMs = ms + LEAD_S * 1000 + latencyMs();
    if (offsetMs / 1000 >= buffer.duration) return; // já passou do fim do mix
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const when = ctx.currentTime + LEAD_S;
    node.start(when, offsetMs / 1000);
    node.onended = () => {
      if (source === node) source = null;
    };
    source = node;
    anchor = { ctxT0: when, ms0: offsetMs };
    lastCheck = ms;
  };

  // Posição que o ouvinte escuta agora, no eixo do relógio do preview.
  const audioMs = () => anchor.ms0 + ctx.currentTime * 1000 - latencyMs() - anchor.ctxT0 * 1000;

  const syncState = () => {
    if (buffer === null || state.status === "error") return;
    const wasRunning = state.status === "ready";
    if (ctx.state === "running") {
      state.status = "ready";
      if (!wasRunning && ff.playing()) startAt(ff.now());
    } else {
      state.status = ff.playing() ? "suspended" : "ready";
    }
    paint();
  };

  // Navegadores reais deixam o contexto suspenso até um gesto do usuário.
  const wake = () => {
    if (ctx === null || ctx.state === "running") return;
    ctx.resume().catch((error) => fail("E_PREVIEW_AUDIO: " + (error && error.message ? error.message : error)));
  };

  const silenceNative = () => {
    for (const element of document.querySelectorAll("audio, video")) {
      element.muted = true;
      element.pause();
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    silenceNative();
    paint();
  });
  window.addEventListener("load", silenceNative);
  document.addEventListener("pointerdown", wake, true);
  document.addEventListener("keydown", wake, true);

  ff.audioState = () => ({
    status: state.status,
    playing: source !== null,
    driftMs: state.driftMs,
    checks: state.checks,
    ...(state.error !== undefined ? { error: state.error } : {}),
  });

  ff.liveHooks.push((nowMs) => {
    if (source === null || anchor === null) return;
    if (Math.abs(nowMs - lastCheck) < CHECK_MS) return; // abs: em loop o relógio volta
    lastCheck = nowMs;
    const drift = audioMs() - nowMs;
    state.driftMs = drift;
    state.checks += 1;
    if (Math.abs(drift) > frameMs() / 2) startAt(nowMs);
  });

  ff.transportHooks.push((event) => {
    if (buffer === null) return;
    if (event.type === "start" || event.type === "loop") {
      wake();
      syncState();
      startAt(event.ms);
    } else if (event.type === "seek") {
      if (ff.playing()) startAt(event.ms);
      else stopSource();
    } else {
      stopSource(); // stop, end
    }
  });

  if (config.error !== undefined) {
    fail(config.error);
    return;
  }
  if (config.disabled !== undefined) {
    state.status = "disabled";
    paint();
    return;
  }

  const load = async () => {
    state.status = "loading";
    paint();
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error("este navegador não tem Web Audio");
    const response = await fetch(config.src);
    if (!response.ok) throw new Error("HTTP " + response.status + " ao baixar o mix do preview");
    const bytes = await response.arrayBuffer();
    ctx = new Context();
    ctx.addEventListener("statechange", syncState);
    buffer = await ctx.decodeAudioData(bytes);
    state.status = "ready";
    syncState();
    if (ff.playing()) {
      wake();
      startAt(ff.now());
    }
  };
  load().catch((error) => fail("E_PREVIEW_AUDIO: " + (error && error.message ? error.message : error)));
})();`;
