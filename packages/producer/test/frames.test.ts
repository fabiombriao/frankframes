// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FRAMES_ERROR_CODES, FramesError, inspectFrames, lumaStats, parseFrameTimes } from "../src/frames.ts";
import { resolveFfmpeg } from "../src/ffmpeg.ts";

const run = promisify(execFile);

function timeError(spec: string, duration: number): FramesError {
  try {
    parseFrameTimes(spec, duration);
  } catch (error) {
    assert.ok(error instanceof FramesError, `esperava FramesError para "${spec}"`);
    return error;
  }
  assert.fail(`"${spec}" devia falhar`);
}

test("parseFrameTimes: porcentagem é relativa à duração e segundos valem como estão", () => {
  assert.deepEqual(parseFrameTimes("10%,50%", 4), [0.4, 2]);
  assert.deepEqual(parseFrameTimes("1.5, 3", 4), [1.5, 3]);
  assert.deepEqual(parseFrameTimes("0", 4), [0]);
});

test("parseFrameTimes: ordena e remove repetidos (a 1 ms)", () => {
  assert.deepEqual(parseFrameTimes("50%,2,10%,2.0004", 4), [0.4, 2]);
});

test("parseFrameTimes: instante fora de [0, duração) e forma inválida dão E_FRAMES_TIME com dica", () => {
  for (const spec of ["5", "4", "100%", "150%", "abc", "-1", "", "1,,2", "1..5", "10 %"]) {
    const error = timeError(spec, 4);
    assert.equal(error.code, "E_FRAMES_TIME", spec);
    assert.match(error.hint, /--at 10%,2\.5/);
  }
});

test("FRAMES_ERROR_CODES lista exatamente os códigos que o comando emite", () => {
  assert.deepEqual([...FRAMES_ERROR_CODES], ["E_FRAMES_INPUT", "E_FRAMES_TIME"]);
});

test("lumaStats: frame chapado tem desvio 0 e o gradiente não", () => {
  const flat = lumaStats(new Uint8Array(2304).fill(40));
  assert.equal(flat.meanLuma, 40);
  assert.equal(flat.stdLuma, 0);
  const ramp = lumaStats(Uint8Array.from({ length: 2304 }, (_, i) => i % 256));
  assert.ok(ramp.stdLuma > 50);
});

async function ffmpegPair(): Promise<{ ffmpeg: string; ffprobe: string } | undefined> {
  try {
    const pair = await resolveFfmpeg();
    await run(pair.ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
    await run(pair.ffprobe, ["-hide_banner", "-version"], { timeout: 15_000 });
    return { ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe };
  } catch {
    return undefined;
  }
}

test("inspectFrames: preto em 0,5 s é chapado, o padrão de teste em 1,5 s não; PNG existe", async (t) => {
  const pair = await ffmpegPair();
  if (pair === undefined) {
    t.skip("FFmpeg/FFprobe indisponível");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "ff-frames-"));
  try {
    const video = join(dir, "sintetico.webm");
    // 1 s de preto seguido de 1 s de padrão de teste; só encoder LGPL permitido (libvpx-vp9), nunca libx264.
    await run(pair.ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=black:s=320x180:d=1:r=30",
      "-f", "lavfi", "-i", "testsrc2=s=320x180:d=1:r=30",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-y", video,
    ], { timeout: 60_000 });

    const report = await inspectFrames({ ...pair, input: video, at: "0.5,1.5", outDir: join(dir, "frames") });
    assert.equal(report.frames.length, 2);
    assert.ok(Math.abs(report.durationSeconds - 2) < 0.1, `duração ${report.durationSeconds}`);
    const [black, pattern] = report.frames;
    assert.equal(black!.t, 0.5);
    assert.equal(black!.uniform, true, `preto: std ${black!.stdLuma}`);
    assert.ok(black!.meanLuma < 20);
    assert.equal(pattern!.t, 1.5);
    assert.equal(pattern!.uniform, false, `padrão: std ${pattern!.stdLuma}`);
    assert.ok(pattern!.stdLuma > 2);
    for (const frame of report.frames) assert.ok(existsSync(frame.png), `PNG ausente: ${frame.png}`);
    assert.match(black!.png, /t-500\.png$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectFrames: arquivo inexistente ou que não é vídeo dá E_FRAMES_INPUT com dica de renderizar", async (t) => {
  const pair = await ffmpegPair();
  if (pair === undefined) {
    t.skip("FFmpeg/FFprobe indisponível");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "ff-frames-"));
  try {
    await assert.rejects(
      inspectFrames({ ...pair, input: join(dir, "nao-existe.mp4"), at: "50%", outDir: join(dir, "f") }),
      (error: FramesError) => error.code === "E_FRAMES_INPUT" && /render/.test(error.hint),
    );
    const lixo = join(dir, "lixo.mp4");
    await writeFile(lixo, "isto não é um vídeo");
    await assert.rejects(
      inspectFrames({ ...pair, input: lixo, at: "50%", outDir: join(dir, "f") }),
      (error: FramesError) => error.code === "E_FRAMES_INPUT",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
