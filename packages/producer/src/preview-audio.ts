// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { removeOrWarn } from "@frankframes/engine";
import { DEFAULT_DUCK, DELIVERY_LOUDNESS, mixAudio } from "./audio.ts";
import type { AudioClip } from "./audio.ts";
import { timedClips } from "./render.ts";
import type { PreparedComposition } from "./render.ts";

/** Acima disto o preview não baixa o mix (WAV 48 kHz decodificado ≈ 23 MB por minuto no navegador). */
export const PREVIEW_AUDIO_MAX_SECONDS = 20 * 60;

/** O que o preview precisa de uma composição já preparada. */
export type PreviewSource = Pick<PreparedComposition, "composition" | "entryDir" | "seconds">;

/** Código do mix de áudio do preview do Studio (entra no `docs/reference/diagnostics.md`). */
export const PREVIEW_AUDIO_ERROR_CODES = ["E_PREVIEW_AUDIO"] as const;

export class PreviewAudioError extends Error {
  readonly code: (typeof PREVIEW_AUDIO_ERROR_CODES)[number] = "E_PREVIEW_AUDIO";
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = "PreviewAudioError";
    this.hint = hint;
  }
}

/** Faixas de áudio da composição, as mesmas para o render e para o preview. */
export function audioClipsFor(prepared: PreviewSource): AudioClip[] {
  const clips: AudioClip[] = [];
  for (const { clip, start } of timedClips(prepared.composition)) {
    if (clip.mediaSrc === undefined || clip.hasAudio !== true) continue;
    clips.push({
      clipId: clip.id,
      file: resolve(prepared.entryDir, clip.mediaSrc),
      start,
      duration: clip.authoredDuration ?? Math.max(0, prepared.seconds - start),
      offset: clip.offset,
      playbackRate: clip.playbackRate,
      volume: clip.volume ?? 1,
      ...(clip.audioRole !== undefined ? { role: clip.audioRole } : {}),
      ...(clip.keyframes !== undefined ? { keyframes: clip.keyframes } : {}),
      ...(clip.fadeIn !== undefined ? { fadeIn: clip.fadeIn } : {}),
      ...(clip.fadeOut !== undefined ? { fadeOut: clip.fadeOut } : {}),
    });
  }
  return clips;
}

export interface FileStat {
  size: number;
  mtimeMs: number;
}

/** Chave do mix: só o que entra no grafo. Editar texto ou layout não a muda. */
export function previewAudioKey(clips: AudioClip[], totalSeconds: number, stats: Record<string, FileStat>): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, clips, totalSeconds, stats, duck: DEFAULT_DUCK, loudness: DELIVERY_LOUDNESS }))
    .digest("hex");
}

export interface PreviewAudioOptions {
  prepared: PreviewSource;
  ffmpeg: string;
  /** Normalmente `assetPath("cache", "preview-audio")`. */
  cacheDir: string;
  signal?: AbortSignal;
}

export interface PreviewAudioMix {
  key: string;
  file: string;
  /** `true` quando o WAV já existia (nenhum FFmpeg rodou). */
  cached: boolean;
  warnings: string[];
}

/** Composição longa demais: sem mix, com o motivo para a barra do preview. */
export interface PreviewAudioDisabled {
  disabled: string;
}

async function statOrNull(file: string): Promise<FileStat | null> {
  try {
    const info = await stat(file);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Mixa o áudio da composição em WAV com o mesmo grafo do render e guarda em cache por chave.
 * `null` quando não há faixa de áudio. Falha com `PreviewAudioError`, nunca em silêncio.
 */
export async function renderPreviewAudio(
  options: PreviewAudioOptions,
): Promise<PreviewAudioMix | PreviewAudioDisabled | null> {
  const clips = audioClipsFor(options.prepared);
  if (clips.length === 0) return null;
  if (options.prepared.seconds > PREVIEW_AUDIO_MAX_SECONDS) {
    return { disabled: "áudio do preview desligado acima de 20 min" };
  }

  const stats: Record<string, FileStat> = {};
  for (const clip of clips) {
    if (stats[clip.file] !== undefined) continue;
    let info: FileStat | null;
    try {
      info = await statOrNull(clip.file);
    } catch (error) {
      throw new PreviewAudioError(
        `não foi possível ler ${relative(options.prepared.entryDir, clip.file)}: ${(error as Error).message}`,
        "confira as permissões do arquivo",
      );
    }
    if (info === null) {
      throw new PreviewAudioError(
        `arquivo de áudio não encontrado: ${relative(options.prepared.entryDir, clip.file)} (clip "${clip.clipId}")`,
        "confira o src do clip e se o arquivo existe ao lado da composição",
      );
    }
    stats[clip.file] = info;
  }

  const key = previewAudioKey(clips, options.prepared.seconds, stats);
  const file = join(options.cacheDir, `${key}.wav`);
  if ((await statOrNull(file)) !== null) return { key, file, cached: true, warnings: [] };

  await mkdir(options.cacheDir, { recursive: true });
  // Arquivo temporário por chamada: dois carregamentos simultâneos não se pisam.
  const partial = join(options.cacheDir, `${key}.tmp-${process.pid}-${randomUUID().slice(0, 8)}.wav`);
  try {
    const mixed = await mixAudio({
      ffmpeg: options.ffmpeg,
      clips,
      totalSeconds: options.prepared.seconds,
      outPath: partial,
      format: "wav",
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    await rename(partial, file);
    return { key, file, cached: false, warnings: mixed.warnings };
  } catch (error) {
    // missingOk: o mix pode ter falhado antes de criar o arquivo (ENOENT esperado). Outra falha de remoção vai ao
    // stderr e não troca o erro do mix.
    await removeOrWarn(partial, { recursive: false, missingOk: true });
    if (error instanceof PreviewAudioError) throw error;
    const cancelled = options.signal?.aborted === true;
    const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
    const reason = cancelled ? "mix cancelado" : (stderr.split("\n").at(-1) || (error as Error).message);
    throw new PreviewAudioError(
      `falha ao mixar o áudio do preview: ${reason}`,
      cancelled ? "o preview foi recarregado antes do mix terminar" : "rode `frankframes doctor` e confira se os arquivos de áudio abrem num player",
    );
  }
}
