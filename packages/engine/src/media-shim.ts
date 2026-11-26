// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Substitui `<video>` por `<img>` servido pelo host. O Chrome nunca decodifica
 * vídeo durante a captura — é a maior fonte de não-determinismo depois do relógio.
 *
 * O swap é preguiçoso: acontece no primeiro seek, quando fontes e layout já
 * assentaram. Cada troca de frame espera `img.decode()`, então o screenshot
 * nunca pega um frame meio decodificado.
 *
 * A <img> herda os valores computados das propriedades visuais do vídeo (enquadramento,
 * filter, opacity, borda, clip-path, máscara, mix-blend-mode, z-index, transform…)
 * e leva o motion dele (`data-ff-motion`, `data-ff-comp-start`): enter/exit/emphasis e
 * a câmera animam a <img>. Limite: a cópia dos estilos computados acontece uma vez, no
 * primeiro seek, e a <img> é `position:fixed`, então motion num ANCESTRAL do vídeo não a move.
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

  const VISUAL_PROPS = [
    "object-fit",
    "object-position",
    "filter",
    "backdrop-filter",
    "opacity",
    "mix-blend-mode",
    "isolation",
    "clip-path",
    "mask-image",
    "mask-size",
    "mask-position",
    "mask-repeat",
    "mask-origin",
    "mask-clip",
    "mask-mode",
    "mask-composite",
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-right-radius",
    "border-bottom-left-radius",
    "border-top-width",
    "border-top-style",
    "border-top-color",
    "border-right-width",
    "border-right-style",
    "border-right-color",
    "border-bottom-width",
    "border-bottom-style",
    "border-bottom-color",
    "border-left-width",
    "border-left-style",
    "border-left-color",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "box-shadow",
    "outline-width",
    "outline-style",
    "outline-color",
    "outline-offset",
    "background-color",
    "background-image",
    "background-size",
    "background-position",
    "background-repeat",
    "background-origin",
    "background-clip",
    "overflow-x",
    "overflow-y",
    "image-rendering",
    "transform",
    "transform-origin",
    "translate",
    "rotate",
    "scale",
  ];
  const TRANSFORM_PROPS = ["transform", "translate", "rotate", "scale"];

  const swap = () => {
    for (const clip of manifest.clips) {
      const video = [...document.querySelectorAll("video")].find(
        (element) => element.getAttribute("data-clip-id") === clip.clipId,
      );
      if (!video) continue;
      const style = getComputedStyle(video);
      const computed = [];
      let hasTransform = false;
      for (const prop of VISUAL_PROPS) {
        const value = style.getPropertyValue(prop);
        if (value !== "") {
          computed.push([prop, value]);
          if (TRANSFORM_PROPS.includes(prop) && value !== "none") hasTransform = true;
        }
      }
      const displayValue = style.display === "none" ? "none" : "block";
      const positionValue = style.position;
      const zIndexValue = style.zIndex;
      const visibilityValue = style.visibility;
      const parentDisplay = video.parentElement ? getComputedStyle(video.parentElement).display : "";
      const positioned = positionValue !== "static" || /flex|grid/.test(parentDisplay);

      // Com transform no próprio <video>, getBoundingClientRect() devolveria o retângulo já girado/escalado;
      // medir sem transform garante a caixa base antes de copiar transform/translate/rotate/scale para a <img>.
      let box;
      if (hasTransform) {
        const saved = [];
        for (const prop of TRANSFORM_PROPS) {
          saved.push([prop, video.style.getPropertyValue(prop), video.style.getPropertyPriority(prop)]);
          video.style.setProperty(prop, "none", "important");
        }
        box = video.getBoundingClientRect();
        for (const item of saved) {
          if (item[1] === "") video.style.removeProperty(item[0]);
          else video.style.setProperty(item[0], item[1], item[2]);
        }
      } else {
        box = video.getBoundingClientRect();
      }

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
        box.height + "px;box-sizing:border-box;margin:0;display:" + displayValue + ";animation:none;transition:none;";
      for (const item of computed) img.style.setProperty(item[0], item[1]);
      if (positioned && zIndexValue !== "" && zIndexValue !== "auto") img.style.setProperty("z-index", zIndexValue);
      if (!video.hasAttribute("data-ff-start") && visibilityValue !== "" && visibilityValue !== "visible") {
        img.style.setProperty("visibility", visibilityValue);
      }
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
