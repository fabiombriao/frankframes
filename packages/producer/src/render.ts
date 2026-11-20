// FrankFrames — proprietário. Ver LICENSE na raiz.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadComposition } from "@frankframes/contract";
import type { Composition, Diagnostic, RawClip, ResolvedClip } from "@frankframes/contract";
import { buildFrameSequenceArgs, buildMuxArgs, containerFor } from "@frankframes/encode";
import type { Preset, VideoCodec } from "@frankframes/encode";
import { captureFramesInParallel, extractFrames, probeDuration, retryOnceIfTransient, startServer } from "@frankframes/engine";
import type { MediaManifest } from "@frankframes/engine";
import { annotateTiming, materializeClipIds, mergeSubCompositions } from "./compile.ts";
import { resolveFfmpeg } from "./ffmpeg.ts";
import { mixAudio } from "./audio.ts";
import type { AudioClip } from "./audio.ts";

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

export interface PrepareOptions {
  entry: string;
  ffmpeg?: string;
  ffprobe?: string;
  /** Diretório de trabalho; criado e devolvido ao chamador. */
  workDir?: string;
  onProgress?: (stage: RenderStage, percent: number, message?: string) => void;
}

export interface PreparedComposition {
  entry: string;
  entryDir: string;
  composition: Composition;
  /** HTML com sub-composições inlinadas e tempo anotado. */
  compiledHtml: string;
  mediaDir?: string;
  manifest?: MediaManifest;
  seconds: number;
  fps: { num: number; den: number };
  viewport: { width: number; height: number };
  totalFrames: number;
  warnings: string[];
  workDir: string;
  /** `true` quando o chamador criou o workDir e precisa removê-lo. */
  ownsWorkDir: boolean;
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
  const warnings: string[] = [];

  progress("compile", 5, entry);
  const source = await readFile(entry, "utf8");
  const merged = await mergeSubCompositions(source, entryDir, entry);
  warnings.push(...merged.warnings);

  const materialized = materializeClipIds(merged.html);
  const parsed = loadComposition(materialized);
  if (!parsed.ok) {
    throw new RenderError(
      "E_CONTRACT",
      "compile",
      `contrato inválido: ${parsed.diagnostics.filter((d) => d.severity === "error").length} erro(s)`,
      parsed.diagnostics,
    );
  }

  progress("probe", 10);
  const flat: RawClip[] = [];
  probeRaw(parsed.clips, flat);
  const mediaDurations: Record<string, number> = {};
  for (const clip of flat) {
    if (clip.mediaSrc === undefined) continue;
    if (clip.tag !== "video" && clip.tag !== "audio") continue;
    if (clip.authoredDuration !== undefined) continue;
    const file = resolve(entryDir, clip.mediaSrc);
    try {
      mediaDurations[clip.id] = await probeDuration(ffprobe, file);
    } catch (error) {
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

  const compiled = annotateTiming(materialized, composition);
  if (compiled.annotations === 0) warnings.push("nenhum clip anotado: a composição não tem clips temporizados");

  const seconds = composition.duration.seconds;
  const fps = composition.fps;
  const viewport = { width: composition.width ?? 1920, height: composition.height ?? 1080 };
  const ownsWorkDir = options.workDir === undefined;
  const workDir = options.workDir ?? (await mkdtemp(join(tmpdir(), "ff-render-")));

  let mediaDir: string | undefined;
  let manifest: MediaManifest | undefined;
  try {
  const videos = timedClips(composition).filter((item) => item.clip.tag === "video" && item.clip.mediaSrc !== undefined);
  if (videos.length > 0) {
    progress("extract", 20);
    mediaDir = join(workDir, "media");
    manifest = { fps, clips: [] };
    for (const { clip, start } of videos) {
      const dir = `${clip.id.replace(/[^A-Za-z0-9_-]/g, "_")}_${createHash("sha256").update(clip.id).digest("hex").slice(0, 6)}`;
      const clipDuration = clip.authoredDuration ?? Math.max(0, seconds - start);
      const { frameCount } = await extractFrames({
        ffmpeg,
        input: resolve(entryDir, clip.mediaSrc!),
        outDir: join(mediaDir, dir),
        fps,
        offset: clip.offset,
        duration: clipDuration * clip.playbackRate,
      });
      manifest.clips.push({
        clipId: clip.id,
        start,
        duration: clipDuration,
        offset: clip.offset,
        playbackRate: clip.playbackRate,
        dir,
        frameCount,
      });
    }
  }

  } catch (error) {
    if (ownsWorkDir) await rm(workDir, { recursive: true, force: true });
    throw error;
  }

  return {
    entry,
    entryDir,
    composition,
    compiledHtml: compiled.html,
    ...(mediaDir !== undefined ? { mediaDir } : {}),
    ...(manifest !== undefined ? { manifest } : {}),
    seconds,
    fps,
    viewport,
    totalFrames: frameCountFor(seconds, fps),
    warnings,
    workDir,
    ownsWorkDir,
  };
}

export interface RenderOptions {
  entry: string;
  outPath: string;
  /** `auto` (padrão) usa GPU quando existe; `software` garante pixel entre máquinas. */
  gpu?: "auto" | "software" | "hardware";
  ffmpeg?: string;
  ffprobe?: string;
  codec?: VideoCodec;
  preset?: Preset;
  workers?: number;
  keepWorkDir?: boolean;
  onProgress?: (stage: RenderStage, percent: number, message?: string) => void;
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
  const codec: VideoCodec = options.codec ?? "av1";
  const preset: Preset = options.preset ?? "standard";
  const progress = options.onProgress ?? (() => {});

  const prepared = await prepare({
    entry: options.entry,
    ...(options.ffmpeg !== undefined ? { ffmpeg: options.ffmpeg } : {}),
    ...(options.ffprobe !== undefined ? { ffprobe: options.ffprobe } : {}),
    onProgress: progress,
  });
  const pair = await resolveFfmpeg();
  const ffmpeg = options.ffmpeg ?? pair.ffmpeg;
  const { workDir, totalFrames, fps, viewport, seconds, entryDir, composition, warnings } = prepared;

  // Composição com vídeo fora de banda usa uma camada <img>; o compositor de GPU
  // atrasa a textura de forma não determinística. Nesses casos, software.
  const requested = options.gpu ?? "auto";
  const gpu =
    requested === "hardware" || prepared.manifest === undefined ? requested : "software";
  if (requested === "auto" && gpu === "software" && prepared.manifest !== undefined) {
    warnings.push("composição com vídeo: render forçado em software para manter o frame determinístico");
  }

  // Ctrl+C não executa `finally`: o handler de exit remove o diretório de frames.
  const cleanup = (): void => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* já removido */
    }
  };
  process.once("exit", cleanup);

  try {
    progress("capture", 25);
    const server = await startServer(entryDir, {
      ...(prepared.mediaDir !== undefined ? { mediaRoot: prepared.mediaDir } : {}),
      ...(prepared.manifest !== undefined ? { manifest: prepared.manifest } : {}),
      page: { path: basename(prepared.entry), html: prepared.compiledHtml },
    });

    const framesDir = join(workDir, "frames");
    await mkdir(framesDir, { recursive: true });
    const frames = [...Array(totalFrames).keys()];
    let hashes: Map<number, string>;
    try {
      hashes = await retryOnceIfTransient(() =>
        captureFramesInParallel({
          url: `${server.url}${basename(prepared.entry)}`,
          viewport,
          gpu,
          fps,
          frames,
          ...(options.workers !== undefined ? { workers: options.workers } : {}),
          onFrame: async (frame, png) => {
            await writeFile(join(framesDir, `frame_${String(frame + 1).padStart(6, "0")}.png`), png);
          },
        }),
      );
    } finally {
      await server.close();
    }
    progress("capture", 75, `${totalFrames} frames`);

    const audioInputs: AudioClip[] = [];
    for (const { clip, start } of timedClips(composition)) {
      if (clip.mediaSrc === undefined || clip.hasAudio !== true) continue;
      audioInputs.push({
        clipId: clip.id,
        file: resolve(entryDir, clip.mediaSrc),
        start,
        duration: clip.authoredDuration ?? Math.max(0, seconds - start),
        offset: clip.offset,
        playbackRate: clip.playbackRate,
        volume: clip.volume ?? 1,
        ...(clip.audioRole !== undefined ? { role: clip.audioRole } : {}),
        ...(clip.keyframes !== undefined ? { keyframes: clip.keyframes } : {}),
        ...(clip.fadeIn !== undefined ? { fadeIn: clip.fadeIn } : {}),
        ...(clip.fadeOut !== undefined ? { fadeOut: clip.fadeOut } : {}),
      });
    }

    let audioPath: string | undefined;
    if (audioInputs.length > 0) {
      progress("audio", 78, `${audioInputs.length} faixa(s)`);
      audioPath = join(workDir, "audio.m4a");
      const mixed = await mixAudio({ ffmpeg, clips: audioInputs, totalSeconds: seconds, outPath: audioPath });
      warnings.push(...mixed.warnings);
    }

    progress("encode", 80);
    const container = containerFor(codec);
    const videoPath = join(workDir, container === "webm" ? "video.webm" : "video.mp4");
    await run(ffmpeg, buildFrameSequenceArgs({ framesDir, fps, codec, preset, outPath: videoPath }), { maxBuffer: 64 << 20 });
    progress("encode", 90);

    progress("assemble", 92);
    const outPath = resolve(options.outPath);
    await mkdir(dirname(outPath), { recursive: true });
    const mux = buildMuxArgs(codec);
    const assembleArgs =
      audioPath === undefined
        ? ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-c", "copy", ...mux, "-y", outPath]
        : container === "webm"
          ? ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-i", audioPath, "-c:v", "copy", "-c:a", "libopus", "-b:a", "128k", ...mux, "-y", outPath]
          : ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-i", audioPath, "-c:v", "copy", "-c:a", "copy", ...mux, "-y", outPath];
    await run(ffmpeg, assembleArgs, { maxBuffer: 64 << 20 });
    progress("assemble", 100, outPath);

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
    if (options.keepWorkDir !== true && prepared.ownsWorkDir) {
      process.removeListener("exit", cleanup);
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
