// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Substitui `<video>` por `<img>` servido pelo host. O Chrome nunca decodifica
 * vídeo durante a captura — é a maior fonte de não-determinismo depois do relógio.
 *
 * O swap é preguiçoso: acontece no primeiro seek, quando fontes e layout já
 * assentaram. Cada troca de frame espera `img.decode()`, então o screenshot
 * nunca pega um frame meio decodificado.
 */
export const MEDIA_SHIM_SOURCE = `(() => {
  const manifest = window.__ffMedia;
  if (!manifest || !manifest.clips || manifest.clips.length === 0) {
    window.__ffMediaReady = Promise.resolve(false);
    return;
  }
  const fps = manifest.fps.num / manifest.fps.den;
  const entries = [];
  let swapped = false;

  const swap = () => {
    for (const clip of manifest.clips) {
      const video = [...document.querySelectorAll("video")].find(
        (element) => element.getAttribute("data-clip-id") === clip.clipId,
      );
      if (!video) continue;
      const box = video.getBoundingClientRect();
      const img = document.createElement("img");
      img.src = "/__ff_media/" + clip.dir + "/000000.jpg";
      img.setAttribute("data-ff-media", clip.clipId);
      img.style.cssText =
        "position:fixed;left:" + box.left + "px;top:" + box.top + "px;width:" + box.width + "px;height:" +
        box.height + "px;object-fit:contain;display:block;";
      video.parentNode.insertBefore(img, video.nextSibling);
      video.style.display = "none";
      entries.push({ clip, img, lastFrame: -1 });
    }
  };

  const apply = async (ms) => {
    if (!swapped) { swapped = true; swap(); }
    const seconds = ms / 1000;
    const pending = [];
    for (const entry of entries) {
      const raw = Math.floor((seconds - entry.clip.start) * entry.clip.playbackRate * fps);
      const frame = Math.max(0, Math.min(entry.clip.frameCount - 1, raw));
      if (frame === entry.lastFrame) continue;
      entry.lastFrame = frame;
      entry.img.src = "/__ff_media/" + entry.clip.dir + "/" + String(frame).padStart(6, "0") + ".jpg";
      pending.push(entry.img.decode().catch(() => {}));
    }
    await Promise.all(pending);
  };

  const baseSeek = window.__ff.seek;
  window.__ff.seek = async (ms) => {
    baseSeek(ms);
    await apply(ms);
    return ms;
  };
  window.__ffMediaReady = Promise.resolve(true);
})();`;
