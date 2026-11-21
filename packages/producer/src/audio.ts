// FrankFrames — proprietário. Ver LICENSE na raiz.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const MIN_RATE = 0.1;
const MAX_RATE = 10;

/** `atempo` aceita 0.5–2 por instância: encadeia para cobrir a faixa do contrato. */
function atempoChain(rate: number): string[] {
  const chain: string[] = [];
  let remaining = rate;
  while (remaining > 2) {
    chain.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    chain.push("atempo=0.5");
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 1e-9) chain.push(`atempo=${fmt(remaining)}`);
  return chain;
}

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
  /** Automação de volume: pontos em segundos e ganho linear. */
  keyframes?: Array<{ time: number; volume: number }>;
  /** Papel no mix: música abaixa sob voz. */
  role?: "voice" | "music" | "sfx";
}

export interface DuckOptions {
  /** Quanto a música abaixa sob a voz, em dB. */
  gainDb: number;
  /** Rampa de entrada, em segundos. */
  attack: number;
  /** Rampa de saída, em segundos. */
  release: number;
}

export const DEFAULT_DUCK: DuckOptions = { gainDb: 9, attack: 0.08, release: 0.25 };

export interface Loudness {
  targetLufs: number;
  truePeakDbtp: number;
  range: number;
}

/** Padrão de entrega para plataformas de vídeo. */
export const DELIVERY_LOUDNESS: Loudness = { targetLufs: -14, truePeakDbtp: -1, range: 11 };

export interface MeasuredLoudness {
  i: string;
  tp: string;
  lra: string;
  thresh: string;
  offset: string;
}

export interface GraphOptions {
  duck?: DuckOptions | false;
  loudness?: Loudness;
  measured?: MeasuredLoudness;
}

/** Monta `if(lt(t,...))` encadeado a partir de pontos ordenados (t, ganho). */
function piecewiseExpression(points: Array<[number, number]>): string {
  let expression = String(points[points.length - 1]![1]);
  for (let i = points.length - 1; i >= 1; i -= 1) {
    const [t0, g0] = points[i - 1]!;
    const [t1, g1] = points[i]!;
    if (t1 === t0) continue;
    const slope = (g1 - g0) / (t1 - t0);
    expression = `if(lt(t,${fmt(t1)}),${fmt(g0)}+${fmt(slope)}*(t-${fmt(t0)}),${expression})`;
  }
  return expression;
}

export const MAX_VOLUME_SEGMENTS = 32;

/**
 * Automação de volume por keyframes. Acima de `MAX_VOLUME_SEGMENTS` pontos
 * úteis, reamostra e avisa — o avaliador de expressões do FFmpeg tem limite.
 */
export function keyframeExpression(
  points: Array<{ time: number; volume: number }>,
  duration: number,
): { expression: string | null; segments: number; dropped: number } {
  const inner = points
    .filter((point) => point.time > 0 && point.time < duration)
    .sort((a, b) => a.time - b.time);
  if (inner.length === 0 && points.length === 0) return { expression: null, segments: 0, dropped: 0 };

  const first = points.reduce((min, point) => (point.time < min.time ? point : min), points[0]!);
  const last = points.reduce((max, point) => (point.time > max.time ? point : max), points[0]!);
  const ordered: Array<[number, number]> = [[0, first.volume], ...inner.map((point): [number, number] => [point.time, point.volume]), [duration, last.volume]];

  if (ordered.length <= MAX_VOLUME_SEGMENTS) {
    return { expression: piecewiseExpression(ordered), segments: ordered.length - 1, dropped: 0 };
  }

  const step = (ordered.length - 1) / (MAX_VOLUME_SEGMENTS - 1);
  const sampled: Array<[number, number]> = [];
  for (let i = 0; i < MAX_VOLUME_SEGMENTS; i += 1) sampled.push(ordered[Math.min(ordered.length - 1, Math.round(i * step))]!);
  return { expression: piecewiseExpression(sampled), segments: sampled.length - 1, dropped: ordered.length - sampled.length };
}

export function loudnormFilter(loudness: Loudness, measured?: MeasuredLoudness): string {
  const base = `loudnorm=I=${loudness.targetLufs}:TP=${loudness.truePeakDbtp}:LRA=${loudness.range}`;
  return measured === undefined
    ? base
    : `${base}:measured_I=${measured.i}:measured_TP=${measured.tp}:measured_LRA=${measured.lra}:measured_thresh=${measured.thresh}:offset=${measured.offset}`;
}

/**
 * Envelope de ducking por janelas de voz, relativo ao início do clip de música.
 * `null` quando não há janela sobreposta (nada a abaixar).
 */
export function duckExpression(
  windows: Array<[number, number]>,
  clipStart: number,
  clipDuration: number,
  duck: DuckOptions,
): { expression: string | null; windows: number } {
  const gain = Number((10 ** (-duck.gainDb / 20)).toFixed(6));
  const points: Array<[number, number]> = [[0, 1]];
  let hits = 0;

  for (const [voiceStart, voiceEnd] of windows) {
    const start = Math.max(clipStart, voiceStart);
    const end = Math.min(clipStart + clipDuration, voiceEnd);
    if (end <= start) continue;
    hits++;
    const localStart = start - clipStart;
    const localEnd = end - clipStart;
    points.push([Math.max(0, localStart - duck.release), 1]);
    points.push([Math.max(0, localStart + duck.attack), gain]);
    points.push([Math.max(0, localEnd - duck.attack), gain]);
    points.push([Math.min(clipDuration, localEnd + duck.release), 1]);
  }

  if (hits === 0) return { expression: null, windows: 0 };
  points.sort((a, b) => a[0] - b[0]);

  let expression = "1";
  for (let i = points.length - 1; i >= 1; i -= 1) {
    const [t0, g0] = points[i - 1]!;
    const [t1, g1] = points[i]!;
    if (t1 === t0) continue;
    const slope = (g1 - g0) / (t1 - t0);
    expression = `if(lt(t,${fmt(t1)}),${fmt(g0)}+${fmt(slope)}*(t-${fmt(t0)}),${expression})`;
  }
  return { expression: `volume='${expression}':eval=frame`, windows: hits };
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
export function buildAudioGraph(
  clips: AudioClip[],
  totalSeconds: number,
  masterGain = 1,
  options: GraphOptions = {},
): AudioGraph {
  const warnings: string[] = [];
  const inputs: string[] = [];
  const lines: string[] = [];
  const duck = options.duck === false ? undefined : (options.duck ?? DEFAULT_DUCK);
  const voiceWindows = clips
    .filter((clip) => clip.role === "voice")
    .map((clip): [number, number] => [Math.max(0, clip.start), Math.max(0, clip.start + clip.duration)]);

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

    // `atrim` é no tempo da fonte: acelerar consome `duration * rate` segundos.
    const chain = [
      `atrim=start=${fmt(offset)}:duration=${fmt(duration * rate)}`,
      "asetpts=PTS-STARTPTS",
    ];
    chain.push(...atempoChain(rate));
    chain.push(`volume=${fmt(clip.volume)}`);

    if (clip.keyframes !== undefined && clip.keyframes.length > 0) {
      const automation = keyframeExpression(clip.keyframes, duration);
      if (automation.expression !== null) chain.push(`volume='${automation.expression}':eval=frame`);
      if (automation.dropped > 0) {
        warnings.push(
          `clip "${clip.clipId}": ${automation.dropped} keyframe(s) descartado(s) acima de ${MAX_VOLUME_SEGMENTS} segmentos`,
        );
      }
    }

    if (duck !== undefined && clip.role === "music" && voiceWindows.length > 0) {
      const applied = duckExpression(voiceWindows, Math.max(0, clip.start), duration, duck);
      if (applied.expression !== null) chain.push(applied.expression);
      if (applied.windows > 24) warnings.push(`clip "${clip.clipId}": ${applied.windows} janelas de ducking`);
    }

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
      `${labels}amix=inputs=${clips.length}:duration=longest:dropout_transition=0:normalize=0,volume=${fmt(masterGain)},atrim=0:${fmt(total)},asetpts=PTS-STARTPTS` +
        `${options.loudness === undefined ? "" : `,${loudnormFilter(options.loudness, options.measured)}`}[out]`,
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
  duck?: DuckOptions | false;
  /** `false` entrega o mix cru, sem normalizar. */
  loudness?: Loudness | false;
  /** `aac` (padrão, entrega) ou `wav` PCM 16 bits (preview: o navegador decodifica sem custo). */
  format?: AudioFormat;
  /** Cancela o FFmpeg em andamento. */
  signal?: AbortSignal;
}

export type AudioFormat = "aac" | "wav";

/** Argumentos de codec do mix final: o resto do grafo é idêntico entre render e preview. */
export function codecArgs(format: AudioFormat): string[] {
  return format === "wav" ? ["-c:a", "pcm_s16le"] : ["-c:a", "aac", "-b:a", "192k"];
}

/** Mede o mix com `loudnorm` em modo análise. `null` quando o FFmpeg não devolve o JSON. */
export async function measureLoudness(
  ffmpeg: string,
  file: string,
  signal?: AbortSignal,
): Promise<MeasuredLoudness | null> {
  const result = await run(ffmpeg, [
    "-hide_banner", "-nostats", "-i", file, "-af", "loudnorm=print_format=json", "-f", "null", "-",
  ], { maxBuffer: 16 << 20, ...(signal !== undefined ? { signal } : {}) }).catch((error: { stderr?: string; name?: string }) => {
    // Cancelamento não é "sem medição": sobe para quem pediu.
    if (signal?.aborted === true) throw error;
    return { stderr: error.stderr ?? "" };
  });
  const json = /\{[\s\S]*\}/.exec(result.stderr ?? "");
  if (!json) return null;
  try {
    const parsed = JSON.parse(json[0]) as Record<string, string>;
    return {
      i: parsed.input_i ?? "",
      tp: parsed.input_tp ?? "",
      lra: parsed.input_lra ?? "",
      thresh: parsed.input_thresh ?? "",
      offset: parsed.target_offset ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Silêncio digital: o `loudnorm` mede `-inf` e recusa o próprio resultado ("Result too large").
 * Só esse caso é tratado; medida ilegível ou outra falha continua falhando alto.
 */
export function isSilentMeasurement(measured: MeasuredLoudness): boolean {
  return /^-inf$/i.test(measured.i.trim());
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
  const loudness = options.loudness === false ? undefined : (options.loudness ?? DELIVERY_LOUDNESS);
  const initial = buildAudioGraph(options.clips, options.totalSeconds, options.masterGain ?? 1, {
    duck: options.duck,
  });

  const signalOption = options.signal !== undefined ? { signal: options.signal } : {};
  const workspace = await mkdtemp(join(tmpdir(), "ff-audio-"));
  const scriptOption = await scriptOptionFor(options.ffmpeg);
  try {
    let measured: MeasuredLoudness | undefined;
    let normalize = true;
    if (loudness !== undefined) {
      const analysis = join(workspace, "analysis.wav");
      const analysisFilter = join(workspace, "analysis.txt");
      await writeFile(analysisFilter, initial.filter, "utf8");
      await run(
        options.ffmpeg,
        [
          "-hide_banner", "-loglevel", "error",
          ...initial.inputs.flatMap((input) => ["-i", input]),
          scriptOption, analysisFilter,
          "-map", "[out]", "-vn", "-ac", "2", "-ar", String(sampleRate),
          "-c:a", "pcm_s16le", "-y", analysis,
        ],
        { maxBuffer: 16 << 20, ...signalOption },
      );
      measured = (await measureLoudness(options.ffmpeg, analysis, options.signal)) ?? undefined;
      if (measured === undefined) initial.warnings.push("loudness não medido; mix entregue sem normalização de dois passes");
      else if (isSilentMeasurement(measured)) {
        // Nada a normalizar: o mix sai como está, com o aviso explícito.
        initial.warnings.push("áudio silencioso: loudnorm não aplicado");
        measured = undefined;
        normalize = false;
      }
    }

    const final = buildAudioGraph(options.clips, options.totalSeconds, options.masterGain ?? 1, {
      duck: options.duck,
      ...(loudness !== undefined && normalize ? { loudness } : {}),
      ...(measured !== undefined ? { measured } : {}),
    });
    const scriptPath = join(workspace, "filter.txt");
    await writeFile(scriptPath, final.filter, "utf8");
    await run(
      options.ffmpeg,
      [
        "-hide_banner", "-loglevel", "error",
        ...final.inputs.flatMap((input) => ["-i", input]),
        scriptOption, scriptPath,
        "-map", "[out]", "-vn", "-ac", "2", "-ar", String(sampleRate),
        ...codecArgs(options.format ?? "aac"), "-y", options.outPath,
      ],
      { maxBuffer: 16 << 20, ...signalOption },
    );
    return { outPath: options.outPath, warnings: [...initial.warnings, ...final.warnings] };
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}
