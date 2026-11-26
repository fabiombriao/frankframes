// FrankFrames — proprietário. Ver LICENSE na raiz.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureFramesInParallel, openSession, startServer } from "@frankframes/engine";
import type { GpuMode, Session, StaticServer, Viewport } from "@frankframes/engine";
import type { Fps } from "@frankframes/contract";

export interface VideoFrame {
  clipId: string;
  fit: "cover" | "fill";
  position: [number, number];
  zoom: number;
  fx: number;
  fy: number;
  filter: string;
}

export interface GlassRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  sigma: number;
  opacity: number;
}

export interface ProgressFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  fill: number;
  rgba: [number, number, number, number];
}

interface PageFrame {
  video: VideoFrame;
  glass: GlassRegion[];
  progress?: ProgressFrame;
  background?: string;
  signature?: string;
}

/** Serializada para o navegador, onde layout e motion já foram resolvidos pelo seek normal. */
export async function inspectFrame(sparse: boolean): Promise<PageFrame | { error: string }> {
  const glass: GlassRegion[] = [];
  const fail = (error: string): { error: string } => ({ error });
  let video: VideoFrame | undefined;
  const root = document.querySelector('[data-composition-id][data-root="true"]') ?? document.querySelector("[data-composition-id]");
  if (root === null || !(root instanceof HTMLElement)) return fail("a composição precisa de uma raiz HTML");
  const visible = (style: CSSStyleDeclaration): boolean => style.display !== "none" && style.visibility === "visible";
  const noOutline = (style: CSSStyleDeclaration): boolean => style.outlineStyle === "none" || style.outlineWidth === "0px";
  for (const media of Array.from(document.querySelectorAll<HTMLImageElement>("[data-ff-media]"))) {
    const style = getComputedStyle(media);
    if (!visible(style) || media.getClientRects().length === 0) continue;
    const clipId = media.getAttribute("data-ff-media")!;
    if (video !== undefined) return fail(`vídeos simultâneos: ${video.clipId} e ${clipId}`);
    const box = media.getBoundingClientRect();
    if (Math.abs(box.left) + Math.abs(box.top) + Math.abs(box.width - innerWidth) + Math.abs(box.height - innerHeight) > 0.01) {
      return fail(`o vídeo ${clipId} precisa preencher o quadro`);
    }
    const objectFit = style.objectFit;
    const position = /^(\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/.exec(style.objectPosition);
    if ((objectFit !== "cover" && objectFit !== "fill") || position === null) {
      return fail(`enquadramento de ${clipId}: use object-fit cover ou fill e object-position em porcentagem`);
    }
    if (style.opacity !== "1" || style.clipPath !== "none" || style.maskImage !== "none" ||
        style.mixBlendMode !== "normal" || style.backdropFilter !== "none" ||
        style.transform !== "none" || style.rotate !== "none" ||
        style.scale !== "none" || style.translate !== "none" ||
        [style.borderTopWidth, style.borderBottomWidth, style.borderLeftWidth, style.borderRightWidth,
          style.paddingTop, style.paddingBottom, style.paddingLeft, style.paddingRight,
          style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius,
          style.borderBottomRightRadius].some((value) => value !== "0px")) {
      return fail(`o vídeo ${clipId} tem transformação, borda ou efeito visual incompatível com o modo por camadas`);
    }
    if (media.parentElement !== root || (style.zIndex !== "auto" && Number(style.zIndex) !== 0)) {
      return fail(`o vídeo ${clipId} precisa estar no fundo, diretamente na raiz e sem z-index próprio`);
    }
    const number = (prop: string, initial: number): number => Number(style.getPropertyValue(prop) || initial);
    video = {
      clipId, fit: objectFit, position: [Number(position[1]) / 100, Number(position[2]) / 100],
      zoom: number("--ff-zoom", 1), fx: number("--ff-fx", 0.5), fy: number("--ff-fy", 0.5), filter: style.filter,
    };
  }
  if (video === undefined) return fail("o modo por camadas precisa de um vídeo de fundo em cada frame");

  const state = globalThis as typeof globalThis & {
    __ff: { settle: () => Promise<void> };
    __ffLayerProgress?: { element: HTMLElement; style: string; priority: string; opacity: number };
    __ffLayerBackground?: string;
  };
  let repaint = false;
  if (sparse && state.__ffLayerBackground === undefined) {
    const candidate = Array.from(root.children).find((element) =>
      !element.hasAttribute("data-ff-media") && !["VIDEO", "AUDIO", "SCRIPT", "STYLE", "TEMPLATE"].includes(element.tagName),
    );
    if (candidate instanceof HTMLElement && candidate.childElementCount === 0 && candidate.textContent?.trim() === "") {
      const style = getComputedStyle(candidate);
      const box = candidate.getBoundingClientRect();
      if (candidate.getAnimations().length === 0 && !candidate.hasAttribute("data-ff-start") &&
          visible(style) && style.position === "absolute" && (style.zIndex === "auto" || style.zIndex === "0") &&
          style.backgroundImage.includes("gradient(") && !style.backgroundImage.includes("url(") &&
          style.filter === "none" && style.backdropFilter === "none" && style.mixBlendMode === "normal" &&
          style.transform === "none" && style.boxShadow === "none" && style.clipPath === "none" && style.maskImage === "none" &&
          noOutline(style) &&
          [style.borderTopWidth, style.borderBottomWidth, style.borderLeftWidth, style.borderRightWidth,
            style.borderTopLeftRadius, style.borderTopRightRadius,
            style.borderBottomLeftRadius, style.borderBottomRightRadius].every((value) => value === "0px") &&
          ["::before", "::after"].every((pseudo) => ["none", "normal"].includes(getComputedStyle(candidate, pseudo).content)) &&
          box.x === 0 && box.y === 0 && box.width === innerWidth && box.height === innerHeight) {
        const props = ["background-image", "background-color", "background-size", "background-position",
          "background-repeat", "background-origin", "background-clip", "opacity"];
        state.__ffLayerBackground = props.map((name) => `${name}:${style.getPropertyValue(name)}`).join(";");
        candidate.style.setProperty("opacity", "0", "important");
        repaint = true;
      }
    }
    state.__ffLayerBackground ??= "";
  }

  for (const element of Array.from(document.body.querySelectorAll("*"))) {
    const style = getComputedStyle(element);
    if (!visible(style) || style.backdropFilter === "none" || element.getClientRects().length === 0) continue;
    const blur = /^blur\(([\d.]+)px\)$/.exec(style.backdropFilter);
    const radius = /^([\d.]+)px$/.exec(style.borderTopLeftRadius);
    if (blur === null || radius === null ||
        [style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].some((value) => value !== radius[0])) {
      return fail("use backdrop-filter: blur(px) e border-radius uniforme nos elementos de vidro");
    }
    let opacity = Number(style.opacity);
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      opacity *= Number(getComputedStyle(parent).opacity);
    }
    const box = element.getBoundingClientRect();
    if (opacity === 0 || box.width === 0 || box.height === 0) continue;
    const scale = box.width / (element instanceof HTMLElement ? element.offsetWidth || box.width : box.width);
    glass.push({
      x: box.x, y: box.y, width: box.width, height: box.height,
      sigma: Number(blur[1]), radius: Number(radius[1]) * scale, opacity,
    });
  }

  const scopes = [document.documentElement, document.body, root];
  for (const root of scopes) {
    if (root.style.getPropertyValue("background") !== "none" || root.style.getPropertyPriority("background") !== "important") {
      root.style.setProperty("background", "none", "important");
      repaint = true;
    }
  }
  const background = state.__ffLayerBackground;
  const backgroundProperty = background ? { background } : {};
  if (!sparse || document.querySelector("img:not([data-ff-media]), canvas, iframe, object, embed, svg animate, svg animateTransform")) {
    if (repaint) await state.__ff.settle();
    return { video, glass, ...backgroundProperty };
  }
  const animations = document.getAnimations();
  // Uma barra CSS simples pode mudar em todo frame sem invalidar o PNG que contém o restante do HTML.
  let progress: ProgressFrame | undefined;
  const separate = (animation: Animation): ProgressFrame | undefined => {
    const effect = animation.effect;
    if (!(animation instanceof CSSAnimation) || !(effect instanceof KeyframeEffect) || !(effect.target instanceof HTMLElement)) return;
    const fill = effect.target;
    const track = fill.parentElement;
    if (effect.pseudoElement || !track || fill.textContent !== "" || fill.childElementCount > 0 ||
        track.childElementCount !== 1 || track.textContent !== "" ||
        fill.getAnimations().length !== 1 || track.getAnimations().length !== 0 ||
        !effect.getKeyframes().some((frame) => "width" in frame) ||
        effect.getKeyframes().some((frame) => Object.keys(frame).some((name) =>
          !["width", "offset", "computedOffset", "easing", "composite"].includes(name)))) return;
    const style = getComputedStyle(fill);
    const parent = getComputedStyle(track);
    const bg = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(style.backgroundColor);
    const radius = /^(\d+(?:\.\d+)?)px$/.exec(parent.borderTopLeftRadius);
    const bounds = track.getBoundingClientRect();
    const box = fill.getBoundingClientRect();
    if (!bg || !radius || parent.overflowX !== "hidden" || parent.overflowY !== "hidden" ||
        style.backgroundImage !== "none" || style.borderTopWidth !== "0px" || style.borderBottomWidth !== "0px" ||
        style.borderLeftWidth !== "0px" || style.borderRightWidth !== "0px" ||
        style.boxShadow !== "none" || style.transform !== "none" || style.filter !== "none" ||
        style.mixBlendMode !== "normal" || parent.opacity !== "1" || !visible(style) || !visible(parent) ||
        !["none", "normal"].includes(getComputedStyle(fill, "::before").content) ||
        !["none", "normal"].includes(getComputedStyle(fill, "::after").content) ||
        bounds.height <= 0 || bounds.height > 32 || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isInteger) ||
        box.x !== bounds.x || box.y !== bounds.y || box.height !== bounds.height || box.width > bounds.width ||
        [parent.borderTopRightRadius, parent.borderBottomLeftRadius, parent.borderBottomRightRadius].some((value) => value !== radius[0])) return;
    // Se algum elemento posterior cruza a barra, deixe o Chrome preservar a ordem de pintura.
    for (const other of Array.from(document.body.querySelectorAll("*"))) {
      if (track.contains(other) || other.hasAttribute("data-ff-media") ||
          !(track.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const otherStyle = getComputedStyle(other);
      if (!visible(otherStyle)) continue;
      const rect = other.getBoundingClientRect();
      if (rect.left >= bounds.right || rect.right <= bounds.left || rect.top >= bounds.bottom || rect.bottom <= bounds.top) continue;
      const transparentContainer = /^(DIV|SECTION|SPAN|MAIN)$/.test(other.tagName) &&
        otherStyle.backgroundColor === "rgba(0, 0, 0, 0)" && otherStyle.backgroundImage === "none" &&
        otherStyle.boxShadow === "none" && otherStyle.filter === "none" && otherStyle.backdropFilter === "none" &&
        noOutline(otherStyle) &&
        [otherStyle.borderTopWidth, otherStyle.borderBottomWidth, otherStyle.borderLeftWidth, otherStyle.borderRightWidth]
          .every((value) => value === "0px") &&
        !Array.from(other.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) &&
        ["::before", "::after"].every((pseudo) => ["none", "normal"].includes(getComputedStyle(other, pseudo).content));
      if (!transparentContainer) return;
    }
    return {
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      radius: Number(radius[1]), fill: box.width,
      rgba: [Number(bg[1]), Number(bg[2]), Number(bg[3]), Number(bg[4] ?? 1) * 255],
    };
  };
  const progressAnimations = animations.flatMap((animation) => {
    const sample = separate(animation);
    return sample === undefined ? [] : [{ animation, sample }];
  });
  const separated = progressAnimations.length === 1 ? progressAnimations[0] : undefined;
  const target = separated === undefined ? undefined : (separated.animation.effect as KeyframeEffect).target as HTMLElement;
  if (state.__ffLayerProgress && state.__ffLayerProgress.element !== target) {
    const { element, style, priority } = state.__ffLayerProgress;
    if (style === "") element.style.removeProperty("opacity");
    else element.style.setProperty("opacity", style, priority);
    delete state.__ffLayerProgress;
    repaint = true;
  }
  if (target && separated) {
    if (!state.__ffLayerProgress) {
      state.__ffLayerProgress = {
        element: target, style: target.style.opacity, priority: target.style.getPropertyPriority("opacity"),
        opacity: Number(getComputedStyle(target).opacity),
      };
      target.style.setProperty("opacity", "0", "important");
      repaint = true;
    }
    separated.sample.rgba[3] *= state.__ffLayerProgress.opacity;
    progress = separated.sample;
  }
  if (repaint) await state.__ff.settle();
  const signature = [];
  signature.push([String(progress !== undefined)]);
  for (const animation of animations) {
    if (animation === separated?.animation) continue;
    const effect = animation.effect;
    if (!(effect instanceof KeyframeEffect) || effect.target === null || effect.target.hasAttribute("data-ff-media")) continue;
    const style = getComputedStyle(effect.target, effect.pseudoElement);
    if (!visible(style)) continue;
    const props = new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)));
    props.delete("offset");
    props.delete("computedOffset");
    props.delete("easing");
    props.delete("composite");
    signature.push([...props].map((prop) => style.getPropertyValue(prop.replace(/[A-Z]/g, (char) => "-" + char.toLowerCase()))));
  }
  for (const element of Array.from(document.querySelectorAll("[data-ff-start]:not(video, [data-ff-media])"))) {
    signature.push([getComputedStyle(element).visibility]);
  }
  return { video, glass, ...backgroundProperty, ...(progress === undefined ? {} : { progress }), signature: JSON.stringify(signature) };
}

export class LayeredError extends Error {
  constructor(message: string) {
    super(`${message} (renderize sem --layered para usar a captura integral)`);
  }
}

export interface LayeredCapture {
  frames: PageFrame[];
  hashes: Map<number, string>;
  background: boolean;
}

export function layerName(frame: number): string {
  return `layer-${String(frame).padStart(6, "0")}.png`;
}

export async function captureLayers(options: {
  server: StaticServer;
  url: string;
  viewport: Viewport;
  fps: Fps;
  total: number;
  workers: number;
  gpu: GpuMode;
  sparse: boolean;
  directory: string;
  signal?: AbortSignal;
  onScan?: (scanned: number) => void;
}): Promise<LayeredCapture> {
  const frames: PageFrame[] = Array.from({ length: options.total });
  const previous = new WeakMap<Session, { frame: number; signature: string | undefined }>();
  const inspect = `(${inspectFrame.toString()})(${options.sparse})`;
  const interval = Math.max(60, Math.ceil(options.total / 10));
  let scanned = 0;
  const hashes = await captureFramesInParallel({
    url: options.url,
    viewport: options.viewport,
    fps: options.fps,
    frames: [...Array(options.total).keys()],
    workers: options.workers,
    batchSize: Math.ceil(options.total / Math.max(1, options.workers)),
    gpu: options.gpu,
    transparent: true,
    serverFailures: options.server.failures,
    shouldCapture: async (frame, session) => {
      options.signal?.throwIfAborted();
      const state = await session.evaluate<PageFrame | { error: string }>(inspect);
      if ("error" in state) throw new LayeredError(`frame ${frame}: ${state.error}`);
      frames[frame] = state;
      scanned += 1;
      if (scanned < options.total && scanned % interval === 0) options.onScan?.(scanned);
      const last = previous.get(session);
      previous.set(session, { frame, signature: state.signature });
      return state.signature === undefined || last?.frame !== frame - 1 || last.signature !== state.signature;
    },
    onFrame: (frame, png) => writeFile(join(options.directory, layerName(frame)), png),
  });
  const backgrounds = new Set(frames.map(({ background }) => background));
  if (backgrounds.size > 1) throw new LayeredError("o gradiente de fundo precisa ter o mesmo estilo em todos os workers");
  const background = frames[0]?.background;
  if (background !== undefined) {
    const page = "<!doctype html><style>html,body{margin:0;background:transparent}" +
      `#background{position:fixed;inset:0;${background}}</style><div id="background"></div>`;
    options.signal?.throwIfAborted();
    const server = await startServer(options.directory, { page: { path: "background.html", html: page }, fontsRoot: null });
    try {
      const session = await openSession({ url: `${server.url}background.html`, viewport: options.viewport, gpu: options.gpu, transparent: true });
      try {
        await session.seekFrame(0, options.fps);
        const { png } = await session.capture();
        await writeFile(join(options.directory, "background.png"), png);
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  }
  return { frames, hashes, background: background !== undefined };
}
