// FrankFrames — proprietário. Ver LICENSE na raiz.
import { execFile } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { buildMuxArgs, buildVideoArgs } from "@frankframes/encode";
import type { Preset, VideoCodec } from "@frankframes/encode";
import type { LayeredMediaManifest, Viewport } from "@frankframes/engine";
import type { Fps } from "@frankframes/contract";
import { timeOfFrame } from "@frankframes/contract";
import { LayeredError, layerName } from "./layered-capture.ts";
import type { GlassRegion, LayeredCapture, ProgressFrame, VideoFrame } from "./layered-capture.ts";

const run = promisify(execFile);
const CUDA_DEVICE = "ffdecode";
const CUDA_DEVICE_ARGS = ["-init_hw_device", `cuda=${CUDA_DEVICE}:0`];
const NVDEC_ARGS = ["-hwaccel", "cuda", "-hwaccel_device", CUDA_DEVICE, "-hwaccel_output_format", "nv12"];

export function cropForVideo(video: VideoFrame, source: Viewport, viewport: Viewport): [number, number, number, number] {
  // O trace PaintImage do Chrome pinado mostrou layout em passos de 1/64 px.
  // O destino inteiro volta à fonte fracionária, sem arredondar o recorte do vídeo.
  const unit = (value: number): number => Math.trunc(value * 64 + Math.sign(value) * 1e-9) / 64;
  const margin = 1 - 1 / video.zoom;
  const left = unit(source.width * margin * video.fx);
  const top = unit(source.height * margin * video.fy);
  const viewWidth = source.width - left - unit(source.width * margin * (1 - video.fx));
  const viewHeight = source.height - top - unit(source.height * margin * (1 - video.fy));
  const scale = Math.max(viewport.width / viewWidth, viewport.height / viewHeight);
  const fittedWidth = video.fit === "fill" ? viewport.width : unit(viewWidth * scale);
  const fittedHeight = video.fit === "fill" ? viewport.height : unit(viewHeight * scale);
  const axis = (view: number, natural: number, fitted: number, size: number, inset: number, position: number): [number, number] => {
    const ratio = fitted / view;
    const origin = unit((size - fitted) * position) - unit(inset * ratio);
    const span = Math.round(origin + unit(natural * ratio)) - Math.round(origin);
    return [natural * size / span, -Math.round(origin) * natural / span];
  };
  const [width, x] = axis(viewWidth, source.width, fittedWidth, viewport.width, left, video.position[0]);
  const [height, y] = axis(viewHeight, source.height, fittedHeight, viewport.height, top, video.position[1]);
  return [width, height, x, y];
}

function frameExpression<T>(values: T[], variable: "n" | "N", indexOf: (value: T, index: number) => number, format: (value: T) => string): string {
  const expression = (first: number, end: number): string => {
    if (end - first === 1) return format(values[first]!);
    const mid = Math.floor((first + end) / 2);
    return `if(lt(${variable},${indexOf(values[mid]!, mid)}),${expression(first, mid)},${expression(mid, end)})`;
  };
  return expression(0, values.length);
}

export function videoColorFilters(css: string): string[] {
  if (css === "none") return [];
  const filters: string[] = [];
  for (const token of css.split(" ")) {
    const match = /^(contrast|brightness|saturate)\(([\d.]+)\)$/.exec(token);
    if (match === null) throw new LayeredError(`filtro do vídeo incompatível: ${css}`);
    const amount = Number(match[2]);
    if (match[1] === "saturate") {
      const weights = [0.213, 0.715, 0.072];
      const mixer = [..."rgb"].flatMap((out, row) => [..."rgb"].map((channel, column) => {
        const coefficient = weights[column]! * (1 - amount) + (row === column ? amount : 0);
        if (Math.abs(coefficient) > 2) throw new LayeredError(`saturação incompatível: ${token}`);
        return `${out}${channel}=${coefficient.toFixed(8)}`;
      }));
      filters.push(`colorchannelmixer=${mixer.join(":")}`);
    } else {
      const value = match[1] === "contrast" ? `(val-127.5)*${amount}+127.5` : `val*${amount}`;
      const channels = [..."rgb"].map((channel) => `${channel}='clip(floor((${value})+0.5),0,255)'`);
      filters.push(`lutrgb=${channels.join(":")}`);
    }
  }
  return filters;
}

function frameList(entries: ReadonlyMap<number, string>, fps: Fps, total: number): string {
  const ordered = [...entries].sort(([a], [b]) => a - b);
  const list = ["ffconcat version 1.0"];
  const micros = (frame: number): number => Math.round(frame * fps.den * 1e6 / fps.num);
  for (const [index, [frame, path]] of ordered.entries()) {
    const next = ordered[index + 1]?.[0] ?? total;
    const duration = (micros(next) - micros(frame)) / 1e6;
    list.push(`file '${path}'`, `option framerate ${fps.num}/${fps.den}`, `duration ${duration.toFixed(6)}`);
  }
  const path = ordered.at(-1)![1];
  // O último demuxer precisa de um pacote no tempo final para o fps repetir até lá.
  list.push(`file '${path}'`, `option framerate ${fps.num}/${fps.den}`);
  return `${list.join("\n")}\n`;
}

export function glassMask(width: number, height: number, regions: GlassRegion[]): Buffer {
  const pixels = Buffer.alloc(width * height);
  for (const region of regions) {
    const x = region.x / 2;
    const y = region.y / 2;
    const halfWidth = region.width / 4;
    const halfHeight = region.height / 4;
    const radius = Math.min(region.radius / 2, halfWidth, halfHeight);
    const right = Math.min(width, Math.ceil(x + 2 * halfWidth + 1));
    const bottom = Math.min(height, Math.ceil(y + 2 * halfHeight + 1));
    for (let row = Math.max(0, Math.floor(y) - 1); row < bottom; row += 1) {
      const dy = Math.abs(row + 0.5 - y - halfHeight) - halfHeight + radius;
      for (let col = Math.max(0, Math.floor(x) - 1); col < right; col += 1) {
        const dx = Math.abs(col + 0.5 - x - halfWidth) - halfWidth + radius;
        const edge = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2) + Math.min(Math.max(dx, dy), 0) - radius;
        const alpha = Math.max(0, Math.min(1, 0.5 - edge)) * region.opacity;
        const index = row * width + col;
        pixels[index] = Math.round(pixels[index]! * (1 - alpha) + 255 * alpha);
      }
    }
  }
  return Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), pixels]);
}

async function writeProgress(path: string, frames: Array<ProgressFrame | undefined>, first: ProgressFrame, signal?: AbortSignal): Promise<void> {
  const { x, y, width, height } = first;
  const buffer = Buffer.alloc(width * height * 4);
  const output = await open(path, "w");
  try {
    for (const frame of frames) {
      signal?.throwIfAborted();
      buffer.fill(0);
      if (frame !== undefined) {
        if (frame.x !== x || frame.y !== y || frame.width !== width || frame.height !== height) {
          throw new LayeredError("a faixa de progresso separada precisa manter a mesma caixa");
        }
        const radius = Math.min(frame.radius, width / 2, height / 2);
        for (let row = 0; row < height; row += 1) {
          const dy = Math.abs(row + 0.5 - height / 2) - height / 2 + radius;
          for (let col = 0; col < Math.ceil(frame.fill); col += 1) {
            const dx = Math.abs(col + 0.5 - width / 2) - width / 2 + radius;
            const edge = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2) + Math.min(Math.max(dx, dy), 0) - radius;
            const coverage = Math.max(0, Math.min(1, frame.fill - col, 0.5 - edge));
            const index = 4 * (row * width + col);
            buffer[index] = frame.rgba[0];
            buffer[index + 1] = frame.rgba[1];
            buffer[index + 2] = frame.rgba[2];
            buffer[index + 3] = Math.round(frame.rgba[3] * coverage);
          }
        }
      }
      let offset = 0;
      while (offset < buffer.length) offset += (await output.write(buffer, offset)).bytesWritten;
    }
  } finally {
    await output.close();
  }
}

export interface LayeredSource {
  timing: LayeredMediaManifest["clips"][number];
  input: string;
}

interface LayeredEncodeOptions {
  capture: LayeredCapture;
  sources: LayeredSource[];
  viewport: Viewport;
  fps: Fps;
  directory: string;
  outPath: string;
  codec: VideoCodec;
  preset: Preset;
  av1Nvenc?: boolean;
  signal?: AbortSignal;
  warnings: string[];
  onNvdec?: (sources: number) => void;
}

export async function encodeLayers(ffmpeg: string, options: LayeredEncodeOptions): Promise<void> {
  const nvdec = new Set<string>();
  if (options.av1Nvenc === true) {
    for (const input of new Set(options.sources.map((source) => source.input))) {
      options.signal?.throwIfAborted();
      try {
        const { stderr } = await run(ffmpeg, [
          "-hide_banner", "-loglevel", "debug", ...CUDA_DEVICE_ARGS, ...NVDEC_ARGS,
          "-i", input, "-map", "0:v:0", "-an", "-frames:v", "1", "-f", "null", "-",
        ], {
          timeout: 15_000, maxBuffer: 2 << 20, windowsHide: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (stderr.includes("Format cuda chosen by get_format()")) nvdec.add(input);
        else options.warnings.push(`NVDEC não confirmado para ${basename(input)}: usando decodificação por CPU`);
      } catch {
        options.signal?.throwIfAborted();
        options.warnings.push(`NVDEC indisponível para ${basename(input)}: usando decodificação por CPU`);
      }
    }
  }
  if (nvdec.size > 0) options.onNvdec?.(nvdec.size);
  const args = await buildLayeredArgs(options, nvdec);
  // Em caso de abort, o callback do execFile pode chegar antes da saída do processo.
  // Espere o close antes de liberar o diretório que o FFmpeg está lendo.
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(ffmpeg, args, {
      cwd: options.directory, windowsHide: true, maxBuffer: 16 << 20,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, (error, output, stderr) => {
      const settle = (): void => {
        if (error === null) resolve(output);
        else reject(new Error(stderr.trim() || error.message, { cause: error }));
      };
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) settle();
      else child.once("close", settle);
    });
    const kill = (): void => { child.kill(); };
    process.prependOnceListener("exit", kill);
    child.once("close", () => process.removeListener("exit", kill));
  });
  const reported = [...stdout.matchAll(/^frame=(\d+)\r?$/gm)].at(-1)?.[1];
  if (Number(reported) !== options.capture.frames.length) {
    throw new Error(`FFmpeg confirmou ${reported ?? "nenhum"} de ${options.capture.frames.length} frames`);
  }
}

/** O tempo de cada trecho é o dos frames visíveis, medido no mesmo seek usado para o HTML. */
async function buildLayeredArgs(options: LayeredEncodeOptions, nvdec: ReadonlySet<string>): Promise<string[]> {
  const { frames, hashes } = options.capture;
  const { sources, viewport, fps, directory } = options;
  const rate = `${fps.num}/${fps.den}`;
  const frameSeconds = fps.den / fps.num;
  const graph: string[] = [];
  const inputs: string[] = [];
  const videoLabels: string[] = [];
  for (let first = 0; first < frames.length;) {
    options.signal?.throwIfAborted();
    const initial = frames[first]!.video!;
    const source = sources.find(({ timing }) => timing.clipId === initial.clipId);
    if (source === undefined) throw new LayeredError(`vídeo sem fonte: ${initial.clipId}`);
    let end = first + 1;
    while (end < frames.length && frames[end]!.video?.clipId === initial.clipId) end += 1;
    const index = videoLabels.length;
    const { displayWidth, displayHeight } = source.timing.orientation;
    const crops: string[][] = [];
    for (let frame = first; frame < end; frame += 1) {
      const current = frames[frame]!.video!;
      if (current.filter !== initial.filter) throw new LayeredError(`filtro variável no vídeo ${initial.clipId}`);
      crops.push(cropForVideo(current, { width: displayWidth, height: displayHeight }, viewport).map((value) => value.toFixed(8)));
    }
    const crop = ["crop_w", "crop_h", "crop_x", "crop_y"].map((field, column) => {
      const changes = crops.flatMap((frame, index) => frame[column] === crops[index - 1]?.[column]
        ? [] : [{ value: frame[column]!, index }]);
      return `${field}='${frameExpression(changes, "n", ({ index }) => index, ({ value }) => value)}'`;
    }).join(":");
    const { offset, playbackRate, duration, start } = source.timing;
    const seekFrame = Math.round(offset / frameSeconds);
    const maxFrame = Math.max(0, Math.ceil(duration * playbackRate / frameSeconds - 1e-9) - 1);
    const requested: Array<{ raw: number; output: number }> = [];
    for (let frame = first; frame < end; frame += 1) {
      const seconds = timeOfFrame(frame, fps) * 1000 / 1000;
      const raw = Math.max(0, Math.min(maxFrame, Math.floor((seconds - start) * playbackRate * (fps.num / fps.den))));
      if (raw !== requested.at(-1)?.raw) requested.push({ raw, output: frame - first });
    }
    const begin = requested[0]!.raw;
    const sourceEnd = seekFrame + requested.at(-1)!.raw + 1;
    // A extração de referência aplica fps antes de -ss. O trim preserva a fase dessa grade.
    if (nvdec.has(source.input)) inputs.push(...NVDEC_ARGS);
    inputs.push("-autorotate", "-threads", "2", "-i", source.input);
    const label = `v${index}`;
    const count = end - first;
    const timing: string[] = [];
    if (requested.some(({ raw }, index) => raw - begin !== index)) {
      const select = frameExpression(requested, "n", ({ raw }) => raw - begin, ({ raw }) => `eq(n,${raw - begin})`);
      timing.push(`select='${select}'`);
    }
    if (requested.some(({ output }, index) => output !== index)) {
      const pts = frameExpression(requested, "N", (_, index) => index, ({ output }) => String(output));
      timing.push(`setpts='${pts}'`, `fps=fps=${rate}:start_time=0`);
    } else timing.push("setpts=N");
    const filters = [
      `fps=${rate}`,
      `trim=start_frame=${seekFrame + begin}:end_frame=${sourceEnd}`,
      ...timing,
      `tpad=stop=${count}:stop_mode=clone`, `trim=end_frame=${count}`, "setsar=1", "format=gbrp",
      `libplacebo=w=${viewport.width}:h=${viewport.height}:fit_mode=fill:format=gbrp:upscaler=bilinear:downscaler=bilinear:disable_linear=1:dithering=none:${crop}`,
      ...videoColorFilters(initial.filter),
    ];
    graph.push(`[${index}:v]${filters.join(",")}[${label}]`);
    videoLabels.push(`[${label}]`);
    first = end;
  }
  let base = videoLabels[0]!;
  if (videoLabels.length > 1) {
    graph.push(`${videoLabels.join("")}concat=n=${videoLabels.length}:v=1:a=0[video]`);
    base = "[video]";
  }
  let stream = videoLabels.length;
  if (options.capture.background) {
    inputs.push("-framerate", rate, "-i", "background.png");
    graph.push(`${base}[${stream}:v]overlay=format=gbrp:eof_action=repeat[background]`);
    base = "[background]";
    stream += 1;
  }
  const radii = new Set(frames.flatMap(({ glass }) => glass.map(({ sigma }) => sigma)).filter((sigma) => sigma > 0));
  const width = Math.ceil(viewport.width / 2);
  const height = Math.ceil(viewport.height / 2);
  for (const [index, sigma] of [...radii].entries()) {
    const masks = new Map<number, string>();
    const paths = new Map<string, string>();
    let previous: string | undefined;
    for (const [frame, { glass }] of frames.entries()) {
      options.signal?.throwIfAborted();
      const regions = glass.filter((region) => region.sigma === sigma);
      const key = JSON.stringify(regions);
      if (key === previous) continue;
      let path = paths.get(key);
      if (path === undefined) {
        path = `mask-${index}-${frame}.pgm`;
        await writeFile(join(directory, path), glassMask(width, height, regions));
        paths.set(key, path);
      }
      masks.set(frame, path);
      previous = key;
    }
    const listPath = `mask-${index}.ffconcat`;
    await writeFile(join(directory, listPath), frameList(masks, fps, frames.length));
    inputs.push("-f", "concat", "-safe", "0", "-i", listPath);
    graph.push(
      `${base}split[plain${index}][forblur${index}]`,
      `[forblur${index}]scale=${width}:${height}:flags=bilinear,gblur=sigma=${sigma / 2}:steps=3,scale=${viewport.width}:${viewport.height}:flags=bilinear[blur${index}]`,
      `[${stream}:v]fps=${rate},scale=${viewport.width}:${viewport.height}:flags=bilinear,format=gbrp[mask${index}]`,
      `[plain${index}][blur${index}][mask${index}]maskedmerge[glass${index}]`,
    );
    base = `[glass${index}]`;
    stream += 1;
  }
  await writeFile(join(directory, "layers.ffconcat"), frameList(new Map([...hashes.keys()].map((frame) => [frame, layerName(frame)])), fps, frames.length));
  inputs.push("-f", "concat", "-safe", "0", "-i", "layers.ffconcat");
  graph.push(
    `[${stream}:v]fps=${rate},format=rgba[overlay]`,
    `${base}[overlay]overlay=format=gbrp:eof_action=repeat[html]`,
  );
  base = "[html]";
  const progress = frames.map((frame) => frame.progress);
  const bar = progress.find((frame) => frame !== undefined);
  if (bar !== undefined) {
    const path = "progress.rgba";
    await writeProgress(join(directory, path), progress, bar, options.signal);
    inputs.push("-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${bar.width}x${bar.height}`, "-framerate", rate, "-i", path);
    graph.push(`${base}[${stream + 1}:v]overlay=x=${bar.x}:y=${bar.y}:format=gbrp[withbar]`);
    base = "[withbar]";
  }
  graph.push(`${base}format=yuv420p[out]`);
  await writeFile(join(directory, "layers.filter"), `${graph.join(";\n")}\n`);
  const videoArgs = options.av1Nvenc === true
    ? ["-c:v", "av1_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq",
      { draft: "44", standard: "38", high: "31" }[options.preset], "-b:v", "0", "-pix_fmt", "yuv420p"]
    : buildVideoArgs(options.codec, options.preset);
  return [
    "-hide_banner", "-loglevel", "error", "-xerror", "-filter_complex_threads", "4", "-nostats", "-progress", "pipe:1",
    ...(nvdec.size > 0 ? CUDA_DEVICE_ARGS : []),
    ...inputs, "-/filter_complex", "layers.filter", "-map", "[out]",
    "-frames:v", String(frames.length), ...videoArgs,
    "-r", rate, "-video_track_timescale", "90000", ...buildMuxArgs(options.codec), "-y", options.outPath,
  ];
}
