// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Barra de controle do preview: play/pause, scrub por frame e instante na URL.
 * Só é injetada quando o servidor está em modo `preview`; nunca no render.
 */
export const PREVIEW_UI_SOURCE = `(() => {
  const meta = window.__ffPreviewMeta || { fps: { num: 30, den: 1 }, frames: 90 };
  const fps = meta.fps.num / meta.fps.den;
  const total = Math.max(1, meta.frames);
  const frameMs = (frame) => (frame * 1000 * meta.fps.den) / meta.fps.num;

  const bar = document.createElement("div");
  bar.setAttribute("data-ff-ui", "");
  bar.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;height:42px;display:flex;gap:10px;align-items:center;" +
    "padding:0 12px;background:rgba(17,17,17,.82);color:#fff;font:13px/1 ui-monospace,monospace;" +
    "z-index:2147483647;backdrop-filter:blur(6px)";

  const play = document.createElement("button");
  play.setAttribute("data-ff-play", "");
  play.textContent = "pause";
  play.style.cssText = "min-width:56px;height:26px;border:0;border-radius:6px;background:#fff;color:#111;cursor:pointer;font:600 12px system-ui";

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

  bar.append(play, range, label);
  document.documentElement.appendChild(bar);

  let paused = false;
  const paint = () => {
    const ms = window.__ff.now();
    const frame = Math.min(total - 1, Math.max(0, Math.round((ms * fps) / 1000)));
    range.value = String(frame);
    label.textContent = frame + "/" + (total - 1) + " · " + (ms / 1000).toFixed(2) + "s";
  };

  const goToFrame = (frame) => {
    const ms = frameMs(frame);
    window.__ff.stopLive();
    window.__ff.seek(ms);
    history.replaceState(null, "", "#f=" + frame);
    paint();
  };

  play.addEventListener("click", () => {
    paused = !paused;
    play.textContent = paused ? "play" : "pause";
    if (paused) window.__ff.stopLive();
    else window.__ff.startLive(window.__ff.now());
  });

  range.addEventListener("input", () => {
    paused = true;
    play.textContent = "play";
    goToFrame(Number(range.value));
  });

  window.__ff.liveHooks.push(paint);

  const fromHash = /#f=(\\d+)/.exec(location.hash);
  const fromSession = Number(sessionStorage.getItem("__ffTime") || 0);
  if (fromHash) {
    goToFrame(Number(fromHash[1]));
    paint();
  } else {
    window.__ff.startLive(fromSession || 0);
    paint();
  }

  const events = new EventSource("/__ff_reload");
  events.onmessage = () => location.reload();
})();`;
