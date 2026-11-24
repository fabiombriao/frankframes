// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AUDIO_ERROR_CODES,
  AudioTruePeakError,
  DELIVERY_LOUDNESS,
  TRUE_PEAK_MARGIN_DB,
  buildAudioGraph,
  enforceTruePeak,
  isSilentMeasurement,
  measureLoudness,
  mixAudio,
  truePeakCorrectionDb,
} from "../src/audio.ts";
import type { AudioClip, MeasuredLoudness } from "../src/audio.ts";
import { RENDER_ERROR_CODES } from "../src/errors.ts";
import { resolveFfmpeg } from "../src/ffmpeg.ts";
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

/** Roda `fn` capturando o que ela escreve no stderr (o aviso de limpeza vai para lá quando não há `warnings`). */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; stderr: string }> {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), stderr };
  } catch (error) {
    return { error, stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("falha de remoção do workspace aparece nos warnings de mixAudio (EDT-83)", { timeout: 120_000 }, async (t) => {
  if (!(await binaryAvailable(FFMPEG))) return t.skip("ffmpeg não encontrado");

  const dir = await tempDir(t, "ff-audio-test-");
  const tone = join(dir, "tom.wav");
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "2", "-ar", "48000", "-y", tone]);

  // A remoção simulada falha de propósito; o workspace real fica e o teste o apaga (sem force) ao fim.
  let workspace: string | undefined;
  t.after(async () => {
    if (workspace !== undefined) await rm(workspace, { recursive: true, force: false });
  });

  const result = await mixAudio({
    ffmpeg: FFMPEG,
    clips: [clip({ clipId: "tom", file: tone })],
    totalSeconds: 1,
    outPath: join(dir, "mix.m4a"),
    loudness: false,
    removeWorkspace: async (path) => {
      workspace = path;
      throw new Error("EBUSY simulado");
    },
  });

  assert.ok(workspace !== undefined, "a remoção injetada foi chamada");
  const aviso = result.warnings.find((warning) => warning.startsWith("não consegui remover"));
  assert.ok(aviso !== undefined, `warnings sem o aviso de limpeza: ${JSON.stringify(result.warnings)}`);
  assert.ok(aviso.includes(workspace), "o aviso traz o caminho do workspace");
  assert.ok(aviso.includes("EBUSY simulado"), "o aviso traz o motivo");
  assert.match(workspace, /ff-audio-/);
});

test("mix que falha mantém o erro original quando a remoção do workspace também falha (EDT-83)", async (t) => {
  let workspace: string | undefined;
  t.after(async () => {
    if (workspace !== undefined) await rm(workspace, { recursive: true, force: false });
  });

  // FFmpeg inexistente: o mix falha (ENOENT do spawn) antes de produzir qualquer saída.
  const missing = join(tmpdir(), "ff-nao-existe", "ffmpeg");
  const outcome = await captureStderr(() =>
    mixAudio({
      ffmpeg: missing,
      clips: [clip({ clipId: "x", file: join(tmpdir(), "ff-nao-existe", "x.wav") })],
      totalSeconds: 1,
      outPath: join(tmpdir(), "ff-nao-existe", "mix.m4a"),
      loudness: false,
      removeWorkspace: async (path) => {
        workspace = path;
        throw new Error("EBUSY simulado");
      },
    }),
  );

  assert.ok(outcome.error instanceof Error, "o mix tinha de falhar");
  assert.doesNotMatch(outcome.error.message, /EBUSY simulado/, "o erro da remoção não pode trocar o original");
  assert.match(outcome.error.message, /ENOENT|ff-nao-existe/, "o erro original (FFmpeg não executou) sobe intacto");
  assert.ok(workspace !== undefined, "a remoção injetada foi chamada");
  assert.ok(outcome.stderr.includes(`[frankframes] não consegui remover ${workspace}: EBUSY simulado`), `stderr sem o aviso: ${JSON.stringify(outcome.stderr)}`);
});

// ---- EDT-90: true peak do arquivo codificado ----

const measurement = (tp: string, i = "-14.00"): MeasuredLoudness => ({ i, tp, lra: "1.00", thresh: "-24.00", offset: "0.00" });

/** Medidor injetado: devolve as medidas em ordem e conta as chamadas. */
function scriptedMeter(...values: Array<MeasuredLoudness | null>): { measure: () => Promise<MeasuredLoudness | null>; calls: () => number } {
  let calls = 0;
  return {
    measure: async () => {
      const value = values[calls];
      calls += 1;
      if (value === undefined) throw new Error(`medição inesperada nº ${calls}`);
      return value;
    },
    calls: () => calls,
  };
}

test("truePeakCorrectionDb: ganho = limite − medido − margem fixa de 0,2 dB", () => {
  assert.equal(TRUE_PEAK_MARGIN_DB, 0.2);
  assert.ok(Math.abs(truePeakCorrectionDb(-0.77, -1) - -0.43) < 1e-9, "−0,77 dBTP pede −0,43 dB");
  assert.ok(Math.abs(truePeakCorrectionDb(0.6, -1) - -1.8) < 1e-9, "+0,6 dBTP pede −1,8 dB");
  assert.ok(truePeakCorrectionDb(-0.95, -1) < 0, "pico logo acima do limite sempre pede corte");
});

test("enforceTruePeak: dentro do limite não recodifica nem avisa", async () => {
  const meter = scriptedMeter(measurement("-1.00"));
  let reencoded = 0;
  const outcome = await enforceTruePeak({ limitDbtp: -1, measure: meter.measure, reencode: async () => void (reencoded += 1) });
  assert.deepEqual(outcome, { warnings: [], gainDb: null });
  assert.equal(reencoded, 0);
  assert.equal(meter.calls(), 1);
});

test("enforceTruePeak: acima do limite recodifica UMA vez com o ganho da medida e avisa os dB aplicados", async () => {
  const meter = scriptedMeter(measurement("-0.77"), measurement("-1.12", "-14.40"));
  const gains: number[] = [];
  const outcome = await enforceTruePeak({ limitDbtp: -1, measure: meter.measure, reencode: async (gain) => void gains.push(gain) });

  assert.equal(gains.length, 1, "uma única recodificação");
  assert.ok(Math.abs(gains[0]! - -0.43) < 1e-9, `ganho ${gains[0]}`);
  assert.equal(meter.calls(), 2, "mede antes e depois, nada além");
  assert.equal(outcome.gainDb, gains[0]);
  assert.equal(outcome.warnings.length, 1);
  assert.match(outcome.warnings[0]!, /-0\.77 dBTP acima do limite -1 dBTP; ganho de -0\.43 dB aplicado/);
  assert.match(outcome.warnings[0]!, /agora -1\.12 dBTP, -14\.4 LUFS/);
});

test("enforceTruePeak: ainda acima depois da correção falha alto com E_AUDIO_TRUE_PEAK, sem segunda correção", async () => {
  const meter = scriptedMeter(measurement("-0.50"), measurement("-0.90"));
  let reencoded = 0;
  await assert.rejects(
    enforceTruePeak({ limitDbtp: -1, measure: meter.measure, reencode: async () => void (reencoded += 1) }),
    (error: unknown) => {
      assert.ok(error instanceof AudioTruePeakError);
      assert.equal(error.code, "E_AUDIO_TRUE_PEAK");
      assert.equal(error.measuredDbtp, -0.9);
      assert.equal(error.limitDbtp, -1);
      assert.match(error.message, /-0\.50 dBTP.*-0\.90 dBTP/s, "a mensagem traz as duas medidas");
      assert.ok(error.hint.length > 10, "hint acionável");
      return true;
    },
  );
  assert.equal(reencoded, 1, "nunca mais de uma recodificação");
  assert.equal(meter.calls(), 2);
});

test("enforceTruePeak: medição ausente ou ilegível falha alto, antes e depois da correção", async () => {
  const unmeasured = scriptedMeter(null);
  await assert.rejects(
    enforceTruePeak({ limitDbtp: -1, measure: unmeasured.measure, reencode: async () => assert.fail("não recodifica sem medida") }),
    (error: unknown) => error instanceof AudioTruePeakError && error.measuredDbtp === null && /não consegui medir/.test(error.message),
  );
  const garbage = scriptedMeter(measurement("lixo"));
  await assert.rejects(
    enforceTruePeak({ limitDbtp: -1, measure: garbage.measure, reencode: async () => assert.fail("não recodifica sem medida") }),
    (error: unknown) => error instanceof AudioTruePeakError && /ilegível/.test(error.message),
  );
  const lostAfter = scriptedMeter(measurement("-0.50"), null);
  await assert.rejects(
    enforceTruePeak({ limitDbtp: -1, measure: lostAfter.measure, reencode: async () => undefined }),
    (error: unknown) => error instanceof AudioTruePeakError && /depois da correção/.test(error.message),
  );
});

test("enforceTruePeak: pico -inf (sem sinal) passa sem recodificar", async () => {
  const meter = scriptedMeter(measurement("-inf"));
  const outcome = await enforceTruePeak({ limitDbtp: -1, measure: meter.measure, reencode: async () => assert.fail("nada a corrigir") });
  assert.deepEqual(outcome, { warnings: [], gainDb: null });
});

test("buildAudioGraph: postGainDb entra DEPOIS do loudnorm e só com loudnorm", () => {
  const clips = [clip({ clipId: "a", file: "/media/a.wav" })];
  const withGain = buildAudioGraph(clips, 1, 1, { loudness: DELIVERY_LOUDNESS, postGainDb: -0.43 });
  assert.match(withGain.filter, /loudnorm=I=-14:TP=-1:LRA=11,volume=-0\.43dB\[out\]$/);
  assert.doesNotMatch(buildAudioGraph(clips, 1, 1, { loudness: DELIVERY_LOUDNESS }).filter, /dB\[out\]/);
  assert.doesNotMatch(buildAudioGraph(clips, 1, 1, { postGainDb: -0.43 }).filter, /dB\[out\]/, "sem loudnorm não há correção de pico");
});

test("E_AUDIO_TRUE_PEAK está na allowlist de render e no código registrado", () => {
  for (const code of AUDIO_ERROR_CODES) assert.ok(RENDER_ERROR_CODES.includes(code), `${code} fora de RENDER_ERROR_CODES`);
});

/**
 * Cliques de 1–2 amostras sobre um tom a 440 Hz: depois do loudnorm (TP=-1) o PCM respeita o teto, mas o AAC e o
 * Opus sobem o pico entre amostras (medido: AAC −0,77 dBTP, Opus −0,85 dBTP, ambos com ~−14,1 LUFS).
 */
const CLICK_SIGNAL = "aevalsrc='0.26*sin(2*PI*440*t)+0.9*lt(mod(t,0.1),0.00003)':s=48000:d=3";
/** Medidor que sempre aprova: reproduz o comportamento anterior (ninguém mede o arquivo codificado). */
const BLIND_METER = async (): Promise<MeasuredLoudness> => measurement("-99");

async function ffmpegOrSkip(t: { skip: (reason: string) => void }): Promise<{ ffmpeg: string } | null> {
  try {
    return { ffmpeg: (await resolveFfmpeg()).ffmpeg };
  } catch (error) {
    t.skip(`FFmpeg indisponível: ${(error as Error).message}`);
    return null;
  }
}

for (const [format, extension] of [["aac", "m4a"], ["opus", "opus"]] as const) {
  test(`integração: sem a correção o ${format} estoura −1 dBTP; com ela o arquivo entregue mede ≤ −1 dBTP e avisa`, { timeout: 180_000 }, async (t) => {
    const tools = await ffmpegOrSkip(t);
    if (tools === null) return;
    const { ffmpeg } = tools;
    const dir = await tempDir(t, "ff-true-peak-");
    const source = join(dir, "cliques.wav");
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", CLICK_SIGNAL, "-ac", "2", "-ar", "48000", "-y", source]);
    const clips = [clip({ clipId: "cliques", file: source, duration: 3 })];

    // Premissa (comportamento antigo): medidor cego = nenhuma correção. O arquivo estoura o limite de entrega.
    const blindPath = join(dir, `cego.${extension}`);
    const blind = await mixAudio({ ffmpeg, clips, totalSeconds: 3, outPath: blindPath, format, measureEncoded: BLIND_METER });
    assert.deepEqual(blind.warnings, [], "sem correção não há aviso");
    const blindMeasure = await measureLoudness(ffmpeg, blindPath);
    assert.ok(blindMeasure !== null);
    assert.ok(Number(blindMeasure.tp) > DELIVERY_LOUDNESS.truePeakDbtp, `premissa do teste: o ${format} deveria estourar, mediu ${blindMeasure.tp} dBTP`);

    // Com a garantia (medidor real): o arquivo final passa e o aviso traz os dB aplicados.
    const outPath = join(dir, `entrega.${extension}`);
    const result = await mixAudio({ ffmpeg, clips, totalSeconds: 3, outPath, format });
    const delivered = await measureLoudness(ffmpeg, outPath);
    assert.ok(delivered !== null);
    assert.ok(Number(delivered.tp) <= DELIVERY_LOUDNESS.truePeakDbtp, `arquivo entregue mede ${delivered.tp} dBTP, limite ${DELIVERY_LOUDNESS.truePeakDbtp}`);
    assert.ok(Math.abs(Number(delivered.i) - DELIVERY_LOUDNESS.targetLufs) <= 1, `loudness integrado ${delivered.i} LUFS fora de −14 ± 1`);
    const warning = result.warnings.find((text) => /true peak do arquivo codificado/.test(text));
    assert.ok(warning !== undefined, `warnings sem o aviso de correção: ${JSON.stringify(result.warnings)}`);
    assert.match(warning, new RegExp(`${Number(blindMeasure.tp).toFixed(2)} dBTP acima do limite -1 dBTP; ganho de -\\d+\\.\\d{2} dB aplicado`));
  });
}

test("integração: mixAudio falha alto com E_AUDIO_TRUE_PEAK quando a medida do arquivo corrigido ainda passa do limite", { timeout: 120_000 }, async (t) => {
  const tools = await ffmpegOrSkip(t);
  if (tools === null) return;
  const { ffmpeg } = tools;
  const dir = await tempDir(t, "ff-true-peak-");
  const tone = join(dir, "tom.wav");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=2", "-ac", "2", "-y", tone]);

  let calls = 0;
  await assert.rejects(
    mixAudio({
      ffmpeg,
      clips: [clip({ clipId: "tom", file: tone, duration: 2 })],
      totalSeconds: 2,
      outPath: join(dir, "mix.m4a"),
      measureEncoded: async () => {
        calls += 1;
        return measurement("-0.40");
      },
    }),
    (error: unknown) => error instanceof AudioTruePeakError && error.code === "E_AUDIO_TRUE_PEAK" && error.measuredDbtp === -0.4,
  );
  assert.equal(calls, 2, "mede, corrige uma vez, mede de novo e para");
});

test("integração: loudness:false, mix silencioso e WAV do preview não medem nem corrigem o arquivo codificado", { timeout: 120_000 }, async (t) => {
  const tools = await ffmpegOrSkip(t);
  if (tools === null) return;
  const { ffmpeg } = tools;
  const dir = await tempDir(t, "ff-true-peak-");
  const tone = join(dir, "tom.wav");
  const silent = join(dir, "mudo.wav");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=1", "-ac", "2", "-y", tone]);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "1", "-y", silent]);
  const forbidden = async (): Promise<MeasuredLoudness> => assert.fail("não deve medir o arquivo codificado");

  const raw = await mixAudio({ ffmpeg, clips: [clip({ clipId: "tom", file: tone })], totalSeconds: 1, outPath: join(dir, "cru.m4a"), loudness: false, measureEncoded: forbidden });
  assert.deepEqual(raw.warnings, []);
  const mute = await mixAudio({ ffmpeg, clips: [clip({ clipId: "mudo", file: silent })], totalSeconds: 1, outPath: join(dir, "mudo.m4a"), measureEncoded: forbidden });
  assert.ok(mute.warnings.some((warning) => /áudio silencioso/.test(warning)));
  const wav = await mixAudio({ ffmpeg, clips: [clip({ clipId: "tom", file: tone })], totalSeconds: 1, outPath: join(dir, "preview.wav"), format: "wav", measureEncoded: forbidden });
  assert.ok(!wav.warnings.some((warning) => /true peak/.test(warning)));
});
