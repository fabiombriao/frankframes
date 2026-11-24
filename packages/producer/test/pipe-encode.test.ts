// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { buildFramePipeArgs, buildFrameSequenceArgs } from "@frankframes/encode";
import { retryOnceIfTransient } from "@frankframes/engine";
import { toErrorPayload } from "../src/errors.ts";
import { PipeEncodeError, encodeWhileCapturing } from "../src/pipe-encode.ts";
import { encodeFailure } from "../src/render.ts";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const FPS = { num: 30, den: 1 };
const WIDTH = 128;
const HEIGHT = 128;

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run(FFMPEG, ["-hide_banner", "-version"], { timeout: 15_000 });
    await run(FFPROBE, ["-hide_banner", "-version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** PNG RGB sólido e válido, sem dependência: o tom de cinza identifica o frame na ordem do vídeo. */
function solidPng(gray: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; // 8 bits
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(WIDTH * 3, gray)]);
  const raw = Buffer.concat(Array.from({ length: HEIGHT }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const tone = (frame: number): number => 20 + ((frame * 17) % 200);

/** MD5 de cada frame decodificado: compara dois vídeos pelo conteúdo, não pelos bytes do contêiner. */
async function frameMd5(file: string): Promise<string[]> {
  const { stdout } = await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"], { maxBuffer: 16 << 20 });
  return stdout.split(/\r?\n/).filter((line) => line !== "" && !line.startsWith("#"));
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ff-pipe-"));
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    if (isDead(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("encode por pipe: frames entregues fora de ordem dão o mesmo vídeo que a sequência em disco", { timeout: 300_000 }, async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg/ffprobe não encontrados");
  const dir = await workspace();
  try {
    const total = 20;
    const fromPipe = join(dir, "pipe.mp4");
    const common = { fps: FPS, codec: "av1", preset: "draft" } as const;

    // Chegada embaralhada, como vários workers produzem: lotes de 4 em ordem inversa.
    const order = [...Array(total).keys()];
    const shuffled = [16, 17, 18, 19, 8, 9, 10, 11, 0, 1, 2, 3, 12, 13, 14, 15, 4, 5, 6, 7].filter((f) => order.includes(f));
    const encoding = await encodeWhileCapturing({
      ffmpeg: FFMPEG,
      args: buildFramePipeArgs({ ...common, outPath: fromPipe }),
      total,
      maxBuffered: total,
      capture: async (deliver) => {
        for (const frame of shuffled) await deliver(frame, solidPng(tone(frame)));
        return shuffled.length;
      },
    });
    assert.equal(encoding.captured, total);
    await encoding.encoded;

    const framesDir = join(dir, "frames");
    await mkdir(framesDir);
    for (let frame = 0; frame < total; frame += 1) {
      await writeFile(join(framesDir, `frame_${String(frame + 1).padStart(6, "0")}.png`), solidPng(tone(frame)));
    }
    const fromDisk = join(dir, "disk.mp4");
    await run(FFMPEG, buildFrameSequenceArgs({ ...common, framesDir, outPath: fromDisk }), { maxBuffer: 16 << 20 });

    const pipeMd5 = await frameMd5(fromPipe);
    assert.equal(pipeMd5.length, total, "o vídeo por pipe não tem todos os frames");
    assert.deepEqual(pipeMd5, await frameMd5(fromDisk), "pipe e disco divergem: frame fora de ordem, perdido ou duplicado");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FFmpeg cai no meio: a captura para e o erro traz a stderr dele", { timeout: 120_000 }, async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg/ffprobe não encontrados");
  const dir = await workspace();
  try {
    const total = 400;
    let delivered = 0;
    let pid: number | undefined;
    const attempt = encodeWhileCapturing({
      ffmpeg: FFMPEG,
      args: buildFramePipeArgs({ fps: FPS, codec: "av1", preset: "draft", outPath: join(dir, "out.mp4") }),
      total,
      maxBuffered: 8,
      onSpawn: (value) => {
        pid = value;
      },
      capture: async (deliver) => {
        for (let frame = 0; frame < total; frame += 1) {
          // O quarto frame não é PNG: o decoder do FFmpeg recusa e sai com erro, como num frame corrompido.
          await deliver(frame, frame === 3 ? Buffer.from("isto nao e um png, de jeito nenhum".repeat(40)) : solidPng(tone(frame)));
          delivered += 1;
        }
        return delivered;
      },
    });
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof PipeEncodeError, `esperava PipeEncodeError, veio ${String(error)}`);
      assert.match(error.message, /FFmpeg terminou com/);
      assert.match(error.message, /png|Invalid|decod|Error/i, "a stderr do FFmpeg precisa estar na mensagem");
      // Como o render a vê: E_ENCODE no estágio encode, com stderr e hint, e o payload --json não rebaixa o código (EDT-62).
      const render = encodeFailure(error);
      assert.ok(render !== undefined);
      assert.equal(render.code, "E_ENCODE");
      assert.equal(render.stage, "encode");
      assert.match(render.message, /png|Invalid|decod|Error/i);
      assert.match(render.message, /frankframes doctor/, "o hint precisa mandar conferir o FFmpeg");
      assert.equal(toErrorPayload(render).code, "E_ENCODE");
      assert.equal(toErrorPayload(render).stage, "encode");
      return true;
    });
    assert.ok(delivered < total, `a captura não parou: ${delivered} de ${total} frames entregues`);
    assert.ok(pid !== undefined && (await waitDead(pid)), "o FFmpeg ficou vivo");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FFmpeg morto de fora (kill) no meio: erro explícito, nada fica pendurado", { timeout: 120_000 }, async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg/ffprobe não encontrados");
  const dir = await workspace();
  try {
    const total = 600;
    let delivered = 0;
    let pid: number | undefined;
    const attempt = encodeWhileCapturing({
      ffmpeg: FFMPEG,
      args: buildFramePipeArgs({ fps: FPS, codec: "av1", preset: "draft", outPath: join(dir, "out.mp4") }),
      total,
      maxBuffered: 4,
      onSpawn: (value) => {
        pid = value;
      },
      capture: async (deliver) => {
        for (let frame = 0; frame < total; frame += 1) {
          if (frame === 5 && pid !== undefined) process.kill(pid);
          await deliver(frame, solidPng(tone(frame)));
          delivered += 1;
          // Dá tempo ao processo de sair; um produtor mais rápido que o FFmpeg também vê o pipe quebrar.
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        return delivered;
      },
    });
    await assert.rejects(attempt, (error: unknown) => error instanceof PipeEncodeError && /FFmpeg/.test(error.message));
    assert.ok(delivered < total, "a captura seguiu como se nada tivesse acontecido");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captura que falha mata o FFmpeg e o erro dela é o que sobe", { timeout: 120_000 }, async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg/ffprobe não encontrados");
  const dir = await workspace();
  try {
    let pid: number | undefined;
    const boom = new Error("captura falhou no frame 6");
    await assert.rejects(
      encodeWhileCapturing({
        ffmpeg: FFMPEG,
        args: buildFramePipeArgs({ fps: FPS, codec: "av1", preset: "draft", outPath: join(dir, "out.mp4") }),
        total: 30,
        maxBuffered: 8,
        onSpawn: (value) => {
          pid = value;
        },
        capture: async (deliver) => {
          for (let frame = 0; frame < 6; frame += 1) await deliver(frame, solidPng(tone(frame)));
          throw boom;
        },
      }),
      (error: unknown) => error === boom,
    );
    assert.ok(pid !== undefined && isDead(pid), "o FFmpeg precisa estar morto quando o erro chega ao chamador");
    // O arquivo de saída fica livre: no Windows um FFmpeg vivo o manteria aberto.
    await rm(join(dir, "out.mp4"), { force: true });
    assert.deepEqual(await readdir(dir).then((names) => names.filter((n) => n.endsWith(".mp4"))), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelar no meio encerra captura e FFmpeg", { timeout: 120_000 }, async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg/ffprobe não encontrados");
  const dir = await workspace();
  try {
    const controller = new AbortController();
    let pid: number | undefined;
    let delivered = 0;
    const total = 600;
    const attempt = encodeWhileCapturing({
      ffmpeg: FFMPEG,
      args: buildFramePipeArgs({ fps: FPS, codec: "av1", preset: "draft", outPath: join(dir, "out.mp4") }),
      total,
      maxBuffered: 8,
      signal: controller.signal,
      onSpawn: (value) => {
        pid = value;
      },
      capture: async (deliver) => {
        for (let frame = 0; frame < total; frame += 1) {
          if (frame === 6) controller.abort();
          await deliver(frame, solidPng(tone(frame)));
          delivered += 1;
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        return delivered;
      },
    });
    await assert.rejects(attempt, (error: unknown) => (error as Error).name === "AbortError");
    assert.ok(delivered < total, "a captura não parou depois do cancelamento");
    assert.ok(pid !== undefined && (await waitDead(pid)), "o FFmpeg ficou vivo depois de cancelar");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("frame que nunca chega: finish falha em vez de fechar um vídeo curto", { timeout: 120_000 }, async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg/ffprobe não encontrados");
  const dir = await workspace();
  try {
    let pid: number | undefined;
    await assert.rejects(
      encodeWhileCapturing({
        ffmpeg: FFMPEG,
        args: buildFramePipeArgs({ fps: FPS, codec: "av1", preset: "draft", outPath: join(dir, "out.mp4") }),
        total: 10,
        maxBuffered: 10,
        onSpawn: (value) => {
          pid = value;
        },
        capture: async (deliver) => {
          for (const frame of [0, 1, 2, 4, 5]) await deliver(frame, solidPng(tone(frame)));
          return undefined;
        },
      }),
      /faltou o frame 3/,
    );
    assert.ok(pid !== undefined && (await waitDead(pid)), "o FFmpeg ficou vivo");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retry de falha transitória recomeça o pipe do zero: FFmpeg novo, sem frame duplicado (EDT-72)", { timeout: 120_000 }, async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg/ffprobe não encontrados");
  const dir = await workspace();
  try {
    const total = 12;
    const pids: number[] = [];
    const causes: string[] = [];
    const out = join(dir, "out.mp4");
    let attempts = 0;
    const encoding = await retryOnceIfTransient(
      () =>
        encodeWhileCapturing({
          ffmpeg: FFMPEG,
          args: buildFramePipeArgs({ fps: FPS, codec: "av1", preset: "draft", outPath: out }),
          total,
          maxBuffered: total,
          onSpawn: (pid) => pids.push(pid),
          capture: async (deliver) => {
            attempts += 1;
            for (let frame = 0; frame < total; frame += 1) {
              if (attempts === 1 && frame === 5) throw new Error("Protocol error (Page.captureScreenshot): TargetCloseError");
              await deliver(frame, solidPng(tone(frame)));
            }
            return attempts;
          },
        }),
      (cause) => causes.push(cause.code),
      (error) => error instanceof PipeEncodeError,
    );
    await encoding.encoded;
    assert.equal(attempts, 2);
    assert.equal(causes.length, 1, "a repetição precisa ser anunciada");
    assert.equal(pids.length, 2, "cada tentativa sobe o seu FFmpeg");
    assert.ok(isDead(pids[0] as number), "o FFmpeg da primeira tentativa precisa ter morrido");
    assert.equal((await frameMd5(out)).length, total, "frames duplicados ou faltando depois do retry");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("encodeFailure só reconhece PipeEncodeError: o resto segue a classificação normal (EDT-62)", () => {
  assert.equal(encodeFailure(new Error("Protocol error TargetCloseError")), undefined);
  assert.equal(encodeFailure("texto"), undefined);
  assert.equal(encodeFailure(new PipeEncodeError("FFmpeg terminou com código 1"))?.code, "E_ENCODE");
});
