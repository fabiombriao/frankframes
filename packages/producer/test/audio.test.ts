// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildAudioGraph, mixAudio } from "../src/audio.ts";
import type { AudioClip } from "../src/audio.ts";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

async function binaryAvailable(binary: string): Promise<boolean> {
  try {
    await run(binary, ["-hide_banner", "-version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function clip(overrides: Partial<AudioClip> & Pick<AudioClip, "clipId" | "file">): AudioClip {
  return {
    start: 0,
    duration: 1,
    offset: 0,
    playbackRate: 1,
    volume: 1,
    ...overrides,
  };
}

test("duas faixas: uma cadeia por clip e amix sem normalização", () => {
  const clips = [
    clip({
      clipId: "a",
      file: "/media/a.mp3",
      start: 1,
      duration: 2,
      offset: 1.5,
      volume: 0.8,
      fadeIn: 0.5,
      fadeOut: 0.25,
    }),
    clip({ clipId: "b", file: "/media/b.wav", start: 2.5, duration: 3, playbackRate: 1.5 }),
  ];

  const graph = buildAudioGraph(clips, 5);
  const lines = graph.filter.split(";");

  assert.equal(lines.length, 3);
  assert.equal(
    lines[0],
    "[0:a]atrim=start=1.5:duration=2,asetpts=PTS-STARTPTS,volume=0.8,afade=t=in:st=0:d=0.5,afade=t=out:st=1.75:d=0.25,adelay=1000|1000,apad[a0]",
  );
  assert.equal(
    lines[1],
    "[1:a]atrim=start=0:duration=3,asetpts=PTS-STARTPTS,atempo=1.5,volume=1,adelay=2500|2500,apad[a1]",
  );
  assert.equal(
    lines[2],
    "[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,volume=1,atrim=0:5,asetpts=PTS-STARTPTS[out]",
  );
  assert.deepEqual(graph.inputs, ["/media/a.mp3", "/media/b.wav"]);
  assert.deepEqual(graph.warnings, []);
});

test("fadeOut maior que a duração clampa st em 0 e avisa", () => {
  const graph = buildAudioGraph(
    [clip({ clipId: "curto", file: "/media/curto.wav", duration: 1, fadeOut: 5 })],
    1,
  );

  assert.match(graph.filter, /afade=t=out:st=0:d=5/);
  assert.doesNotMatch(graph.filter, /st=-/);
  assert.equal(graph.warnings.length, 1);
  assert.match(graph.warnings[0] ?? "", /fadeOut.*maior que a duração.*st ajustado para 0/);
});

test("playbackRate fora da faixa é clampado para 2 e avisa", () => {
  const graph = buildAudioGraph([clip({ clipId: "rapido", file: "/media/r.wav", playbackRate: 3 })], 1);

  assert.match(graph.filter, /atempo=2/);
  assert.equal(graph.warnings.length, 1);
  assert.match(graph.warnings[0] ?? "", /playbackRate 3 fora de 0\.5–2/);
});

test("integração: duas senoides mixadas geram AAC estéreo de 2s", { timeout: 120_000 }, async (t) => {
  if (!(await binaryAvailable(FFMPEG))) return t.skip("ffmpeg não encontrado");
  if (!(await binaryAvailable(FFPROBE))) return t.skip("ffprobe não encontrado");

  const workspace = await mkdtemp(join(tmpdir(), "ff-audio-test-"));
  const first = join(workspace, "440.wav");
  const second = join(workspace, "880.wav");
  const outPath = join(workspace, "mix.m4a");

  for (const [file, frequency] of [
    [first, 440],
    [second, 880],
  ] as const) {
    await run(FFMPEG, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=1`,
      "-ac", "2", "-ar", "48000", "-y", file,
    ]);
  }

  const result = await mixAudio({
    ffmpeg: FFMPEG,
    clips: [
      clip({ clipId: "grave", file: first, start: 0, duration: 1, volume: 0.6 }),
      clip({ clipId: "agudo", file: second, start: 0.5, duration: 1, volume: 0.6 }),
    ],
    totalSeconds: 2,
    outPath,
  });

  assert.equal(result.outPath, outPath);
  assert.deepEqual(result.warnings, []);

  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=channels,sample_rate:format=duration",
    "-of", "json", outPath,
  ]);
  const probe = JSON.parse(stdout) as {
    streams: Array<{ channels: number; sample_rate: string }>;
    format: { duration: string };
  };
  const stream = probe.streams[0];
  assert.ok(stream);
  assert.equal(stream.channels, 2);
  assert.equal(Number(stream.sample_rate), 48_000);

  const duration = Number(probe.format.duration);
  assert.ok(duration >= 1.95 && duration <= 2.05, `duração fora da faixa: ${duration}`);
});
