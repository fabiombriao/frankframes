// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildAudioGraph, isSilentMeasurement, mixAudio } from "../src/audio.ts";
import type { AudioClip } from "../src/audio.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

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
    "[1:a]atrim=start=0:duration=4.5,asetpts=PTS-STARTPTS,atempo=1.5,volume=1,adelay=2500|2500,apad[a1]",
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

test("playbackRate fora da faixa do contrato é clampado e avisa", () => {
  const graph = buildAudioGraph([clip({ clipId: "rapido", file: "/media/r.wav", playbackRate: 20 })], 1);

  assert.match(graph.filter, /atempo=2,atempo=2,atempo=2,atempo=1\.25/);
  assert.equal(graph.warnings.length, 1);
  assert.match(graph.warnings[0] ?? "", /playbackRate 20 fora de 0\.1–10/);
});

test("integração: duas senoides mixadas geram AAC estéreo de 2s", { timeout: 120_000 }, async (t) => {
  if (!(await binaryAvailable(FFMPEG))) return t.skip("ffmpeg não encontrado");
  if (!(await binaryAvailable(FFPROBE))) return t.skip("ffprobe não encontrado");

  const workspace = await tempDir(t, "ff-audio-test-");
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

test("atrim escala a taxa e atempo cobre 3x", async () => {
  const { buildAudioGraph } = await import("../src/audio.ts");
  const graph = buildAudioGraph(
    [{ clipId: "v", file: "v.mp4", start: 0, duration: 2, offset: 1, playbackRate: 3, volume: 1 }],
    5,
  );
  const chain = graph.filter;
  assert.match(chain, /atrim=start=1:duration=6/, "consumir 6s da fonte para entregar 2s a 3x");
  assert.match(chain, /atempo=2/);
  assert.match(chain, /atempo=1\.5/);
});

test("ducking: expressão abaixa a música na janela de voz", async () => {
  const { duckExpression, DEFAULT_DUCK } = await import("../src/audio.ts");
  const applied = duckExpression([[1, 2]], 0.5, 3, DEFAULT_DUCK);
  assert.ok(applied.expression, "deveria gerar expressão");
  assert.equal(applied.windows, 1);
  assert.match(applied.expression!, /volume='/);
  assert.match(applied.expression!, /0\.354813/, "-9 dB = ganho linear 0,3548");

  const none = duckExpression([[10, 11]], 0, 2, DEFAULT_DUCK);
  assert.equal(none.expression, null, "sem sobreposição não há ducking");
});

async function meanVolume(file: string, start: number, duration: number): Promise<number> {
  const result = await run(FFMPEG, [
    "-hide_banner", "-ss", String(start), "-t", String(duration), "-i", file,
    "-af", "volumedetect", "-f", "null", "-",
  ], { encoding: "utf8" }).catch((error: { stderr?: string }) => ({ stderr: error.stderr ?? "" }));
  const match = /mean_volume: (-?[\d.]+) dB/.exec((result as { stderr: string }).stderr);
  if (!match) throw new Error("volumedetect não devolveu mean_volume");
  return Number(match[1]);
}

test("integração: música abaixa ~9 dB sob a voz, medido no arquivo", { timeout: 300_000 }, async (t) => {
  if (!(await binaryAvailable(FFMPEG))) return t.skip("ffmpeg não encontrado");
  const { mixAudio } = await import("../src/audio.ts");

  const workspace = await tempDir(t, "ff-duck-");
  const music = join(workspace, "music.wav");
  const voice = join(workspace, "voice.wav");
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-ac", "2", "-y", music]);
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "1", "-y", voice]);

  const out = join(workspace, "mix.m4a");
  await mixAudio({
    ffmpeg: FFMPEG,
    totalSeconds: 2,
    outPath: out,
    loudness: false,
    clips: [
      { clipId: "music", file: music, start: 0, duration: 2, offset: 0, playbackRate: 1, volume: 1, role: "music" },
      { clipId: "voice", file: voice, start: 0.5, duration: 1, offset: 0, playbackRate: 1, volume: 1, role: "voice" },
    ],
  });

  const before = await meanVolume(out, 0.05, 0.3);
  const during = await meanVolume(out, 0.8, 0.3);
  assert.ok(before - during > 6, `esperado ao menos 6 dB de queda, obtido ${(before - during).toFixed(1)} dB`);
});

test("integração: entrega normalizada em -14 LUFS", { timeout: 300_000 }, async (t) => {
  if (!(await binaryAvailable(FFMPEG))) return t.skip("ffmpeg não encontrado");
  const { mixAudio } = await import("../src/audio.ts");

  const workspace = await tempDir(t, "ff-lufs-");
  const voice = join(workspace, "voice.wav");
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=2", "-ac", "2", "-y", voice]);

  const out = join(workspace, "mix.m4a");
  await mixAudio({
    ffmpeg: FFMPEG,
    totalSeconds: 2,
    outPath: out,
    clips: [{ clipId: "v", file: voice, start: 0, duration: 2, offset: 0, playbackRate: 1, volume: 1, role: "voice" }],
  });

  const measured = await run(FFMPEG, ["-hide_banner", "-nostats", "-i", out, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" })
    .catch((error: { stderr?: string }) => ({ stderr: error.stderr ?? "" }));
  // O integrado começa em silêncio e sobe: vale a última leitura (resumo).
  const readings = [...(measured as { stderr: string }).stderr.matchAll(/I:\s*(-?[\d.]+) LUFS/g)];
  if (readings.length === 0) throw new Error("ebur128 não devolveu integrado");
  const integrated = Number(readings.at(-1)![1]);
  assert.ok(Math.abs(integrated + 14) <= 1, `esperado -14 LUFS ±1, obtido ${integrated}`);
});

test("keyframes: interpolação e teto de 32 segmentos", async () => {
  const { keyframeExpression, MAX_VOLUME_SEGMENTS } = await import("../src/audio.ts");
  const applied = keyframeExpression([{ time: 0, volume: 1 }, { time: 1, volume: 0.2 }, { time: 2, volume: 1 }], 2);
  assert.equal(applied.segments, 2);
  assert.equal(applied.dropped, 0);
  assert.match(applied.expression!, /0\.2/);

  const many = Array.from({ length: 80 }, (_, index) => ({ time: index * 0.1, volume: 0.4 + (index % 5) * 0.1 }));
  const capped = keyframeExpression(many, 7.9);
  assert.ok(capped.dropped > 0, "acima do teto precisa descartar pontos");
  assert.ok(capped.segments <= MAX_VOLUME_SEGMENTS, `segmentos: ${capped.segments}`);
});

test("integração: automação de volume aplicada, medida no arquivo", { timeout: 300_000 }, async (t) => {
  if (!(await binaryAvailable(FFMPEG))) return t.skip("ffmpeg não encontrado");
  const { mixAudio } = await import("../src/audio.ts");

  const workspace = await tempDir(t, "ff-kf-");
  const tone = join(workspace, "tone.wav");
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-ac", "2", "-y", tone]);

  const out = join(workspace, "mix.m4a");
  await mixAudio({
    ffmpeg: FFMPEG,
    totalSeconds: 2,
    outPath: out,
    loudness: false,
    clips: [{
      clipId: "voz",
      file: tone,
      start: 0,
      duration: 2,
      offset: 0,
      playbackRate: 1,
      volume: 1,
      keyframes: [{ time: 0, volume: 1 }, { time: 1, volume: 0.2 }, { time: 2, volume: 1 }],
    }],
  });

  const loud = await meanVolume(out, 0.05, 0.3);
  const quiet = await meanVolume(out, 0.9, 0.2);
  assert.ok(loud - quiet > 8, `esperado ao menos 8 dB entre topo e vale, obtido ${(loud - quiet).toFixed(1)} dB`);
});

test("silêncio digital: medida -inf não é normalizável", () => {
  const measured = { i: "-inf", tp: "-inf", lra: "0.00", thresh: "-70.00", offset: "inf" };
  assert.equal(isSilentMeasurement(measured), true);
  assert.equal(isSilentMeasurement({ ...measured, i: "-INF" }), true);
  assert.equal(isSilentMeasurement({ ...measured, i: "-14.31", tp: "-1.00", offset: "-0.05" }), false);
  // Medida ilegível não é silêncio: segue o caminho de falha de sempre.
  assert.equal(isSilentMeasurement({ ...measured, i: "" }), false);
  assert.equal(isSilentMeasurement({ ...measured, i: "lixo" }), false);
});

for (const [format, extension] of [["aac", "m4a"], ["wav", "wav"]] as const) {
  test(`integração: faixa em silêncio digital sai sem loudnorm e avisa (${format})`, { timeout: 120_000 }, async (t) => {
    if (!(await binaryAvailable(FFMPEG))) return t.skip("ffmpeg não encontrado");
    if (!(await binaryAvailable(FFPROBE))) return t.skip("ffprobe não encontrado");

    const workspace = await tempDir(t, "ff-silence-");
    const silent = join(workspace, "silencio.wav");
    const outPath = join(workspace, `mix.${extension}`);
    await run(FFMPEG, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "2", "-y", silent,
    ]);

    const result = await mixAudio({
      ffmpeg: FFMPEG,
      clips: [clip({ clipId: "mudo", file: silent, start: 0, duration: 2 })],
      totalSeconds: 2,
      outPath,
      format,
    });

    assert.ok(result.warnings.some((warning) => /áudio silencioso: loudnorm não aplicado/.test(warning)), JSON.stringify(result.warnings));
    const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "json", outPath]);
    const duration = Number((JSON.parse(stdout) as { format: { duration: string } }).format.duration);
    assert.ok(duration >= 1.95 && duration <= 2.1, `duração fora da faixa: ${duration}`);
  });
}

test("integração: silêncio misturado a um tom continua normalizado em -14 LUFS", { timeout: 120_000 }, async (t) => {
  if (!(await binaryAvailable(FFMPEG))) return t.skip("ffmpeg não encontrado");
  const workspace = await tempDir(t, "ff-silence-mix-");
  const silent = join(workspace, "silencio.wav");
  const tone = join(workspace, "tom.wav");
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "2", "-y", silent]);
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=2", "-ac", "2", "-y", tone]);

  const result = await mixAudio({
    ffmpeg: FFMPEG,
    clips: [clip({ clipId: "mudo", file: silent, duration: 2 }), clip({ clipId: "tom", file: tone, duration: 2 })],
    totalSeconds: 2,
    outPath: join(workspace, "mix.m4a"),
  });
  assert.ok(!result.warnings.some((warning) => /silencioso/.test(warning)), "com tom no mix, a normalização segue ligada");
});
