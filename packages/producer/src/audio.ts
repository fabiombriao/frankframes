// FrankFrames — proprietário. Ver LICENSE na raiz.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const MIN_RATE = 0.5;
const MAX_RATE = 2;

export interface AudioClip {
  clipId: string;
  /** Caminho absoluto da fonte (wav/mp3/mp4). */
  file: string;
  /** Posição na timeline, em segundos. */
  start: number;
  /** Duração na timeline, em segundos. */
  duration: number;
  /** Quanto cortar do início da fonte, em segundos. */
  offset: number;
  /** 0.5 a 2.0; fora disso, clampar e registrar warning. */
  playbackRate: number;
  /** Ganho linear, 1 = 0 dB. */
  volume: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface AudioGraph {
  filter: string;
  inputs: string[];
  warnings: string[];
}

/** Números estáveis no filter graph, sem lixo de ponto flutuante. */
function fmt(value: number): string {
  return String(Number(value.toFixed(6)));
}

/**
 * Monta o filter_complex da mixagem: uma cadeia por clip e uma mistura final.
 * `inputs` é a ordem exata dos `-i` esperados pelo chamador.
 */
export function buildAudioGraph(clips: AudioClip[], totalSeconds: number, masterGain = 1): AudioGraph {
  const warnings: string[] = [];
  const inputs: string[] = [];
  const lines: string[] = [];

  clips.forEach((clip, index) => {
    inputs.push(clip.file);

    let rate = Number.isFinite(clip.playbackRate) ? clip.playbackRate : 1;
    if (rate < MIN_RATE || rate > MAX_RATE) {
      rate = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
      warnings.push(
        `clip "${clip.clipId}": playbackRate ${fmt(clip.playbackRate)} fora de ${MIN_RATE}–${MAX_RATE}; usando ${fmt(rate)}`,
      );
    }

    const duration = Math.max(0, clip.duration);
    const offset = Math.max(0, clip.offset);
    const delayMs = Math.round(Math.max(0, clip.start) * 1000);

    const chain = [
      `atrim=start=${fmt(offset)}:duration=${fmt(duration)}`,
      "asetpts=PTS-STARTPTS",
    ];
    if (rate !== 1) chain.push(`atempo=${fmt(rate)}`);
    chain.push(`volume=${fmt(clip.volume)}`);

    if (clip.fadeIn !== undefined && clip.fadeIn > 0) {
      chain.push(`afade=t=in:st=0:d=${fmt(clip.fadeIn)}`);
    }
    if (clip.fadeOut !== undefined && clip.fadeOut > 0) {
      let fadeStart = duration - clip.fadeOut;
      if (fadeStart < 0) {
        warnings.push(
          `clip "${clip.clipId}": fadeOut ${fmt(clip.fadeOut)}s maior que a duração ${fmt(duration)}s; st ajustado para 0`,
        );
        fadeStart = 0;
      }
      chain.push(`afade=t=out:st=${fmt(fadeStart)}:d=${fmt(clip.fadeOut)}`);
    }

    chain.push(`adelay=${delayMs}|${delayMs}`, "apad");
    lines.push(`[${index}:a]${chain.join(",")}[a${index}]`);
  });

  const total = Math.max(0, totalSeconds);
  if (clips.length === 0) {
    // Sem clips, ainda assim entregamos silêncio com a duração pedida.
    lines.push(`anullsrc=r=48000:cl=stereo,atrim=0:${fmt(total)},asetpts=PTS-STARTPTS[out]`);
  } else {
    const labels = clips.map((_, index) => `[a${index}]`).join("");
    lines.push(
      `${labels}amix=inputs=${clips.length}:duration=longest:dropout_transition=0:normalize=0,volume=${fmt(masterGain)},atrim=0:${fmt(total)},asetpts=PTS-STARTPTS[out]`,
    );
  }

  return { filter: lines.join(";"), inputs, warnings };
}

export interface MixOptions {
  ffmpeg: string;
  clips: AudioClip[];
  totalSeconds: number;
  outPath: string;
  masterGain?: number;
  sampleRate?: number;
}

/** FFmpeg >= 8 removeu `-filter_complex_script`; a grafia nova lê o mesmo arquivo. */
const scriptOptions = new Map<string, Promise<string>>();

function scriptOptionFor(ffmpeg: string): Promise<string> {
  const cached = scriptOptions.get(ffmpeg);
  if (cached) return cached;

  const probe = (async (): Promise<string> => {
    try {
      await run(
        ffmpeg,
        ["-hide_banner", "-loglevel", "error", "-filter_complex_script", join(tmpdir(), `ff-probe-${process.pid}.txt`)],
        { timeout: 15_000 },
      );
      return "-filter_complex_script";
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      return /Unrecognized option 'filter_complex_script'|Option not found/.test(stderr)
        ? "-/filter_complex"
        : "-filter_complex_script";
    }
  })();

  scriptOptions.set(ffmpeg, probe);
  probe.catch(() => scriptOptions.delete(ffmpeg));
  return probe;
}

/** Executa a mixagem. O filter graph vai por arquivo temporário, apagado sempre. */
export async function mixAudio(options: MixOptions): Promise<{ outPath: string; warnings: string[] }> {
  const sampleRate = options.sampleRate ?? 48000;
  const { filter, inputs, warnings } = buildAudioGraph(options.clips, options.totalSeconds, options.masterGain ?? 1);

  const workspace = await mkdtemp(join(tmpdir(), "ff-audio-"));
  const scriptPath = join(workspace, "filter.txt");
  try {
    await writeFile(scriptPath, filter, "utf8");
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      ...inputs.flatMap((input) => ["-i", input]),
      await scriptOptionFor(options.ffmpeg),
      scriptPath,
      "-map",
      "[out]",
      "-vn",
      "-ac",
      "2",
      "-ar",
      String(sampleRate),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-y",
      options.outPath,
    ];
    await run(options.ffmpeg, args, { maxBuffer: 16 << 20 });
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }

  return { outPath: options.outPath, warnings };
}
