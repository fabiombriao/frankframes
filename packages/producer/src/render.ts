// FrankFrames — proprietário. Ver LICENSE na raiz.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadComposition } from "@frankframes/contract";
import type { Diagnostic } from "@frankframes/contract";
import { buildFrameSequenceArgs, buildMuxArgs, containerFor } from "@frankframes/encode";
import type { Preset, VideoCodec } from "@frankframes/encode";
import { captureFramesInParallel, extractFrames, probeDuration, retryOnceIfTransient, startServer } from "@frankframes/engine";
import type { MediaManifest, StaticServer } from "@frankframes/engine";
import { mixAudio } from "./audio.ts";
import type { AudioClip } from "./audio.ts";

const run = promisify(execFile);

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

export interface RenderOptions {
  entry: string;
  outPath: string;
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
  const entry = resolve(options.entry);
  const entryDir = dirname(entry);
  const ffmpeg = options.ffmpeg ?? "ffmpeg";
  const ffprobe = options.ffprobe ?? "ffprobe";
  const codec: VideoCodec = options.codec ?? "av1";
  const preset: Preset = options.preset ?? "standard";
  const progress = options.onProgress ?? (() => {});
  const warnings: string[] = [];

  progress("compile", 5, entry);
  const html = await readFile(entry, "utf8");
  const parsed = loadComposition(html);
  if (!parsed.ok) {
    throw new RenderError("E_CONTRACT", "compile", `contrato inválido: ${parsed.diagnostics.filter((d) => d.severity === "error").length} erro(s)`, parsed.diagnostics);
  }

  progress("probe", 10);
  const mediaDurations: Record<string, number> = {};
  for (const clip of parsed.clips) {
    if (clip.mediaSrc === undefined) continue;
    if (clip.tag !== "video" && clip.tag !== "audio") continue;
    if (clip.authoredDuration !== undefined) continue;
    const file = resolve(entryDir, clip.mediaSrc!);
    try {
      mediaDurations[clip.id] = await probeDuration(ffprobe, file);
    } catch (error) {
      throw new RenderError("E_MEDIA_PROBE", "probe", `não foi possível ler ${file}: ${(error as Error).message}`);
    }
  }

  const composition = loadComposition(html, { mediaDurations });
  if (!composition.ok) {
    throw new RenderError("E_CONTRACT", "probe", "contrato inválido após ajustar a duração da mídia", composition.diagnostics);
  }
  if (composition.duration.kind === "unresolved") {
    throw new RenderError("E_DURATION", "probe", `duração não resolvida (${composition.duration.reason})`, composition.diagnostics);
  }

  const seconds = composition.duration.seconds;
  const fps = composition.fps;
  const viewport = { width: composition.width ?? 1920, height: composition.height ?? 1080 };
  const totalFrames = Math.max(1, Math.round((seconds * fps.num) / fps.den));
  const workDir = await mkdtemp(join(tmpdir(), "ff-render-"));
  let started: StaticServer | undefined;

  try {
    progress("extract", 20);
    const mediaDir = join(workDir, "media");
    const manifest: MediaManifest = { fps, clips: [] };
    for (const clip of composition.clips) {
      if (clip.tag !== "video" || clip.mediaSrc === undefined) continue;
      if (clip.start === undefined) continue;
      const dir = clip.id.replace(/[^A-Za-z0-9_.-]/g, "_");
      const clipDuration = clip.authoredDuration ?? Math.max(0, seconds - clip.start);
      const { frameCount } = await extractFrames({
        ffmpeg,
        input: resolve(entryDir, clip.mediaSrc),
        outDir: join(mediaDir, dir),
        fps,
        offset: clip.offset,
        duration: clipDuration * clip.playbackRate,
      });
      manifest.clips.push({
        clipId: clip.id,
        start: clip.start,
        duration: clipDuration,
        offset: clip.offset,
        playbackRate: clip.playbackRate,
        dir,
        frameCount,
      });
    }

    progress("capture", 25);
    const server = await startServer(entryDir, {
      mediaRoot: manifest.clips.length > 0 ? mediaDir : undefined,
      manifest: manifest.clips.length > 0 ? manifest : undefined,
    });
    started = server;

    const framesDir = join(workDir, "frames");
    await mkdir(framesDir, { recursive: true });
    const frames = [...Array(totalFrames).keys()];
    const hashes = await retryOnceIfTransient(() => captureFramesInParallel({
      url: `${server.url}${basename(entry)}`,
      viewport,
      gpu: "auto",
      fps,
      frames,
      ...(options.workers !== undefined ? { workers: options.workers } : {}),
      onFrame: async (frame, png) => {
        await writeFile(join(framesDir, `frame_${String(frame + 1).padStart(6, "0")}.png`), png);
      },
    }));

    await server.close();
    started = undefined;
    progress("capture", 75, `${totalFrames} frames`);

    const audioInputs: AudioClip[] = [];
    for (const clip of composition.clips) {
      if (clip.mediaSrc === undefined || clip.hasAudio !== true) continue;
      if (clip.start === undefined) continue;
      audioInputs.push({
        clipId: clip.id,
        file: resolve(entryDir, clip.mediaSrc),
        start: clip.start,
        duration: clip.authoredDuration ?? Math.max(0, seconds - clip.start),
        offset: clip.offset,
        playbackRate: clip.playbackRate,
        volume: clip.volume ?? 1,
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
    await run(
      ffmpeg,
      buildFrameSequenceArgs({ framesDir, fps, codec, preset, outPath: videoPath }),
      { maxBuffer: 64 << 20 },
    );
    progress("encode", 90);

    progress("assemble", 92);
    const outPath = resolve(options.outPath);
    await mkdir(dirname(outPath), { recursive: true });
    const mux = buildMuxArgs(codec);
    const assembleArgs =
      audioPath === undefined
        ? ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-c", "copy", ...mux, "-y", outPath]
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
    if (started) await started.close();
    if (options.keepWorkDir !== true) await rm(workDir, { recursive: true, force: true });
  }
}
