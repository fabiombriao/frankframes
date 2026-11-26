// FrankFrames — proprietário. Ver LICENSE na raiz.
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Como `execFile`, mas só resolve ou rejeita depois que o processo saiu. No abort o Node rejeita na hora do kill, com o filho
 * ainda vivo e com arquivos abertos; quem limpa a saída em seguida esbarra em EBUSY (Windows) ou em arquivo novo.
 */
function runUntilExit(file: string, args: string[], options: { maxBuffer: number; signal?: AbortSignal }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error) => {
      const settle = (): void => (error === null ? resolve() : reject(error));
      // Falha ao subir o processo (sem pid) ou já saiu: nada a esperar.
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) settle();
      else child.once("exit", settle);
    });
  });
}

export interface VideoTiming {
  /** `data-clip-id` do `<video>` que será substituído. */
  clipId: string;
  /** Início do clip na composição, em segundos. */
  start: number;
  /** Duração do clip, em segundos. */
  duration: number;
  /** `data-offset`: instante dentro da fonte. */
  offset: number;
  playbackRate: number;
  /** Orientação de exibição da fonte (EDT-86): a que o probe mediu e os frames extraídos já têm. */
  orientation?: VideoOrientation;
}

export interface MediaManifestEntry extends VideoTiming {
  /** Subpasta servida em `/__ff_media/<dir>/`. */
  dir: string;
  frameCount: number;
}

export interface MediaManifest {
  fps: { num: number; den: number };
  clips: MediaManifestEntry[];
}

/** Geometria e tempo do vídeo no Chrome, com os pixels compostos fora dele. */
export interface LayeredMediaManifest {
  layered: true;
  fps: MediaManifest["fps"];
  clips: Array<VideoTiming & { orientation: VideoOrientation }>;
}

export interface ExtractOptions {
  ffmpeg: string;
  input: string;
  outDir: string;
  fps: { num: number; den: number };
  offset?: number;
  duration?: number;
  /** Cancela o FFmpeg em andamento. */
  signal?: AbortSignal;
  /** Tamanho de exibição medido pelo probe: o primeiro frame extraído precisa ter exatamente este tamanho. */
  expectDisplay?: { width: number; height: number };
}

/** Código de mídia do engine (entra no `docs/reference/diagnostics.md` pela lista de códigos do render). */
export type MediaRotationCode = "E_MEDIA_ROTATION";

/** Orientação que o vídeo tem na tela: rotação do contêiner (Display Matrix) já aplicada. */
export interface VideoOrientation {
  /** Graus, convenção do ffprobe (anti-horário positivo), em [-180, 180). O celular em retrato dá -90. */
  rotation: number;
  /** Espelhamento (determinante da matriz negativo). */
  mirrored: boolean;
  /** Largura/altura como aparecem: as gravadas, trocadas quando a rotação é ±90. */
  displayWidth: number;
  displayHeight: number;
}

export interface VideoProbe extends VideoOrientation {
  /** Duração do contêiner, em segundos. */
  duration: number;
  /** Largura/altura gravadas na trilha, antes da rotação. */
  width: number;
  height: number;
}

/**
 * Orientação que o FFmpeg e o navegador não aplicariam igual. Código estável e `hint`; o hint também vai na
 * `message`, que é o que chega ao usuário.
 */
export class MediaRotationError extends Error {
  readonly code: MediaRotationCode = "E_MEDIA_ROTATION";
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(`${message} (${hint})`);
    this.name = "MediaRotationError";
    this.hint = hint;
  }
}

const ROTATION_HINT = "reexporte o vídeo com a imagem já girada nos pixels; só rotação de 0, 90, 180 ou 270 graus no contêiner é aceita";
/** Folga em graus para tratar o ângulo como múltiplo de 90 (a matriz 16.16 de câmera dá o valor exato). */
const RIGHT_ANGLE_TOLERANCE = 0.1;

/**
 * Lê a Display Matrix como o ffprobe a imprime (3 linhas `índice: a b c`, ponto fixo) e devolve rotação e espelhamento.
 * Mesma conta do `av_display_rotation_get`. Só 0/90/180/270 (com ou sem espelhamento) valem: o FFmpeg gira outro
 * ângulo com cantos pretos e o navegador o ignora, então preview e render divergiriam; matriz com cisalhamento idem.
 */
export function parseDisplayMatrix(text: string, file: string): { rotation: number; mirrored: boolean } {
  const values = [...text.matchAll(/^\s*\d+:\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/gm)].flatMap((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  if (values.length !== 9) throw new Error(`matriz de exibição ilegível em ${file}: ${JSON.stringify(text)}`);
  const [m0, m1, , m3, m4] = values as [number, number, number, number, number];
  const scale0 = Math.hypot(m0, m3);
  const scale1 = Math.hypot(m1, m4);
  if (scale0 === 0 || scale1 === 0) throw new Error(`matriz de exibição degenerada em ${file}`);

  const angle = (-Math.atan2(m1 / scale1, m0 / scale0) * 180) / Math.PI;
  const turns = Math.round(angle / 90);
  if (Math.abs(angle - turns * 90) > RIGHT_ANGLE_TOLERANCE) {
    throw new MediaRotationError(`${file}: rotação de exibição de ${Math.round(angle * 100) / 100}° não é múltipla de 90°`, ROTATION_HINT);
  }
  if (Math.abs(m0 * m1 + m3 * m4) / (scale0 * scale1) > 1e-3) {
    throw new MediaRotationError(`${file}: a matriz de exibição tem cisalhamento`, ROTATION_HINT);
  }
  const normalized = ((((turns * 90 + 180) % 360) + 360) % 360) - 180;
  return { rotation: normalized === 0 ? 0 : normalized, mirrored: m0 * m4 - m1 * m3 < 0 };
}

interface RawStream {
  width?: unknown;
  height?: unknown;
  side_data_list?: Array<{ side_data_type?: unknown; displaymatrix?: unknown }>;
}

/** Interpreta o JSON do ffprobe (`probeVideo`). Puro: sem processo, para o teste de unidade. */
export function parseVideoProbe(json: string, file: string): VideoProbe {
  let raw: { streams?: RawStream[]; format?: { duration?: unknown } };
  try {
    raw = JSON.parse(json) as typeof raw;
  } catch {
    throw new Error(`saída do ffprobe não é JSON em ${file}`);
  }
  const stream = raw.streams?.[0];
  if (stream === undefined) throw new Error(`sem trilha de vídeo em ${file}`);
  const { width, height } = stream;
  if (typeof width !== "number" || typeof height !== "number" || !(width > 0) || !(height > 0)) {
    throw new Error(`dimensões inválidas em ${file}: ${String(width)}x${String(height)}`);
  }
  const duration = Number(raw.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`duração inválida em ${file}: ${String(raw.format?.duration)}`);

  const matrix = stream.side_data_list?.find((item) => item.side_data_type === "Display Matrix");
  let orientation = { rotation: 0, mirrored: false };
  if (matrix !== undefined) {
    if (typeof matrix.displaymatrix !== "string") throw new Error(`Display Matrix sem a matriz em ${file}`);
    orientation = parseDisplayMatrix(matrix.displaymatrix, file);
  }
  const swapped = Math.abs(orientation.rotation) === 90;
  return {
    duration,
    width,
    height,
    ...orientation,
    displayWidth: swapped ? height : width,
    displayHeight: swapped ? width : height,
  };
}

/**
 * Duração, dimensões gravadas, rotação e dimensões de exibição da primeira trilha de vídeo (EDT-86).
 * Falha com `E_MEDIA_ROTATION` quando a rotação não pode ser honrada igual em todos os caminhos.
 */
export async function probeVideo(ffprobe: string, file: string, signal?: AbortSignal): Promise<VideoProbe> {
  const { stdout } = await run(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height:stream_side_data=side_data_type,displaymatrix:format=duration",
    "-of",
    "json",
    "--",
    file,
  ], signal !== undefined ? { signal } : {});
  return parseVideoProbe(stdout, file);
}

/** Tamanho de um JPEG pelo marcador SOF; falha alto se o arquivo não for JPEG legível. */
export function jpegSize(data: Buffer): { width: number; height: number } {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new Error("não é um JPEG");
  let offset = 2;
  while (offset + 9 <= data.length) {
    if (data[offset] !== 0xff) throw new Error("JPEG malformado: marcador esperado");
    const marker = data[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // SOF0..SOF15, exceto DHT (c4), JPG (c8) e DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + data.readUInt16BE(offset + 2);
  }
  throw new Error("JPEG sem marcador de tamanho");
}

/** Duração real da fonte, em segundos. */
export async function probeDuration(ffprobe: string, file: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await run(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    "--",
    file,
  ], signal !== undefined ? { signal } : {});
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`duração inválida em ${file}: ${stdout.trim()}`);
  return seconds;
}

/**
 * Extrai a janela do vídeo como sequência de JPEG, um por frame de saída.
 * `-ss` depois de `-i` = busca frame-exata; `-an` garante que o áudio não entra.
 * `-autorotate` (já é o padrão do FFmpeg, aqui explícito) aplica a Display Matrix: o JPEG sai na orientação de
 * exibição, a mesma que `probeVideo` reporta. Com `expectDisplay`, o tamanho do primeiro frame é conferido.
 */
export async function extractFrames(options: ExtractOptions): Promise<{ frameCount: number; pattern: string }> {
  await mkdir(options.outDir, { recursive: true });
  const rate = options.fps.den === 1 ? String(options.fps.num) : `${options.fps.num}/${options.fps.den}`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-autorotate",
    "-i",
    options.input,
    ...(options.offset !== undefined ? ["-ss", String(options.offset)] : []),
    ...(options.duration !== undefined ? ["-t", String(options.duration)] : []),
    "-vf",
    `fps=${rate}`,
    "-an",
    "-q:v",
    "2",
    "-start_number",
    "0",
    "-y",
    `${options.outDir}/%06d.jpg`,
  ];
  await runUntilExit(options.ffmpeg, args, { maxBuffer: 16 << 20, ...(options.signal !== undefined ? { signal: options.signal } : {}) });
  const files = (await readdir(options.outDir)).filter((name) => name.endsWith(".jpg"));
  if (files.length === 0) throw new Error(`nenhum frame extraído de ${options.input}`);
  if (options.expectDisplay !== undefined) {
    const { width, height } = jpegSize(await readFile(`${options.outDir}/000000.jpg`));
    if (width !== options.expectDisplay.width || height !== options.expectDisplay.height) {
      throw new MediaRotationError(
        `${options.input}: o frame extraído tem ${width}x${height}, mas o vídeo aparece em ${options.expectDisplay.width}x${options.expectDisplay.height}`,
        "o FFmpeg não aplicou a rotação do contêiner; rode `frankframes doctor` e reexporte o vídeo sem rotação nos metadados",
      );
    }
  }
  return { frameCount: files.length, pattern: `${options.outDir}/%06d.jpg` };
}
