// FrankFrames — proprietário. Ver LICENSE na raiz.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadComposition } from "@frankframes/contract";
import type { Composition, Diagnostic, RawClip, ResolvedClip } from "@frankframes/contract";
import { buildFramePipeArgs, buildMuxArgs, containerFor } from "@frankframes/encode";
import type { Preset, VideoCodec } from "@frankframes/encode";
import { BrowserError, MediaRotationError, assetPath, captureFramesInParallel, cleanupWarning, extractFramesCached, planWorkers, probeDuration, probeVideo, removeTree, reorderWindow, retryOnceIfTransient, startServer, warnCleanup } from "@frankframes/engine";
import type { ClassifiedFailure, LayeredMediaManifest, MediaManifest, VideoProbe } from "@frankframes/engine";
import { annotateCompiled, layeredPage, materializeClipIds, mergeSubCompositions } from "./compile.ts";
import { resolveFfmpeg } from "./ffmpeg.ts";
import { AudioTruePeakError, mixAudio } from "./audio.ts";
import { PipeEncodeError, encodeWhileCapturing } from "./pipe-encode.ts";
import type { EncodeRun } from "./pipe-encode.ts";
import { audioClipsFor } from "./preview-audio.ts";
import { VariableError, applyVariables } from "./variables.ts";
import { captureLayers, LayeredError } from "./layered-capture.ts";
import type { LayeredCapture } from "./layered-capture.ts";
import { encodeLayers, probeLayeredVram } from "./layered-encode.ts";
import type { LayeredSource } from "./layered-encode.ts";

const run = promisify(execFile);

/** Clips de todos os escopos com o início absoluto na timeline. */
export function timedClips(composition: Composition): Array<{ clip: ResolvedClip; start: number }> {
  const out: Array<{ clip: ResolvedClip; start: number }> = [];
  const walk = (clips: ResolvedClip[], compStart: number): void => {
    for (const clip of clips) {
      const start = compStart + (clip.start ?? 0);
      out.push({ clip, start });
      walk(clip.children, start);
    }
  };
  walk(composition.clips, 0);
  return out;
}

/**
 * Dá o nome final à saída. No Windows o `rename` falha quando o destino está aberto num player
 * (EBUSY/EPERM/EACCES): vira erro claro, nunca um export "concluído" sem arquivo.
 */
async function publishOutput(partialPath: string, outPath: string): Promise<void> {
  try {
    await rename(partialPath, outPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      throw new RenderError(
        "E_INTERNAL",
        "assemble",
        `não foi possível gravar ${basename(outPath)}: o arquivo está em uso (feche o player ou o editor que o abriu) e tente de novo`,
      );
    }
    throw error;
  }
}

/** Quantos frames cobrem a duração: o frame parcial do fim conta. */
export function frameCountFor(seconds: number, fps: { num: number; den: number }): number {
  return Math.max(1, Math.ceil((seconds * fps.num) / fps.den - 1e-9));
}

export type RenderStage = "compile" | "probe" | "extract" | "capture" | "audio" | "encode" | "assemble";

export class RenderError extends Error {
  readonly code: string;
  readonly stage: RenderStage;
  readonly diagnostics: Diagnostic[];

  constructor(code: string, stage: RenderStage, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = "RenderError";
    this.code = code;
    this.stage = stage;
    this.diagnostics = diagnostics;
  }
}

/** Lança `E_CANCELED` no estágio atual quando o chamador abortou o render. */
function throwIfCanceled(signal: AbortSignal | undefined, stage: RenderStage): void {
  if (signal?.aborted === true) throw new RenderError("E_CANCELED", stage, "render cancelado");
}

/**
 * Falha do FFmpeg alimentado por pipe: `E_ENCODE` no estágio `encode`, com a stderr dele na mensagem e um hint
 * acionável (o pipe caiu por causa do FFmpeg, do disco ou da entrada, nunca por um defeito da composição).
 */
export function encodeFailure(error: unknown): RenderError | undefined {
  if (!(error instanceof PipeEncodeError)) return undefined;
  return new RenderError("E_ENCODE", "encode", `${error.message} (confira o FFmpeg com \`frankframes doctor\` e o espaço livre em disco, e rode de novo)`);
}

/**
 * Falha do runtime do motion durante a prontidão da página (conflito de posse, alvo
 * proibido, JSON inválido): sai com código próprio em vez de "erro interno".
 */
function motionFailure(error: unknown): RenderError | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /E_MOTION_[A-Z_]+: [^\r\n]*/.exec(message);
  return match === null ? undefined : new RenderError("E_MOTION_RUNTIME", "capture", match[0]);
}

/**
 * O Chrome caiu ou parou de responder durante a captura: o código já vem do engine
 * (`BrowserError`), com o hint dentro da mensagem.
 */
function browserFailure(error: unknown): RenderError | undefined {
  if (!(error instanceof BrowserError)) return undefined;
  return new RenderError(error.code, "capture", error.message);
}

/**
 * Face de fonte declarada que não carregou na prontidão da página: o texto sairia na fonte
 * de reserva. A mensagem já traz a família e o que conferir (o "hint" fica na frase).
 */
function fontFailure(error: unknown): RenderError | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /E_FONT_LOAD: [^\r\n]*/.exec(message);
  return match === null ? undefined : new RenderError("E_FONT_LOAD", "capture", match[0]);
}

export interface PrepareOptions {
  entry: string;
  ffmpeg?: string;
  ffprobe?: string;
  onProgress?: (stage: RenderStage, percent: number, message?: string) => void;
  /** Aborta entre as etapas e mata o FFmpeg de probe/extração em andamento (`E_CANCELED`). */
  signal?: AbortSignal;
  /** Variáveis de dados (§11): trocam `data-var` / `data-var-attr` antes do contrato. Sem isso, vale o valor autoral. */
  vars?: Record<string, string>;
  /** Prepara fontes e tempos de vídeo para o compositor, sem extrair JPEGs. */
  layered?: boolean;
  annotateSource?: NonNullable<Parameters<typeof mergeSubCompositions>[4]>;
}

export interface PreparedComposition {
  entry: string;
  entryDir: string;
  composition: Composition;
  /** HTML com sub-composições inlinadas e tempo anotado. */
  compiledHtml: string;
  mediaDir?: string;
  manifest?: MediaManifest;
  layeredSources?: LayeredSource[];
  seconds: number;
  fps: { num: number; den: number };
  viewport: { width: number; height: number };
  totalFrames: number;
  warnings: string[];
}

function probeRaw(clips: RawClip[], into: RawClip[]): void {
  for (const clip of clips) {
    into.push(clip);
    probeRaw(clip.children, into);
  }
}

/**
 * Metade do pipeline que não captura: junta sub-composições, mede mídia, resolve
 * o contrato, anota o tempo e extrai os frames de vídeo. Usada pelo `render` e
 * pelo `preview`, para que os dois mostrem a mesma composição.
 */
export async function prepare(options: PrepareOptions): Promise<PreparedComposition> {
  const entry = resolve(options.entry);
  const entryDir = dirname(entry);
  const pair = options.ffmpeg !== undefined && options.ffprobe !== undefined ? undefined : await resolveFfmpeg();
  const ffmpeg = options.ffmpeg ?? pair!.ffmpeg;
  const ffprobe = options.ffprobe ?? pair!.ffprobe;
  const progress = options.onProgress ?? (() => {});
  const signal = options.signal;
  const warnings: string[] = [];

  throwIfCanceled(signal, "compile");
  progress("compile", 5, entry);
  const source = await readFile(entry, "utf8");
  const merged = await mergeSubCompositions(source, entryDir, entry, undefined, options.annotateSource);
  warnings.push(...merged.warnings);

  // Variáveis entram depois de inlinar as sub-composições (um data-var dentro de uma vale igual) e antes do
  // contrato: duração e tempo trocados por variável são validados normalmente.
  let compiledSource = merged.html;
  if (options.vars !== undefined) {
    try {
      compiledSource = applyVariables(compiledSource, options.vars).html;
    } catch (error) {
      if (error instanceof VariableError) throw new RenderError(error.code, "compile", error.message);
      throw error;
    }
  }

  const materialized = materializeClipIds(compiledSource);
  const parsed = loadComposition(materialized);
  if (!parsed.ok) {
    throw new RenderError(
      "E_CONTRACT",
      "compile",
      `contrato inválido: ${parsed.diagnostics.filter((d) => d.severity === "error").length} erro(s)`,
      parsed.diagnostics,
    );
  }

  throwIfCanceled(signal, "probe");
  progress("probe", 10);
  const flat: RawClip[] = [];
  probeRaw(parsed.clips, flat);
  const mediaDurations: Record<string, number> = {};
  // Todo `<video>` é sondado, com ou sem `data-duration`: a orientação de exibição (EDT-86) vale para a extração.
  const videoProbes = new Map<string, VideoProbe>();
  for (const clip of flat) {
    if (clip.mediaSrc === undefined) continue;
    if (clip.tag !== "video" && clip.tag !== "audio") continue;
    if (clip.tag === "audio" && clip.authoredDuration !== undefined) continue;
    const file = resolve(entryDir, clip.mediaSrc);
    throwIfCanceled(signal, "probe");
    try {
      if (clip.tag === "video") {
        const info = await probeVideo(ffprobe, file, signal);
        videoProbes.set(clip.id, info);
        if (clip.authoredDuration === undefined) mediaDurations[clip.id] = info.duration;
      } else {
        mediaDurations[clip.id] = await probeDuration(ffprobe, file, signal);
      }
    } catch (error) {
      // Abortar o ffprobe não é mídia ilegível: sobe como cancelamento.
      throwIfCanceled(signal, "probe");
      // Rotação que preview e render não aplicariam igual: código próprio, com o hint na mensagem.
      if (error instanceof MediaRotationError) throw new RenderError(error.code, "probe", error.message);
      throw new RenderError("E_MEDIA_PROBE", "probe", `não foi possível ler ${file}: ${(error as Error).message}`);
    }
  }

  const composition = loadComposition(materialized, { mediaDurations });
  if (!composition.ok) {
    throw new RenderError("E_CONTRACT", "probe", "contrato inválido após ajustar a duração da mídia", composition.diagnostics);
  }
  if (composition.duration.kind === "unresolved") {
    throw new RenderError("E_DURATION", "probe", `duração não resolvida (${composition.duration.reason})`, composition.diagnostics);
  }

  const compiled = annotateCompiled(materialized, composition);
  if (compiled.annotations === 0) warnings.push("nenhum clip anotado: a composição não tem clips temporizados");

  const seconds = composition.duration.seconds;
  const fps = composition.fps;
  const viewport = { width: composition.width ?? 1920, height: composition.height ?? 1080 };
  // `prepare` não escreve em disco fora do cache de frames: o diretório de trabalho do render (vídeo, áudio, PNG do
  // --keep) é criado por quem renderiza, em `renderPipeline` (EDT-78).
  let mediaDir: string | undefined;
  let manifest: MediaManifest | undefined;
  const videos = timedClips(composition).filter((item) => item.clip.tag === "video" && item.clip.mediaSrc !== undefined);
  const layeredSources: LayeredSource[] = [];
  if (videos.length > 0 && options.layered !== true) {
    progress("extract", 20);
    mediaDir = assetPath("cache", "frames");
    manifest = { fps, clips: [] };
  }
  for (const { clip, start } of videos) {
    throwIfCanceled(signal, "extract");
    const clipDuration = clip.authoredDuration ?? Math.max(0, seconds - start);
    const info = videoProbes.get(clip.id);
    if (info === undefined) throw new Error(`vídeo ${clip.id} chegou à preparação sem probe`);
    const timing = {
      clipId: clip.id,
      start,
      duration: clipDuration,
      offset: clip.offset,
      playbackRate: clip.playbackRate,
      orientation: { rotation: info.rotation, mirrored: info.mirrored, displayWidth: info.displayWidth, displayHeight: info.displayHeight },
    };
    const input = resolve(entryDir, clip.mediaSrc!);
    if (manifest === undefined || mediaDir === undefined) {
      layeredSources.push({ timing, input });
      continue;
    }
    const dir = `${clip.id.replace(/[^A-Za-z0-9_-]/g, "_")}_${createHash("sha256").update(clip.id).digest("hex").slice(0, 6)}`;
    let extracted: Awaited<ReturnType<typeof extractFramesCached>>;
    try {
      extracted = await extractFramesCached({
        ffmpeg,
        input,
        outDir: join(mediaDir, dir),
        fps,
        offset: clip.offset,
        duration: clipDuration * clip.playbackRate,
        expectDisplay: { width: info.displayWidth, height: info.displayHeight },
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof MediaRotationError) throw new RenderError(error.code, "extract", error.message);
      throw error;
    }
    const { frameCount, dir: cacheDir } = extracted;
    const cacheName = cacheDir.slice(mediaDir.length + 1);
    manifest.clips.push({ ...timing, dir: cacheName, frameCount });
  }

  return {
    entry,
    entryDir,
    composition,
    compiledHtml: compiled.html,
    ...(mediaDir !== undefined ? { mediaDir } : {}),
    ...(manifest !== undefined ? { manifest } : {}),
    ...(layeredSources.length > 0 ? { layeredSources } : {}),
    seconds,
    fps,
    viewport,
    totalFrames: frameCountFor(seconds, fps),
    warnings,
  };
}

export interface RenderOptions {
  entry: string;
  outPath: string;
  /** `auto` (padrão) usa GPU quando existe; `software` garante pixel entre máquinas. */
  gpu?: "auto" | "software" | "hardware";
  /** Captura o HTML sobre fundo transparente e compõe o vídeo original no FFmpeg. */
  layered?: boolean;
  /** Ativa camadas e tenta usar Vulkan da decodificação ao encode. */
  vram?: boolean;
  /** `false` entrega o mix sem normalizar para −14 LUFS. */
  loudness?: false;
  ffmpeg?: string;
  ffprobe?: string;
  codec?: VideoCodec;
  preset?: Preset;
  /**
   * Sessões de captura. Sem isso, `planWorkers` decide pela CPU e pela memória livre no começo do render; a escolha sai
   * na mensagem de progresso da captura e, com a memória baixa demais, um aviso vai para `warnings`.
   */
  workers?: number;
  /**
   * Mantém a pasta de trabalho depois do render. Sem isso os frames vão direto ao FFmpeg e nunca tocam o disco;
   * com isso eles também são gravados em `<pasta>/frames/frame_000001.png…` (EDT-62), para inspeção.
   */
  keepWorkDir?: boolean;
  onProgress?: (stage: RenderStage, percent: number, message?: string) => void;
  /**
   * Cancela o render: mata o FFmpeg, para os workers de captura e apaga os temporários e a saída
   * parcial. Rejeita com `RenderError("E_CANCELED", <estágio atual>, …)`.
   */
  signal?: AbortSignal;
  /** Variáveis de dados (§11), aplicadas antes do contrato. */
  vars?: Record<string, string>;
}

export interface RenderResult {
  outPath: string;
  frames: number;
  durationSeconds: number;
  codec: VideoCodec;
  preset: Preset;
  hasAudio: boolean;
  warnings: string[];
  hashes: Map<number, string>;
  workDir: string;
}

/**
 * Pipeline completo: HTML -> MP4. Estágios fixos e progresso previsível
 * (compile 5, probe 10, extract 20, capture 25→75, audio, encode 75→90, assemble 100).
 */
export async function renderComposition(options: RenderOptions): Promise<RenderResult> {
  let stage: RenderStage = "compile";
  const onProgress = options.onProgress;
  const tracked = (next: RenderStage, percent: number, message?: string): void => {
    stage = next;
    onProgress?.(next, percent, message);
  };
  try {
    return await renderPipeline(options, tracked);
  } catch (error) {
    // Cancelar mata o FFmpeg (AbortError) e derruba a captura com erros colaterais: o chamador pediu
    // cancelar, então qualquer falha depois do abort é cancelamento, no estágio em que estávamos.
    if (options.signal?.aborted === true && !(error instanceof RenderError && error.code === "E_CANCELED")) {
      throw new RenderError("E_CANCELED", stage, "render cancelado", error instanceof RenderError ? error.diagnostics : []);
    }
    throw error;
  }
}

async function renderPipeline(
  options: RenderOptions,
  progress: (stage: RenderStage, percent: number, message?: string) => void,
): Promise<RenderResult> {
  const codec: VideoCodec = options.codec ?? "av1";
  const preset: Preset = options.preset ?? "standard";
  const signal = options.signal;
  const signalOption = signal !== undefined ? { signal } : {};

  // A memória livre é medida uma vez, aqui no começo. Com `workers` pedido, nada é medido.
  const workerPlan: { workers: number; warning?: string; summary?: string } =
    options.workers === undefined ? planWorkers() : { workers: options.workers };
  const { workers } = workerPlan;

  const prepared = await prepare({
    entry: options.entry,
    ...(options.ffmpeg !== undefined ? { ffmpeg: options.ffmpeg } : {}),
    ...(options.ffprobe !== undefined ? { ffprobe: options.ffprobe } : {}),
    onProgress: progress,
    ...signalOption,
    ...(options.vars !== undefined ? { vars: options.vars } : {}),
    ...(options.layered === true || options.vram === true ? { layered: true } : {}),
  });
  const pair = await resolveFfmpeg();
  const ffmpeg = options.ffmpeg ?? pair.ffmpeg;
  const { totalFrames, fps, viewport, seconds, entryDir, composition, warnings } = prepared;
  if (workerPlan.warning !== undefined) warnings.push(workerPlan.warning);
  // Só o render precisa de disco de trabalho; é criado aqui, depois do prepare, e removido no `finally` (ou no exit).
  const workDir = await mkdtemp(join(tmpdir(), "ff-render-"));

  // Composição com vídeo fora de banda usa uma camada <img>; o compositor de GPU
  // atrasa a textura de forma não determinística. Nesses casos, software.
  const requested = options.gpu ?? "auto";
  const gpu =
    requested === "hardware" || prepared.manifest === undefined ? requested : "software";
  if (requested === "auto" && gpu === "software" && prepared.manifest !== undefined) {
    warnings.push("composição com vídeo: render forçado em software para manter o frame determinístico");
  }

  const outPath = resolve(options.outPath);
  // Saída atômica: o FFmpeg grava em `<nome>.partial<ext>` e só o `rename` final dá o nome ao arquivo.
  // O sufixo `.partial` vem antes da extensão para o FFmpeg continuar inferindo o contêiner pela ponta.
  const partialPath = join(dirname(outPath), `${basename(outPath, extname(outPath))}.partial${extname(outPath)}`);

  // Ctrl+C não executa `finally`: o handler de exit remove o diretório de frames e a saída parcial.
  const cleanup = (): void => {
    // force:true: ENOENT é esperado aqui (o finally normal ou o rename final já podem ter removido). Outra falha
    // vai para o stderr com o caminho; num handler de exit não há mais para onde propagar.
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch (error) {
      warnCleanup(workDir, error);
    }
    try {
      rmSync(partialPath, { force: true });
    } catch (error) {
      warnCleanup(partialPath, error);
    }
  };
  process.once("exit", cleanup);

  // O FFmpeg do encode por pipe: precisa estar morto antes de o diretório de trabalho ser removido (no Windows,
  // arquivo aberto não se apaga).
  let encoding: EncodeRun<Map<number, string>> | undefined;
  let completed = false;
  try {
    // Encode enquanto captura: os PNGs vão direto para o stdin do FFmpeg, sem passar por disco.
    // Só com `keepWorkDir` (--keep) eles também são gravados em `frames/`, para inspeção.
    const container = containerFor(codec);
    const videoPath = join(workDir, container === "webm" ? "video.webm" : "video.mp4");
    const framesDir = join(workDir, "frames");
    const keepFrames = options.keepWorkDir === true;
    const layered = prepared.layeredSources;
    const page = layered === undefined ? undefined : layeredPage(prepared.compiledHtml);
    const layerManifest: LayeredMediaManifest | undefined = layered === undefined
      ? undefined
      : { layered: true, fps, clips: layered.map(({ timing }) => timing) };
    const manifest = layerManifest ?? prepared.manifest;
    const layersDir = join(workDir, "layers");
    if (layered !== undefined) await mkdir(layersDir);
    else if (keepFrames) await mkdir(framesDir, { recursive: true });
    throwIfCanceled(signal, "capture");
    progress("capture", 25, workerPlan.summary);
    const server = await startServer(entryDir, {
      ...(prepared.mediaDir !== undefined ? { mediaRoot: prepared.mediaDir } : {}),
      ...(manifest !== undefined ? { manifest } : {}),
      page: { path: basename(prepared.entry), html: page?.html ?? prepared.compiledHtml },
    });

    const url = `${server.url}${basename(prepared.entry)}`;
    const onRetry = (cause: ClassifiedFailure): void =>
      progress("capture", 25, `repetindo a captura uma vez (${cause.code}): ${cause.message.split(/\r?\n/)[0]}`);
    let layerCapture: LayeredCapture | undefined;
    try {
      if (page !== undefined) {
        progress("capture", 25, "captura da camada HTML");
        layerCapture = await retryOnceIfTransient(() => {
          throwIfCanceled(signal, "capture");
          return captureLayers({
            server, url, viewport, fps, total: totalFrames, workers, gpu,
            sparse: !page.scripted, directory: layersDir, ...signalOption,
            onScan: (scanned) => progress("capture", 25 + Math.floor(scanned / totalFrames * 50), `${scanned}/${totalFrames} frames analisados`),
          });
        }, onRetry);
      } else encoding = await retryOnceIfTransient(
        () => {
          // O retry de falha transitória nunca recomeça uma captura já cancelada; cada tentativa sobe um FFmpeg novo.
          throwIfCanceled(signal, "capture");
          return encodeWhileCapturing({
            ffmpeg,
            args: buildFramePipeArgs({ fps, codec, preset, outPath: videoPath }),
            total: totalFrames,
            maxBuffered: reorderWindow(workers),
            ...signalOption,
            capture: (deliver) =>
              captureFramesInParallel({
                url,
                viewport,
                gpu,
                fps,
                frames: [...Array(totalFrames).keys()],
                workers,
                serverFailures: server.failures,
                onFrame: async (frame, png) => {
                  // Lançar aqui derruba o worker; o `finally` do captureFramesInParallel fecha as sessões do Chrome.
                  throwIfCanceled(signal, "capture");
                  if (keepFrames) await writeFile(join(framesDir, `frame_${String(frame + 1).padStart(6, "0")}.png`), png);
                  await deliver(frame, png);
                },
              }),
          });
        },
        // A repetição é única e dita a causa; se a segunda tentativa falhar, é a falha dela que sobe.
        onRetry,
        // Erro do FFmpeg (stderr pode citar "timeout") nunca é tratado como falha do browser.
        (error) => error instanceof PipeEncodeError,
      );
    } catch (error) {
      if (error instanceof LayeredError) throw new RenderError("E_LAYERED_UNSUPPORTED", "capture", error.message);
      throw motionFailure(error) ?? fontFailure(error) ?? browserFailure(error) ?? encodeFailure(error) ?? error;
    } finally {
      await server.close();
    }
    const hashes = layerCapture?.hashes ?? encoding!.captured;
    throwIfCanceled(signal, "capture");
    progress("capture", 75, layerCapture === undefined ? `${totalFrames} frames` : `${hashes.size} camadas para ${totalFrames} frames`);

    const audioInputs = audioClipsFor({ composition, entryDir, seconds });

    let audioPath: string | undefined;
    if (audioInputs.length > 0) {
      throwIfCanceled(signal, "audio");
      progress("audio", 78, `${audioInputs.length} faixa(s)`);
      // WebM: o mix já sai em Opus (o true peak é medido no stream que vai ao arquivo; o mux só copia). MP4: AAC.
      audioPath = join(workDir, container === "webm" ? "audio.opus" : "audio.m4a");
      try {
        const mixed = await mixAudio({
          ffmpeg,
          clips: audioInputs,
          totalSeconds: seconds,
          outPath: audioPath,
          format: container === "webm" ? "opus" : "aac",
          ...(options.loudness === false ? { loudness: false } : {}),
          ...signalOption,
        });
        warnings.push(...mixed.warnings);
      } catch (error) {
        // O código e o hint do mix (E_AUDIO_TRUE_PEAK) chegam ao render --json, sem virar E_INTERNAL.
        if (error instanceof AudioTruePeakError) throw new RenderError(error.code, "audio", `${error.message} (${error.hint})`);
        throw error;
      }
    }

    // O encode já vinha andando junto da captura: aqui só falta a cauda depois do último frame.
    throwIfCanceled(signal, "encode");
    progress("encode", 80);
    try {
      if (layered === undefined || layerCapture === undefined) await encoding!.encoded;
      else {
        let vram = false;
        if (options.vram === true) {
          const reason = codec !== "av1" || gpu === "software"
            ? "a opção requer AV1 e GPU auto ou hardware"
            : await probeLayeredVram(ffmpeg, layered, viewport, fps, preset, layersDir, signal);
          if (reason === undefined) {
            vram = true;
            progress("encode", 80, "Vulkan em VRAM da decodificação ao encode");
          } else {
            const warning = `VRAM indisponível: ${reason}. Usando o render por camadas.`;
            warnings.push(warning);
            progress("encode", 80, warning);
          }
        }
        let av1Nvenc = false;
        if (!vram && codec === "av1" && gpu !== "software") {
          try {
            await run(ffmpeg, [
              "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=s=${viewport.width}x${viewport.height}`,
              "-frames:v", "1", "-c:v", "av1_nvenc", "-f", "null", "-",
            ], { timeout: 15_000, ...signalOption });
            av1Nvenc = true;
          } catch {
            throwIfCanceled(signal, "encode");
            warnings.push("AV1 NVENC indisponível no render por camadas: usando libsvtav1");
          }
        }
        await encodeLayers(ffmpeg, {
          capture: layerCapture, sources: layered, viewport, fps, directory: layersDir,
          outPath: videoPath, codec, preset, av1Nvenc, vram, warnings, ...signalOption,
          onNvdec: (count) => progress("encode", 80, `NVDEC em ${count} fonte(s)`),
        });
      }
    } catch (error) {
      if (error instanceof LayeredError) throw new RenderError("E_LAYERED_UNSUPPORTED", "encode", error.message);
      if (layerCapture !== undefined) {
        throw new RenderError("E_ENCODE", "encode", `a composição por camadas falhou no FFmpeg: ${(error as Error).message}`);
      }
      throw encodeFailure(error) ?? error;
    }
    progress("encode", 90);

    throwIfCanceled(signal, "assemble");
    progress("assemble", 92);
    await mkdir(dirname(outPath), { recursive: true });
    const mux = buildMuxArgs(codec);
    const assembleArgs =
      audioPath === undefined
        ? ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-c", "copy", ...mux, "-y", partialPath]
        : ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-i", audioPath, "-c:v", "copy", "-c:a", "copy", ...mux, "-y", partialPath];
    try {
      await run(ffmpeg, assembleArgs, { maxBuffer: 64 << 20, ...signalOption });
      // Última chance de cancelar: depois do rename o arquivo final existe e o export está feito.
      throwIfCanceled(signal, "assemble");
      await publishOutput(partialPath, outPath);
    } catch (error) {
      // Falha ou cancelamento nunca deixa `.partial` nem toca num arquivo antigo; o erro segue para o chamador.
      // force:true: o .partial pode nem ter sido criado. Falha de remoção vai ao stderr e não troca o erro original.
      const removal = await removeTree(partialPath, { recursive: false, missingOk: true });
      if (removal !== undefined) warnCleanup(partialPath, removal);
      throw error;
    }
    progress("assemble", 100, outPath);

    completed = true;
    return {
      outPath,
      frames: totalFrames,
      durationSeconds: seconds,
      codec,
      preset,
      hasAudio: audioPath !== undefined,
      warnings,
      hashes,
      workDir,
    };
  } finally {
    await encoding?.kill();
    // Chegou ao finally: o handler de exit (só para Ctrl+C) acabou. Com --keep ele também não pode ficar, senão apaga
    // a pasta guardada quando o processo sai.
    process.removeListener("exit", cleanup);
    if (options.keepWorkDir !== true) {
      // O render já terminou: falha ao remover o workDir não derruba o resultado. Com sucesso vira item em
      // `warnings` (o mesmo array devolvido); com o corpo falho vai ao stderr e o erro original sobe.
      const removal = await removeTree(workDir);
      if (removal !== undefined) {
        if (completed) warnings.push(cleanupWarning(workDir, removal));
        else warnCleanup(workDir, removal);
      }
    }
  }
}
