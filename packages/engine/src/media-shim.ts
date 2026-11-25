// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Substitui `<video>` por `<img>` servido pelo host. O Chrome nunca decodifica
 * vídeo durante a captura — é a maior fonte de não-determinismo depois do relógio.
 *
 * O swap é preguiçoso: acontece no primeiro seek, quando fontes e layout já
 * assentaram. Cada troca de frame espera `img.decode()`, então o screenshot
 * nunca pega um frame meio decodificado.
 *
 * A <img> herda `object-fit`/`object-position` computados do vídeo e leva o motion dele
 * (`data-ff-motion`, `data-ff-comp-start`): enter/exit/emphasis e a câmera animam a <img>.
 * Limite: a <img> é `position:fixed`, então motion num ANCESTRAL do vídeo não a move.
 */
export const MEDIA_SHIM_SOURCE = `(() => {
  const manifest = window.__ffMedia;
  if (!manifest || !manifest.clips || manifest.clips.length === 0) {
    window.__ffMediaReady = Promise.resolve(false);
    return;
  }
  const fps = manifest.fps.num / manifest.fps.den;
  // Quem o shim vai trocar: o runtime do motion confere antes de aceitar motion num <video>.
  window.__ffMediaShim = new Set(manifest.clips.map((clip) => clip.clipId));
  const entries = [];
  let swapped = false;
  // <img> com decode() em andamento: se o seek estourar o prazo, a sonda da sessão lista estas.
  const decoding = new Set();
  window.__ff.decoding = decoding;

  const swap = () => {
    for (const clip of manifest.clips) {
      const video = [...document.querySelectorAll("video")].find(
        (element) => element.getAttribute("data-clip-id") === clip.clipId,
      );
      if (!video) continue;
      const box = video.getBoundingClientRect();
      const style = getComputedStyle(video);
      const img = document.createElement("img");
      img.src = "/__ff_media/" + clip.dir + "/000000.jpg";
      img.setAttribute("data-ff-media", clip.clipId);
      // A <img> substituta precisa participar da mesma janela de visibilidade.
      for (const attribute of ["data-ff-start", "data-ff-end", "data-ff-comp-start", "data-ff-motion"]) {
        const value = video.getAttribute(attribute);
        if (value !== null) img.setAttribute(attribute, value);
      }
      img.style.cssText =
        "position:fixed;left:" + box.left + "px;top:" + box.top + "px;width:" + box.width + "px;height:" +
        box.height + "px;object-fit:" + style.objectFit + ";object-position:" + style.objectPosition + ";display:block;";
      video.parentNode.insertBefore(img, video.nextSibling);
      video.style.display = "none";
      if (img.hasAttribute("data-ff-motion")) {
        if (!window.__ffMotion) {
          throw new Error("E_MOTION_TARGET: o runtime do motion não está na página; o movimento do <video> " + clip.clipId + " não pode ser aplicado");
        }
        window.__ffMotion.attach(img);
      }
      entries.push({ clip, img, lastFrame: -1 });
    }
  };

  const apply = async (ms) => {
    if (!swapped) {
      swapped = true;
      swap();
      // A <img> acabou de nascer: precisa da mesma visibilidade e do mesmo instante de animação deste frame.
      window.__ff.stage("syncAnimations");
      window.__ff.syncAnimations();
      window.__ff.syncVisibility();
    }
    const seconds = ms / 1000;
    const pending = [];
    const requested = [];
    for (const entry of entries) {
      const raw = Math.floor((seconds - entry.clip.start) * entry.clip.playbackRate * fps);
      const frame = Math.max(0, Math.min(entry.clip.frameCount - 1, raw));
      if (frame === entry.lastFrame) continue;
      entry.lastFrame = frame;
      entry.img.src = "/__ff_media/" + entry.clip.dir + "/" + String(frame).padStart(6, "0") + ".jpg";
      const img = entry.img;
      decoding.add(img);
      requested.push(img.src);
      pending.push(
        img.decode().then(
          () => {
            decoding.delete(img);
          },
          () => {
            decoding.delete(img);
            throw new Error("frame de mídia não carregou: " + img.src);
          },
        ),
      );
    }
    // As URLs vão junto: se a página parar de responder à sonda, o erro ainda diz o que este seek pediu.
    if (pending.length > 0) window.__ff.stage(["video-frame-decode", ...requested].join(" "));
    await Promise.all(pending);
  };

  if (window.__ff.liveHooks) window.__ff.liveHooks.push((ms) => { void apply(ms); });

  const baseSeek = window.__ff.seek;
  window.__ff.seek = async (ms) => {
    baseSeek(ms);
    await apply(ms);
    return ms;
  };
  window.__ffMediaReady = Promise.resolve(true);
})();`;
