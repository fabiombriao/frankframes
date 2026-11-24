// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Aceite de ponta a ponta com vídeo real (EDT-64). Fora do gate: precisa do vídeo do titular.
 *
 *   node scripts/accept-video.ts <final.mp4> --entry <index.html> --source <MOV> --spec <keyframes.json>
 *     [--captions <legendas.html>] [--out <aceite.json>] [--expected-seconds 30]
 *
 * As verificações (`checkDuration`, `checkLoudness`, `checkKeyframe`, `parseKeyframeSpec`) são funções puras;
 * as chamadas de FFmpeg ficam em `probeMedia`, `framePsnr` e no corredor `runAcceptance`.
 * Sai com 0 se tudo passar, 1 se alguma verificação falhar e 2 se o aceite nem chegou a rodar (E_ACCEPT_*).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { lintReport } from "../packages/cli/src/lint-report.ts";
import { measureLoudness } from "../packages/producer/src/audio.ts";
import type { MeasuredLoudness } from "../packages/producer/src/audio.ts";
import { resolveFfmpeg } from "../packages/producer/src/ffmpeg.ts";
import { inspectFrames } from "../packages/producer/src/frames.ts";
import { frameCountFor } from "../packages/producer/src/render.ts";

const run = promisify(execFile);

/** Códigos do aceite (scripts, fora do `diagnostics.md`). */
export const ACCEPT_ERROR_CODES = ["E_ACCEPT_ARGS", "E_ACCEPT_SPEC", "E_ACCEPT_INPUT", "E_ACCEPT_MEASURE", "E_ACCEPT_TOOL"] as const;
export type AcceptCode = (typeof ACCEPT_ERROR_CODES)[number];

/** Falha do aceite, com código estável e dica acionável. */
export class AcceptError extends Error {
  readonly code: AcceptCode;
  readonly hint: string;

  constructor(code: AcceptCode, message: string, hint: string) {
    super(message);
    this.name = "AcceptError";
    this.code = code;
    this.hint = hint;
  }
}

export interface Fps {
  num: number;
  den: number;
}

type Scalar = number | string | boolean | null;

/** Uma verificação do `aceite.json`: o que foi medido contra o que se esperava. */
export interface CheckResult {
  name: string;
  ok: boolean;
  medido: Record<string, Scalar>;
  esperado: Record<string, Scalar>;
}

/** Faixa de loudness integrado aceita na entrega (LUFS) e teto de true peak (dBTP). */
export const LUFS_MIN = -15;
export const LUFS_MAX = -13;
export const TRUE_PEAK_MAX = -0.9;
/** PSNR de frames idênticos é infinito; o relatório trunca em 100 dB para continuar sendo JSON. */
export const PSNR_CAP = 100;

const EPS = 1e-9;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;
/** Número finito vai como número; `-inf`/`NaN` vão como texto para sobreviver ao JSON. */
const scalar = (value: number): Scalar => (Number.isFinite(value) ? round3(value) : String(value));

function requireFinite(label: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new AcceptError("E_ACCEPT_INPUT", `${label} não é um número finito: ${String(value)}`, "confira a saída do ffprobe/lint; o aceite não adivinha valores");
  }
}

function requireFps(fps: Fps): void {
  if (!(Number.isInteger(fps.num) && fps.num > 0 && Number.isInteger(fps.den) && fps.den > 0)) {
    throw new AcceptError("E_ACCEPT_INPUT", `fps inválido: ${fps.num}/${fps.den}`, "use o fps da composição (lint --json) como fração de inteiros positivos");
  }
}

/** `diferença` cabe em um frame de `fps`? (com folga de ponto flutuante) */
const withinOneFrame = (difference: number, fps: Fps): boolean => Math.abs(difference) <= fps.den / fps.num + EPS;

// ---------------------------------------------------------------------------------------------
// Duração
// ---------------------------------------------------------------------------------------------

export interface DurationInput {
  /** `duration.seconds` do `lint --json` da entrada. */
  lintSeconds: number;
  /** `format=duration` do ffprobe do MP4. */
  mp4Seconds: number;
  /** `nb_frames` do stream de vídeo do MP4. */
  nbFrames: number;
  fps: Fps;
  /** Duração que o roteiro promete (30 s no A001). */
  expectedSeconds: number;
}

/** Três verificações: lint = esperado; MP4 = lint ± 1 frame; contagem de frames exata. */
export function checkDuration(input: DurationInput): CheckResult[] {
  requireFinite("lintSeconds", input.lintSeconds);
  requireFinite("mp4Seconds", input.mp4Seconds);
  requireFinite("expectedSeconds", input.expectedSeconds);
  requireFinite("nbFrames", input.nbFrames);
  requireFps(input.fps);

  const frameSeconds = input.fps.den / input.fps.num;
  const expectedFrames = frameCountFor(input.expectedSeconds, input.fps);
  return [
    {
      name: "duration.lint",
      ok: Math.abs(input.lintSeconds - input.expectedSeconds) <= 1e-3,
      medido: { seconds: scalar(input.lintSeconds) },
      esperado: { seconds: scalar(input.expectedSeconds), tolerance: 0.001 },
    },
    {
      name: "duration.mp4",
      ok: withinOneFrame(input.mp4Seconds - input.lintSeconds, input.fps),
      medido: { seconds: scalar(input.mp4Seconds), diff: scalar(input.mp4Seconds - input.lintSeconds) },
      esperado: { seconds: scalar(input.lintSeconds), tolerance: round3(frameSeconds) },
    },
    {
      name: "duration.frames",
      ok: input.nbFrames === expectedFrames,
      medido: { nbFrames: input.nbFrames },
      esperado: { nbFrames: expectedFrames },
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Loudness
// ---------------------------------------------------------------------------------------------

export interface LoudnessInput {
  /** Saída do `measureLoudness`; `null` quando o FFmpeg não devolveu o JSON. */
  measured: MeasuredLoudness | null;
  /** Duração do stream de áudio; `null` quando o MP4 não tem áudio. */
  audioSeconds: number | null;
  /** Duração do stream de vídeo. */
  videoSeconds: number;
  fps: Fps;
}

/** O `loudnorm` escreve `-inf` para silêncio: é medida válida (reprova a faixa), não ilegível. */
function readDecibels(label: string, text: string): number {
  const trimmed = text.trim();
  if (/^-inf$/i.test(trimmed)) return Number.NEGATIVE_INFINITY;
  const value = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(value)) {
    throw new AcceptError("E_ACCEPT_MEASURE", `${label} ilegível na medição de loudness: "${text}"`, "rode `ffmpeg -i <mp4> -af loudnorm=print_format=json -f null -` e confira a saída");
  }
  return value;
}

/** Áudio presente, `input_i` em [-15, -13] LUFS, `input_tp` ≤ -0,9 dBTP e duração do áudio = vídeo ± 1 frame. */
export function checkLoudness(input: LoudnessInput): CheckResult[] {
  requireFinite("videoSeconds", input.videoSeconds);
  requireFps(input.fps);
  if (input.audioSeconds === null) {
    return [{ name: "audio.stream", ok: false, medido: { present: false }, esperado: { present: true } }];
  }
  requireFinite("audioSeconds", input.audioSeconds);
  if (input.measured === null) {
    throw new AcceptError("E_ACCEPT_MEASURE", "o FFmpeg não devolveu a medição de loudness do MP4", "rode `ffmpeg -i <mp4> -af loudnorm=print_format=json -f null -` e confira a saída");
  }
  const lufs = readDecibels("input_i", input.measured.i);
  const peak = readDecibels("input_tp", input.measured.tp);
  return [
    { name: "audio.stream", ok: true, medido: { present: true }, esperado: { present: true } },
    {
      name: "audio.lufs",
      ok: lufs >= LUFS_MIN && lufs <= LUFS_MAX,
      medido: { lufs: scalar(lufs) },
      esperado: { min: LUFS_MIN, max: LUFS_MAX },
    },
    {
      name: "audio.truePeak",
      ok: peak <= TRUE_PEAK_MAX,
      medido: { dbtp: scalar(peak) },
      esperado: { max: TRUE_PEAK_MAX },
    },
    {
      name: "audio.duration",
      ok: withinOneFrame(input.audioSeconds - input.videoSeconds, input.fps),
      medido: { audioSeconds: scalar(input.audioSeconds), videoSeconds: scalar(input.videoSeconds) },
      esperado: { tolerance: round3(input.fps.den / input.fps.num) },
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Spec de frames-chave
// ---------------------------------------------------------------------------------------------

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameBox {
  width: number;
  height: number;
  /** Duração do MP4: todo `t` do spec tem de cair em [0, seconds). */
  seconds: number;
}

/** Instante da legenda: vem do `legendas.html` (início de um segmento), não do spec. */
export const CAPTION_WORD = "palavra";

const DEFAULT_MATCH_PSNR = 30;
const DEFAULT_ABSENT_PSNR = 30;
const DEFAULT_MOTION_PSNR = 40;
const DEFAULT_MOTION_FROM = 0.1;
const DEFAULT_MOTION_TO = 0.9;

export type KeyframeSpec =
  /** Frame do MP4 em `t` = frame da fonte em `source` (prova corte e `data-offset`). */
  | { kind: "match"; t: number; source: number; region: Region; minPsnr: number }
  /** O título anima: o frame em `from` difere do de `to` e o de `to` não é chapado. */
  | { kind: "motion-enter"; t: number; from: number; to: number; region: Region; maxPsnr: number }
  /** A camada está lá: a região difere da fonte no mesmo instante. */
  | { kind: "lower-third"; t: number; source: number | null; region: Region; maxPsnr: number }
  | { kind: "caption"; t: number | typeof CAPTION_WORD; source: number | null; region: Region; maxPsnr: number };

const SPEC_HINT = "veja scripts/accept/keyframes-a001.json como modelo";

function specError(index: number, message: string): AcceptError {
  return new AcceptError("E_ACCEPT_SPEC", `keyframes[${index}]: ${message}`, SPEC_HINT);
}

/** `"x,y,w,h"` em pixels inteiros, inteira dentro do quadro. */
export function parseRegion(text: unknown, frame: FrameBox, index = 0): Region {
  if (typeof text !== "string" || !/^\d+,\d+,\d+,\d+$/.test(text.trim())) {
    throw specError(index, `region deve ser "x,y,w,h" em pixels inteiros, veio ${JSON.stringify(text)}`);
  }
  const [x, y, w, h] = text.trim().split(",").map(Number) as [number, number, number, number];
  if (w <= 0 || h <= 0) throw specError(index, `region ${text} tem largura ou altura zero`);
  if (x + w > frame.width || y + h > frame.height) {
    throw specError(index, `region ${text} sai do quadro ${frame.width}x${frame.height}`);
  }
  return { x, y, w, h };
}

function numberField(entry: Record<string, unknown>, key: string, index: number, options: { min?: number; max?: number } = {}): number {
  const value = entry[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw specError(index, `${key} deve ser um número, veio ${JSON.stringify(value)}`);
  if (options.min !== undefined && value < options.min) throw specError(index, `${key}=${value} abaixo do mínimo ${options.min}`);
  if (options.max !== undefined && value >= options.max) throw specError(index, `${key}=${value} fora do vídeo (duração ${options.max} s; vale de 0 até antes do fim)`);
  return value;
}

function rejectUnknownKeys(entry: Record<string, unknown>, allowed: string[], index: number): void {
  const extra = Object.keys(entry).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw specError(index, `campo(s) desconhecido(s): ${extra.join(", ")} (aceitos: ${allowed.join(", ")})`);
}

/**
 * Valida o `keyframes.json` contra o quadro do MP4. Recusa região fora do quadro, instante fora do vídeo,
 * campo desconhecido (typo vira erro, não vira "passou") e spec sem como derivar o offset da fonte.
 */
export function parseKeyframeSpec(raw: unknown, frame: FrameBox): KeyframeSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AcceptError("E_ACCEPT_SPEC", "o spec de frames-chave deve ser uma lista não vazia", SPEC_HINT);
  }
  const whole: Region = { x: 0, y: 0, w: frame.width, h: frame.height };
  const specs = raw.map((item: unknown, index): KeyframeSpec => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw specError(index, "cada item deve ser um objeto");
    const entry = item as Record<string, unknown>;
    const expect = entry["expect"];
    const optionalNumber = (key: string, fallback: number, min?: number): number =>
      entry[key] === undefined ? fallback : numberField(entry, key, index, min === undefined ? {} : { min });

    if (expect === undefined) {
      rejectUnknownKeys(entry, ["t", "source", "region", "minPsnr"], index);
      return {
        kind: "match",
        t: numberField(entry, "t", index, { min: 0, max: frame.seconds }),
        source: numberField(entry, "source", index, { min: 0 }),
        region: parseRegion(entry["region"], frame, index),
        minPsnr: optionalNumber("minPsnr", DEFAULT_MATCH_PSNR, 0),
      };
    }
    if (expect === "motion-enter") {
      rejectUnknownKeys(entry, ["t", "expect", "region", "from", "to", "maxPsnr"], index);
      const t = numberField(entry, "t", index, { min: 0, max: frame.seconds });
      const from = optionalNumber("from", DEFAULT_MOTION_FROM, 0);
      const to = optionalNumber("to", DEFAULT_MOTION_TO, 0);
      if (!(from < to && to < frame.seconds)) throw specError(index, `from=${from} e to=${to} devem satisfazer from < to < ${frame.seconds}`);
      if (t < from || t > to) throw specError(index, `t=${t} deve ficar entre from=${from} e to=${to}`);
      return { kind: "motion-enter", t, from, to, region: entry["region"] === undefined ? whole : parseRegion(entry["region"], frame, index), maxPsnr: optionalNumber("maxPsnr", DEFAULT_MOTION_PSNR, 0) };
    }
    if (expect === "lower-third" || expect === "caption") {
      rejectUnknownKeys(entry, ["t", "expect", "region", "source", "maxPsnr"], index);
      const source = entry["source"] === undefined ? null : numberField(entry, "source", index, { min: 0 });
      const base = { source, region: parseRegion(entry["region"], frame, index), maxPsnr: optionalNumber("maxPsnr", DEFAULT_ABSENT_PSNR, 0) };
      if (expect === "caption" && entry["t"] === CAPTION_WORD) return { kind: "caption", t: CAPTION_WORD, ...base };
      const t = numberField(entry, "t", index, { min: 0, max: frame.seconds });
      return expect === "caption" ? { kind: "caption", t, ...base } : { kind: "lower-third", t, ...base };
    }
    throw specError(index, `expect desconhecido: ${JSON.stringify(expect)} (use motion-enter, lower-third ou caption; sem expect = comparação com a fonte)`);
  });

  const needsOffset = specs.some((spec) => (spec.kind === "lower-third" || spec.kind === "caption") && spec.source === null);
  if (needsOffset && !specs.some((spec) => spec.kind === "match")) {
    throw new AcceptError("E_ACCEPT_SPEC", "lower-third/legenda sem `source` e nenhum item de comparação para derivar o offset da fonte", "informe `source` no item ou inclua um item {t, source, region, minPsnr}");
  }
  return specs;
}

/** Offset fonte − MP4 (8 s no A001), do primeiro item de comparação. */
export function sourceOffsetOf(specs: KeyframeSpec[]): number | null {
  const first = specs.find((spec) => spec.kind === "match");
  return first?.kind === "match" ? first.source - first.t : null;
}

/** Início e duração de cada legenda do `legendas.html` (clips `.caption` gerados pelo `captions`). */
export function captionSegments(html: string): Array<{ start: number; duration: number }> {
  const found: Array<{ start: number; duration: number }> = [];
  for (const tag of html.matchAll(/<div\b[^>]*\bclass="caption"[^>]*>/g)) {
    const start = /\bdata-start="([\d.]+)"/.exec(tag[0]);
    const duration = /\bdata-duration="([\d.]+)"/.exec(tag[0]);
    if (start?.[1] !== undefined && duration?.[1] !== undefined) found.push({ start: Number(start[1]), duration: Number(duration[1]) });
  }
  if (found.length === 0) {
    throw new AcceptError("E_ACCEPT_INPUT", "o HTML de legendas não tem nenhum clip .caption com data-start e data-duration", "gere com `frankframes captions <audio> -o legendas.html`");
  }
  return found;
}

/** Folga depois do início da legenda: a entrada por palavra já terminou e o texto está na tela. */
export const CAPTION_SETTLE_SECONDS = 0.3;

/** Instante do 1º segmento de legenda em que a camada já está visível. */
export function captionInstant(segments: Array<{ start: number; duration: number }>): number {
  const first = segments[0];
  if (first === undefined) throw new AcceptError("E_ACCEPT_INPUT", "sem segmentos de legenda", "gere com `frankframes captions`");
  return round3(first.start + Math.min(CAPTION_SETTLE_SECONDS, first.duration / 2));
}

// ---------------------------------------------------------------------------------------------
// Verificação de um frame-chave (pura: recebe o que o FFmpeg mediu)
// ---------------------------------------------------------------------------------------------

export interface FrameMeasure {
  /**
   * `match`: PSNR contra a fonte no instante e nos frames vizinhos (vale o melhor).
   * demais: um único PSNR (camada × fonte, ou frame inicial × frame final do movimento).
   */
  psnrs: number[];
  /** `motion-enter`: o frame final do movimento é chapado? */
  uniformAtEnd?: boolean;
}

export function checkKeyframe(index: number, spec: KeyframeSpec, measure: FrameMeasure): CheckResult {
  if (measure.psnrs.length === 0) throw new AcceptError("E_ACCEPT_INPUT", `keyframes[${index}]: nenhum PSNR medido`, "o aceite mede ao menos um par de frames por item");
  for (const psnr of measure.psnrs) {
    if (Number.isNaN(psnr)) throw new AcceptError("E_ACCEPT_INPUT", `keyframes[${index}]: PSNR inválido`, "confira a saída do filtro psnr do FFmpeg");
  }
  const best = Math.max(...measure.psnrs);
  const name = `keyframe[${index}].${spec.kind}`;
  const at = { t: spec.t };

  if (spec.kind === "match") {
    return { name, ok: best >= spec.minPsnr, medido: { ...at, psnr: scalar(best), tried: measure.psnrs.length }, esperado: { source: spec.source, minPsnr: spec.minPsnr } };
  }
  if (spec.kind === "motion-enter") {
    if (measure.uniformAtEnd === undefined) throw new AcceptError("E_ACCEPT_INPUT", `keyframes[${index}]: falta a medição de frame chapado`, "meça `uniform` com inspectFrames no instante `to`");
    return {
      name,
      ok: best < spec.maxPsnr && !measure.uniformAtEnd,
      medido: { ...at, psnr: scalar(best), uniformAtEnd: measure.uniformAtEnd },
      esperado: { from: spec.from, to: spec.to, maxPsnr: spec.maxPsnr, uniformAtEnd: false },
    };
  }
  return { name, ok: best < spec.maxPsnr, medido: { ...at, psnr: scalar(best) }, esperado: { maxPsnr: spec.maxPsnr } };
}

// ---------------------------------------------------------------------------------------------
// FFmpeg/ffprobe (isolados; nada acima chama binário)
// ---------------------------------------------------------------------------------------------

async function runTool(binary: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(binary, args, { maxBuffer: 32 << 20, windowsHide: true });
    return { stdout, stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    const detail = failure.stderr !== undefined && failure.stderr.trim() !== "" ? failure.stderr.trim().split("\n").slice(-3).join(" | ") : failure.message;
    throw new AcceptError("E_ACCEPT_TOOL", `${binary} falhou: ${detail}`, "confira o arquivo de entrada e rode `node packages/cli/src/cli.ts doctor`");
  }
}

export interface MediaProbe {
  width: number;
  height: number;
  fps: Fps;
  /** `format=duration`. */
  formatSeconds: number;
  videoSeconds: number;
  /** `null` quando o contêiner não informa `nb_frames`. */
  nbFrames: number | null;
  /** `null` quando não há stream de áudio. */
  audioSeconds: number | null;
}

interface ProbeJson {
  streams?: Array<Record<string, string | number | undefined>>;
  format?: Record<string, string | undefined>;
}

function parseFraction(text: string, label: string): Fps {
  const match = /^(\d+)\/(\d+)$/.exec(text);
  if (match === null || Number(match[1]) === 0 || Number(match[2]) === 0) {
    throw new AcceptError("E_ACCEPT_INPUT", `${label} ilegível no ffprobe: "${text}"`, "o vídeo precisa ter taxa de quadros constante");
  }
  return { num: Number(match[1]), den: Number(match[2]) };
}

/** Lê dimensões, fps, duração, `nb_frames` e a duração do áudio com um ffprobe. */
export async function probeMedia(ffprobe: string, file: string): Promise<MediaProbe> {
  const { stdout } = await runTool(ffprobe, [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height,avg_frame_rate,nb_frames,duration:format=duration",
    "-of", "json", "--", file,
  ]);
  const json = JSON.parse(stdout) as ProbeJson;
  const streams = json.streams ?? [];
  const video = streams.find((stream) => stream["codec_type"] === "video");
  const audio = streams.find((stream) => stream["codec_type"] === "audio");
  if (video === undefined) throw new AcceptError("E_ACCEPT_INPUT", `${file} não tem stream de vídeo`, "passe o MP4 exportado pelo Studio");
  const formatSeconds = Number(json.format?.["duration"]);
  const videoSeconds = Number(video["duration"] ?? json.format?.["duration"]);
  requireFinite("duração do formato", formatSeconds);
  requireFinite("duração do vídeo", videoSeconds);
  const nbFrames = video["nb_frames"] === undefined ? null : Number(video["nb_frames"]);
  const audioSeconds = audio === undefined ? null : Number(audio["duration"] ?? json.format?.["duration"]);
  return {
    width: Number(video["width"]),
    height: Number(video["height"]),
    fps: parseFraction(String(video["avg_frame_rate"]), "avg_frame_rate"),
    formatSeconds,
    videoSeconds,
    nbFrames,
    audioSeconds,
  };
}

export interface FrameRef {
  file: string;
  /** Segundos. */
  t: number;
}

/**
 * PSNR médio de `region` entre dois frames. As duas pontas viram `size` em yuv420p antes do recorte, então
 * fonte e MP4 de resoluções diferentes ainda se comparam. Frames idênticos (PSNR infinito) saem como `PSNR_CAP`.
 */
export async function framePsnr(ffmpeg: string, a: FrameRef, b: FrameRef, region: Region, size: { width: number; height: number }): Promise<number> {
  const prepare = (label: string): string =>
    `scale=${size.width}:${size.height},format=yuv420p,crop=${region.w}:${region.h}:${region.x}:${region.y}[${label}]`;
  const { stderr: log } = await runTool(ffmpeg, [
    "-hide_banner", "-nostdin", "-loglevel", "info",
    "-ss", String(a.t), "-i", a.file,
    "-ss", String(b.t), "-i", b.file,
    "-filter_complex", `[0:v]${prepare("a")};[1:v]${prepare("b")};[a][b]psnr`,
    "-frames:v", "1", "-an", "-f", "null", "-",
  ]);
  const average = /average:(inf|[\d.]+)/.exec(log);
  if (average?.[1] === undefined) {
    throw new AcceptError("E_ACCEPT_TOOL", `sem PSNR: o FFmpeg não achou frame em ${a.file}@${a.t}s ou ${b.file}@${b.t}s`, "confira se o instante cabe na duração dos dois arquivos");
  }
  return average[1] === "inf" ? PSNR_CAP : Math.min(PSNR_CAP, Number(average[1]));
}

// ---------------------------------------------------------------------------------------------
// Corredor
// ---------------------------------------------------------------------------------------------

export interface AcceptOptions {
  final: string;
  entry: string;
  source: string;
  /** Spec já lido do JSON (o corredor valida). */
  spec: unknown;
  /** HTML de legendas; obrigatório se o spec tiver um item `caption` com `t: "palavra"`. */
  captionsHtml?: string;
  expectedSeconds: number;
}

export interface AcceptReport {
  final: string;
  entry: string;
  source: string;
  ok: boolean;
  checks: CheckResult[];
}

export async function runAcceptance(options: AcceptOptions): Promise<AcceptReport> {
  const pair = await resolveFfmpeg();
  const mp4 = await probeMedia(pair.ffprobe, options.final);
  const sourceProbe = await probeMedia(pair.ffprobe, options.source);
  if (mp4.nbFrames === null) {
    throw new AcceptError("E_ACCEPT_INPUT", `${options.final} não informa nb_frames`, "exporte de novo pelo Studio; o aceite precisa contar os frames do MP4");
  }

  const entryHtml = await readFile(options.entry, "utf8");
  const lint = lintReport(entryHtml, options.entry);
  if (lint.duration.kind === "unresolved") {
    throw new AcceptError("E_ACCEPT_INPUT", `a entrada ${options.entry} não tem duração resolvida`, "rode `frankframes lint <entrada> --json` e corrija o que falta");
  }

  const specs = parseKeyframeSpec(options.spec, { width: mp4.width, height: mp4.height, seconds: mp4.formatSeconds });
  const offset = sourceOffsetOf(specs);
  const size = { width: mp4.width, height: mp4.height };
  const sourceFrame = sourceProbe.fps.den / sourceProbe.fps.num;

  const checks: CheckResult[] = [
    { name: "lint", ok: lint.ok, medido: { ok: lint.ok, errors: lint.diagnostics.filter((d) => d.severity === "error").length }, esperado: { ok: true } },
    ...checkDuration({ lintSeconds: lint.duration.seconds, mp4Seconds: mp4.formatSeconds, nbFrames: mp4.nbFrames, fps: lint.fps, expectedSeconds: options.expectedSeconds }),
  ];

  // Sem áudio não há o que medir: `checkLoudness` reprova `audio.stream` sozinho.
  const measured = mp4.audioSeconds === null ? null : await measureLoudness(pair.ffmpeg, options.final);
  checks.push(...checkLoudness({ measured, audioSeconds: mp4.audioSeconds, videoSeconds: mp4.videoSeconds, fps: lint.fps }));

  const work = await mkdtemp(join(tmpdir(), "ff-accept-"));
  try {
    for (const [index, raw] of specs.entries()) {
      let spec = raw;
      if (spec.kind === "caption" && spec.t === CAPTION_WORD) {
        if (options.captionsHtml === undefined) {
          throw new AcceptError("E_ACCEPT_ARGS", "o spec tem legenda com t=\"palavra\" mas faltou --captions", "passe `--captions out/aceite-a001/legendas.html`");
        }
        spec = { ...spec, t: captionInstant(captionSegments(options.captionsHtml)) };
      }
      const t = spec.t as number;
      const final: FrameRef = { file: options.final, t };

      if (spec.kind === "match") {
        const psnrs = [await framePsnr(pair.ffmpeg, final, { file: options.source, t: spec.source }, spec.region, size)];
        if (psnrs[0]! < spec.minPsnr) {
          // AV1 com perda: antes de concluir defeito, compara com os frames vizinhos da fonte (plano EDT-64).
          for (const delta of [-sourceFrame, sourceFrame]) {
            const neighbor = spec.source + delta;
            if (neighbor >= 0) psnrs.push(await framePsnr(pair.ffmpeg, final, { file: options.source, t: neighbor }, spec.region, size));
          }
        }
        checks.push(checkKeyframe(index, spec, { psnrs }));
      } else if (spec.kind === "motion-enter") {
        const psnr = await framePsnr(pair.ffmpeg, { file: options.final, t: spec.from }, { file: options.final, t: spec.to }, spec.region, size);
        const report = await inspectFrames({ ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe, input: options.final, at: String(spec.to), outDir: join(work, `motion-${index}`) });
        checks.push(checkKeyframe(index, spec, { psnrs: [psnr], uniformAtEnd: report.frames[0]?.uniform ?? true }));
      } else {
        const sourceTime = spec.source ?? t + (offset ?? 0);
        const psnr = await framePsnr(pair.ffmpeg, final, { file: options.source, t: sourceTime }, spec.region, size);
        checks.push(checkKeyframe(index, { ...spec, t }, { psnrs: [psnr] }));
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return { final: options.final, entry: options.entry, source: options.source, ok: checks.every((check) => check.ok), checks };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE =
  "uso: node scripts/accept-video.ts <final.mp4> --entry <index.html> --source <MOV> --spec <keyframes.json> [--captions <legendas.html>] [--out <aceite.json>] [--expected-seconds 30]";

export interface AcceptArgs {
  final: string;
  entry: string;
  source: string;
  spec: string;
  captions?: string;
  out: string;
  expectedSeconds: number;
}

export function parseAcceptArgs(argv: string[]): AcceptArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        entry: { type: "string" },
        source: { type: "string" },
        spec: { type: "string" },
        captions: { type: "string" },
        out: { type: "string" },
        "expected-seconds": { type: "string" },
      },
    });
  } catch (error) {
    throw new AcceptError("E_ACCEPT_ARGS", (error as Error).message, USAGE);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) throw new AcceptError("E_ACCEPT_ARGS", `esperava 1 arquivo final.mp4, vieram ${positionals.length}`, USAGE);
  for (const required of ["entry", "source", "spec"] as const) {
    if (values[required] === undefined) throw new AcceptError("E_ACCEPT_ARGS", `falta --${required}`, USAGE);
  }
  const expectedSeconds = values["expected-seconds"] === undefined ? 30 : Number(values["expected-seconds"]);
  if (!(Number.isFinite(expectedSeconds) && expectedSeconds > 0)) {
    throw new AcceptError("E_ACCEPT_ARGS", `--expected-seconds inválido: ${values["expected-seconds"]}`, USAGE);
  }
  const final = resolve(positionals[0]!);
  return {
    final,
    entry: resolve(values.entry!),
    source: resolve(values.source!),
    spec: resolve(values.spec!),
    ...(values.captions !== undefined ? { captions: resolve(values.captions) } : {}),
    out: resolve(values.out ?? join(dirname(final), "aceite.json")),
    expectedSeconds,
  };
}

async function main(): Promise<number> {
  const args = parseAcceptArgs(process.argv.slice(2));
  let spec: unknown;
  try {
    spec = JSON.parse(await readFile(args.spec, "utf8"));
  } catch (error) {
    throw new AcceptError("E_ACCEPT_SPEC", `não consegui ler ${args.spec}: ${(error as Error).message}`, SPEC_HINT);
  }
  const report = await runAcceptance({
    final: args.final,
    entry: args.entry,
    source: args.source,
    spec,
    expectedSeconds: args.expectedSeconds,
    ...(args.captions !== undefined ? { captionsHtml: await readFile(args.captions, "utf8") } : {}),
  });
  await writeFile(args.out, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2)}\n`, "utf8");
  for (const check of report.checks) process.stdout.write(`${check.ok ? "ok    " : "FALHA "} ${check.name}  medido=${JSON.stringify(check.medido)}  esperado=${JSON.stringify(check.esperado)}\n`);
  process.stdout.write(`${report.ok ? "ACEITE OK" : "ACEITE REPROVADO"}: ${args.out}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("accept-video.ts")) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof AcceptError) process.stderr.write(`${error.code}: ${error.message}\n  dica: ${error.hint}\n`);
      else process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
      process.exit(2);
    },
  );
}
