// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-64: verificações do aceite (scripts/accept-video.ts). Nada aqui usa o vídeo do titular:
// as fixtures são sintéticas (FFmpeg lavfi) e moram em um temporário isolado.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ACCEPT_ERROR_CODES,
  AcceptError,
  CAPTION_SETTLE_SECONDS,
  PSNR_CAP,
  captionInstant,
  captionSegments,
  checkDuration,
  checkKeyframe,
  checkLoudness,
  framePsnr,
  parseAcceptArgs,
  parseKeyframeSpec,
  parseRegion,
  probeMedia,
  runAcceptance,
  sourceOffsetOf,
} from "../../../scripts/accept-video.ts";
import type { CheckResult, DurationInput, KeyframeSpec, LoudnessInput } from "../../../scripts/accept-video.ts";
import { mixAudio, measureLoudness } from "../src/audio.ts";
import { buildCaptionComposition } from "../src/captions.ts";
import { resolveFfmpeg } from "../src/ffmpeg.ts";
import { makeTempDir } from "../../../scripts/test-support/temp.ts";

const run = promisify(execFile);

/** Erro do aceite com o código esperado e uma dica que diga o que fazer. */
function acceptError(code: (typeof ACCEPT_ERROR_CODES)[number], fn: () => unknown): AcceptError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AcceptError, `esperava AcceptError, veio ${String(error)}`);
    assert.equal(error.code, code, error.message);
    assert.ok(error.hint.length > 10, "hint acionável");
    return error;
  }
  assert.fail(`devia falhar com ${code}`);
}

const byName = (checks: CheckResult[], name: string): CheckResult => {
  const found = checks.find((check) => check.name === name);
  assert.ok(found !== undefined, `verificação ${name} ausente em ${checks.map((c) => c.name).join(", ")}`);
  return found;
};

const FPS30 = { num: 30, den: 1 };
const FULL_HD = { width: 1920, height: 1080, seconds: 30 };
const PORTRAIT_HD = { width: 1080, height: 1920, seconds: 30 };

// ------------------------------------------------------------------------------------ checkDuration

const goodDuration: DurationInput = { lintSeconds: 30, mp4Seconds: 30, nbFrames: 900, fps: FPS30, expectedSeconds: 30 };

test("checkDuration: duração exata e 900 frames passam em todas as verificações", () => {
  const checks = checkDuration(goodDuration);
  assert.deepEqual(checks.map((check) => check.name), ["duration.lint", "duration.mp4", "duration.frames"]);
  assert.ok(checks.every((check) => check.ok), JSON.stringify(checks));
});

test("checkDuration: aceita ±1 frame no MP4 e recusa 2 frames", () => {
  const frame = 1 / 30;
  for (const mp4Seconds of [30 + frame, 30 - frame]) {
    assert.equal(byName(checkDuration({ ...goodDuration, mp4Seconds }), "duration.mp4").ok, true, `diferença ${mp4Seconds - 30}`);
  }
  for (const mp4Seconds of [30 + 2 * frame, 30 - 2 * frame]) {
    const check = byName(checkDuration({ ...goodDuration, mp4Seconds }), "duration.mp4");
    assert.equal(check.ok, false, `diferença ${mp4Seconds - 30}`);
    assert.ok(typeof check.medido["diff"] === "number" && Math.abs(check.medido["diff"]) > frame);
  }
});

test("checkDuration: a tolerância de 1 frame segue o fps (29,97 fps)", () => {
  const ntsc = { num: 30000, den: 1001 };
  const base: DurationInput = { lintSeconds: 30, mp4Seconds: 30, nbFrames: 900, fps: ntsc, expectedSeconds: 30 };
  assert.equal(byName(checkDuration({ ...base, mp4Seconds: 30 + 1001 / 30000 }), "duration.mp4").ok, true);
  assert.equal(byName(checkDuration({ ...base, mp4Seconds: 30 + 2002 / 30000 }), "duration.mp4").ok, false);
});

test("checkDuration: a contagem de frames é exata (899 e 901 reprovam)", () => {
  for (const nbFrames of [899, 901]) assert.equal(byName(checkDuration({ ...goodDuration, nbFrames }), "duration.frames").ok, false, String(nbFrames));
  // 30 s a 24 fps: o esperado vem de frameCountFor, não de 30 fixo.
  const at24 = checkDuration({ lintSeconds: 30, mp4Seconds: 30, nbFrames: 720, fps: { num: 24, den: 1 }, expectedSeconds: 30 });
  assert.ok(at24.every((check) => check.ok));
});

test("checkDuration: o lint precisa dizer a duração prometida (30,000)", () => {
  const check = byName(checkDuration({ ...goodDuration, lintSeconds: 29.9, mp4Seconds: 29.9 }), "duration.lint");
  assert.equal(check.ok, false);
  assert.equal(check.esperado["seconds"], 30);
});

test("checkDuration: entrada inválida falha alto com E_ACCEPT_INPUT", () => {
  for (const bad of [{ lintSeconds: Number.NaN }, { mp4Seconds: Number.POSITIVE_INFINITY }, { nbFrames: Number.NaN }, { fps: { num: 0, den: 1 } }, { fps: { num: 30, den: 0 } }, { fps: { num: 29.97, den: 1 } }]) {
    acceptError("E_ACCEPT_INPUT", () => checkDuration({ ...goodDuration, ...bad }));
  }
});

// ------------------------------------------------------------------------------------ checkLoudness

const goodLoudness: LoudnessInput = {
  measured: { i: "-14.02", tp: "-1.10", lra: "3.0", thresh: "-24.0", offset: "0.0" },
  audioSeconds: 30,
  videoSeconds: 30,
  fps: FPS30,
};

test("checkLoudness: -14 LUFS, -1,1 dBTP e áudio do tamanho do vídeo passam", () => {
  const checks = checkLoudness(goodLoudness);
  assert.deepEqual(checks.map((check) => check.name), ["audio.stream", "audio.lufs", "audio.truePeak", "audio.duration"]);
  assert.ok(checks.every((check) => check.ok), JSON.stringify(checks));
});

test("checkLoudness: recusa -16 LUFS e aceita as bordas -15 e -13", () => {
  const lufs = (i: string): CheckResult => byName(checkLoudness({ ...goodLoudness, measured: { ...goodLoudness.measured!, i } }), "audio.lufs");
  assert.equal(lufs("-16.00").ok, false);
  assert.equal(lufs("-12.90").ok, false);
  assert.equal(lufs("-15.00").ok, true);
  assert.equal(lufs("-13.00").ok, true);
  assert.equal(lufs("-16.00").medido["lufs"], -16);
});

test("checkLoudness: recusa true peak -0,5 e aceita a borda -0,9", () => {
  const peak = (tp: string): CheckResult => byName(checkLoudness({ ...goodLoudness, measured: { ...goodLoudness.measured!, tp } }), "audio.truePeak");
  assert.equal(peak("-0.50").ok, false);
  assert.equal(peak("-0.80").ok, false);
  assert.equal(peak("-0.90").ok, true);
  assert.equal(peak("-3.00").ok, true);
});

test("checkLoudness: silêncio (-inf) é medida válida que reprova, não erro", () => {
  const checks = checkLoudness({ ...goodLoudness, measured: { ...goodLoudness.measured!, i: "-inf", tp: "-inf" } });
  const lufs = byName(checks, "audio.lufs");
  assert.equal(lufs.ok, false);
  assert.equal(lufs.medido["lufs"], "-Infinity", "sobrevive ao JSON como texto");
});

test("checkLoudness: MP4 sem áudio reprova audio.stream; duração do áudio fora de 1 frame reprova", () => {
  const silent = checkLoudness({ ...goodLoudness, measured: null, audioSeconds: null });
  assert.deepEqual(silent.map((check) => [check.name, check.ok]), [["audio.stream", false]]);

  const frame = 1 / 30;
  assert.equal(byName(checkLoudness({ ...goodLoudness, audioSeconds: 30 + frame }), "audio.duration").ok, true);
  assert.equal(byName(checkLoudness({ ...goodLoudness, audioSeconds: 30 - 2 * frame }), "audio.duration").ok, false);
});

test("checkLoudness: medição ausente ou ilegível falha alto com E_ACCEPT_MEASURE", () => {
  const missing = acceptError("E_ACCEPT_MEASURE", () => checkLoudness({ ...goodLoudness, measured: null }));
  assert.match(missing.hint, /loudnorm/);
  for (const bad of [{ i: "abc" }, { i: "" }, { tp: "NaN" }]) {
    acceptError("E_ACCEPT_MEASURE", () => checkLoudness({ ...goodLoudness, measured: { ...goodLoudness.measured!, ...bad } }));
  }
  acceptError("E_ACCEPT_INPUT", () => checkLoudness({ ...goodLoudness, videoSeconds: Number.NaN }));
});

// ------------------------------------------------------------------------------------ parseKeyframeSpec

test("parseKeyframeSpec: o spec do A001 (scripts/accept/keyframes-a001.json) cabe em 1080x1920 / 30 s", () => {
  // O A001 sai em vertical: a fonte é 1920x1080 com rotação -90 (exibe 1080x1920) e o projeto de aceite é 1080x1920.
  const raw: unknown = JSON.parse(readFileSync(new URL("../../../scripts/accept/keyframes-a001.json", import.meta.url), "utf8"));
  const specs = parseKeyframeSpec(raw, PORTRAIT_HD);
  assert.deepEqual(specs.map((spec) => spec.kind), ["match", "match", "motion-enter", "lower-third", "caption"]);
  assert.deepEqual(specs[0], { kind: "match", t: 1, source: 9, region: { x: 0, y: 0, w: 1080, h: 640 }, minPsnr: 30 });
  assert.deepEqual(specs[1], { kind: "match", t: 29.5, source: 37.5, region: { x: 0, y: 0, w: 1080, h: 640 }, minPsnr: 30 });
  // a entrada animada é a do bloco "Crédito vertical" (faixa amarela, y 1110–1540), inserido em 5 s com "subir"
  assert.deepEqual(specs[2], { kind: "motion-enter", t: 5.3, from: 5.1, to: 5.9, region: { x: 0, y: 1110, w: 1080, h: 430 }, maxPsnr: 40 });
  assert.deepEqual(specs[3], { kind: "lower-third", t: 6, source: null, region: { x: 0, y: 1110, w: 260, h: 430 }, maxPsnr: 30 });
  assert.deepEqual(specs[4], { kind: "caption", t: "palavra", source: null, region: { x: 220, y: 1340, w: 640, h: 410 }, maxPsnr: 30 });
  assert.equal(sourceOffsetOf(specs), 8, "corte em 8 s: fonte = MP4 + 8");
  // as regiões do vertical não cabem num quadro 16:9: o spec não vale para outro formato
  acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec(raw, FULL_HD));
});

test("parseKeyframeSpec: recusa região fora do quadro (E_ACCEPT_SPEC com a região na mensagem)", () => {
  for (const region of ["0,0,1921,700", "0,400,1920,700", "1900,0,100,100", "0,1000,10,81"]) {
    const error = acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec([{ t: 1, source: 9, region, minPsnr: 30 }], FULL_HD));
    assert.match(error.message, /sai do quadro 1920x1080/, region);
    assert.ok(error.message.includes(region));
  }
  // a borda exata do quadro é válida
  assert.doesNotThrow(() => parseKeyframeSpec([{ t: 1, source: 9, region: "0,0,1920,1080" }], FULL_HD));
});

test("parseKeyframeSpec: região malformada, vazia ou com área zero é recusada", () => {
  for (const region of ["", "0,0,10", "a,b,c,d", "0,0,-5,10", "0.5,0,10,10", "0,0,0,10", "0,0,10,0", 42, undefined, null]) {
    acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec([{ t: 1, source: 9, region }], FULL_HD));
  }
  assert.deepEqual(parseRegion(" 1,2,3,4 ", FULL_HD), { x: 1, y: 2, w: 3, h: 4 });
});

test("parseKeyframeSpec: instante fora do vídeo, valor não numérico e campo desconhecido são recusados", () => {
  const ok = { source: 9, region: "0,0,100,100" };
  for (const t of [-1, 30, 31, Number.NaN, "1", null]) acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec([{ ...ok, t }], FULL_HD));
  acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec([{ t: 1, region: "0,0,100,100" }], FULL_HD)); // falta source
  acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec([{ t: 1, ...ok, minPsnr: "alto" }], FULL_HD));
  const typo = acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec([{ t: 1, ...ok, minPsn: 30 }], FULL_HD));
  assert.match(typo.message, /minPsn/);
  assert.match(typo.message, /keyframes\[0\]/);
});

test("parseKeyframeSpec: lista vazia, não lista e item que não é objeto são recusados", () => {
  for (const raw of [[], {}, "x", null, undefined, [1], [null], [[]]]) acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec(raw, FULL_HD));
});

test("parseKeyframeSpec: expect desconhecido, `palavra` fora da legenda e movimento incoerente são recusados", () => {
  const region = "0,700,1920,380";
  acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec([{ t: 1, expect: "lower-thrid", region, source: 9 }], FULL_HD));
  acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec([{ t: "palavra", expect: "lower-third", region, source: 9 }], FULL_HD));
  acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec([{ t: 0.3, expect: "motion-enter", from: 0.9, to: 0.1 }], FULL_HD));
  acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec([{ t: 5, expect: "motion-enter" }], FULL_HD)); // t fora de [from, to]
  acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec([{ t: 0.3, expect: "motion-enter", to: 40 }], FULL_HD));
  acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec([{ t: 0.3, expect: "motion-enter", region: "0,0,2000,10" }], FULL_HD));
});

test("parseKeyframeSpec: camada sem `source` e sem item de comparação não tem como achar a fonte", () => {
  const error = acceptError("E_ACCEPT_SPEC", () => parseKeyframeSpec([{ t: 6, expect: "lower-third", region: "0,700,1920,380" }], FULL_HD));
  assert.match(error.message, /offset/);
  // com `source` explícito não precisa de item de comparação
  const [spec] = parseKeyframeSpec([{ t: 6, expect: "lower-third", source: 14, region: "0,700,1920,380" }], FULL_HD);
  assert.equal(spec!.kind === "lower-third" && spec!.source, 14);
  assert.equal(sourceOffsetOf([spec!]), null);
});

test("parseKeyframeSpec: motion-enter sem região usa o quadro inteiro", () => {
  const [spec] = parseKeyframeSpec([{ t: 0.3, expect: "motion-enter" }], FULL_HD);
  assert.deepEqual(spec!.kind === "motion-enter" && spec!.region, { x: 0, y: 0, w: 1920, h: 1080 });
});

// ------------------------------------------------------------------------------------ checkKeyframe

const REGION = { x: 0, y: 0, w: 100, h: 100 };
const match: KeyframeSpec = { kind: "match", t: 1, source: 9, region: REGION, minPsnr: 30 };

test("checkKeyframe: comparação com a fonte vale o melhor PSNR (frame vizinho incluso)", () => {
  assert.equal(checkKeyframe(0, match, { psnrs: [35] }).ok, true);
  assert.equal(checkKeyframe(0, match, { psnrs: [30] }).ok, true, "borda inclusiva");
  assert.equal(checkKeyframe(0, match, { psnrs: [29.9] }).ok, false);
  const withNeighbor = checkKeyframe(0, match, { psnrs: [24, 33, 21] });
  assert.equal(withNeighbor.ok, true);
  assert.equal(withNeighbor.medido["psnr"], 33);
  assert.equal(withNeighbor.medido["tried"], 3);
});

test("checkKeyframe: camada (lower-third/legenda) só passa quando difere da fonte (PSNR < 30)", () => {
  const lower: KeyframeSpec = { kind: "lower-third", t: 6, source: null, region: REGION, maxPsnr: 30 };
  assert.equal(checkKeyframe(3, lower, { psnrs: [12] }).ok, true);
  assert.equal(checkKeyframe(3, lower, { psnrs: [30] }).ok, false, "30 dB = igual à fonte: a camada não está lá");
  assert.equal(checkKeyframe(3, lower, { psnrs: [PSNR_CAP] }).ok, false);
  const caption: KeyframeSpec = { kind: "caption", t: 4, source: null, region: REGION, maxPsnr: 30 };
  assert.equal(checkKeyframe(4, caption, { psnrs: [18] }).ok, true);
  assert.equal(checkKeyframe(4, caption, { psnrs: [45] }).ok, false);
});

test("checkKeyframe: motion-enter exige PSNR < 40 entre os frames E frame final não chapado", () => {
  const motion: KeyframeSpec = { kind: "motion-enter", t: 0.3, from: 0.1, to: 0.9, region: REGION, maxPsnr: 40 };
  assert.equal(checkKeyframe(2, motion, { psnrs: [20], uniformAtEnd: false }).ok, true);
  assert.equal(checkKeyframe(2, motion, { psnrs: [20], uniformAtEnd: true }).ok, false, "tela chapada em 0,9 s");
  assert.equal(checkKeyframe(2, motion, { psnrs: [PSNR_CAP], uniformAtEnd: false }).ok, false, "frames iguais: sem movimento");
  acceptError("E_ACCEPT_INPUT", () => checkKeyframe(2, motion, { psnrs: [20] }));
});

test("checkKeyframe: sem medida ou com PSNR inválido falha alto (nunca passa em silêncio)", () => {
  acceptError("E_ACCEPT_INPUT", () => checkKeyframe(0, match, { psnrs: [] }));
  acceptError("E_ACCEPT_INPUT", () => checkKeyframe(0, match, { psnrs: [Number.NaN] }));
});

// ------------------------------------------------------------------------------------ legendas e argumentos

test("captionSegments/captionInstant: lê os clips do `captions` e dá o instante em que o texto já está na tela", () => {
  const html = buildCaptionComposition([
    { start: 2, end: 4, text: "primeira legenda" },
    { start: 5, end: 5.2, text: "curta" },
  ]);
  assert.deepEqual(captionSegments(html), [{ start: 2, duration: 2 }, { start: 5, duration: 0.2 }]);
  assert.equal(captionInstant(captionSegments(html)), 2 + CAPTION_SETTLE_SECONDS);
  assert.equal(captionInstant([{ start: 5, duration: 0.2 }]), 5.1, "legenda curta: no máximo metade da duração");
  acceptError("E_ACCEPT_INPUT", () => captionSegments("<html><body>nada</body></html>"));
  acceptError("E_ACCEPT_INPUT", () => captionInstant([]));
});

test("parseAcceptArgs: caminhos resolvidos, aceite.json ao lado do MP4 e erros E_ACCEPT_ARGS", () => {
  const args = parseAcceptArgs(["out/x/final.mp4", "--entry", "out/x/index.html", "--source", "A.MOV", "--spec", "s.json"]);
  assert.equal(args.expectedSeconds, 30);
  assert.ok(args.out.endsWith("aceite.json") && args.out.includes("x"));
  assert.equal(args.captions, undefined);
  assert.equal(parseAcceptArgs(["f.mp4", "--entry", "e", "--source", "s", "--spec", "p", "--expected-seconds", "2"]).expectedSeconds, 2);

  for (const argv of [[], ["f.mp4"], ["f.mp4", "--entry", "e", "--source", "s"], ["a.mp4", "b.mp4", "--entry", "e", "--source", "s", "--spec", "p"], ["f.mp4", "--entry", "e", "--source", "s", "--spec", "p", "--nope", "1"], ["f.mp4", "--entry", "e", "--source", "s", "--spec", "p", "--expected-seconds", "0"]]) {
    const error = acceptError("E_ACCEPT_ARGS", () => parseAcceptArgs(argv));
    assert.match(error.hint, /uso: node scripts\/accept-video\.ts/);
  }
});

test("ACCEPT_ERROR_CODES lista exatamente os códigos emitidos", () => {
  assert.deepEqual([...ACCEPT_ERROR_CODES], ["E_ACCEPT_ARGS", "E_ACCEPT_SPEC", "E_ACCEPT_INPUT", "E_ACCEPT_MEASURE", "E_ACCEPT_TOOL"]);
});

// ------------------------------------------------------------------------------------ FFmpeg real (skip explícito)

interface Fixtures {
  dir: string;
  ffmpeg: string;
  ffprobe: string;
  source: string;
  final: string;
  rawLoudFinal: string;
  /** Mesmo corte, um frame da fonte adiante: o frame exato não casa, o vizinho sim. */
  shiftedFinal: string;
  entry: string;
  captionsHtml: string;
}

const W = 320;
const H = 180;
const PLAIN_ENTRY = `<html><body><div data-composition-id="main" data-root="true" data-width="${W}" data-height="${H}"
  data-fps="24" data-duration="2"><div data-clip-id="t" data-start="0" data-duration="2">oi</div></div></body></html>`;

let fixturesPromise: Promise<Fixtures | undefined> | undefined;
const removers: Array<() => Promise<void>> = [];

async function buildFixtures(): Promise<Fixtures | undefined> {
  let pair;
  try {
    pair = await resolveFfmpeg();
    await run(pair.ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
    await run(pair.ffprobe, ["-hide_banner", "-version"], { timeout: 15_000 });
  } catch {
    return undefined;
  }
  const { ffmpeg, ffprobe } = pair;
  const { dir, remove } = await makeTempDir("ff-accept-fixture-");
  removers.push(remove);
  const ff = (args: string[]): Promise<unknown> => run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 120_000 });

  // Fonte: 8 s de padrão de teste a 24 fps (só encoders nativos: mpeg4/aac, nenhum GPL).
  const source = join(dir, "fonte.mp4");
  await ff(["-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=24:duration=8`, "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", source]);

  // Tom de 1 kHz: cru (baixo demais para a entrega) e normalizado pelo mixAudio de produção.
  const tone = join(dir, "tom.wav");
  await ff(["-f", "lavfi", "-i", "sine=frequency=1000:duration=2:sample_rate=48000", "-c:a", "pcm_s16le", tone]);
  const normalized = join(dir, "tom-norm.m4a");
  await mixAudio({ ffmpeg, clips: [{ clipId: "tom", file: tone, start: 0, duration: 2, offset: 0, playbackRate: 1, volume: 1 }], totalSeconds: 2, outPath: normalized });
  const raw = join(dir, "tom-cru.m4a");
  await mixAudio({ ffmpeg, clips: [{ clipId: "tom", file: tone, start: 0, duration: 2, offset: 0, playbackRate: 1, volume: 1 }], totalSeconds: 2, outPath: raw, loudness: false });

  // Final: corte da fonte a partir de 3 s (offset 3), fade-in no começo (movimento) e uma faixa vermelha
  // embaixo a partir de 0,5 s (a "camada": lower-third e legenda).
  const video = join(dir, "video.mp4");
  await ff([
    "-ss", "3", "-t", "2", "-i", source,
    "-vf", `fade=t=in:st=0:d=1,drawbox=x=0:y=120:w=${W}:h=60:color=red@1:t=fill:enable='gte(t,0.5)'`,
    "-r", "24", "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", video,
  ]);
  const final = join(dir, "final.mp4");
  await ff(["-i", video, "-i", normalized, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy", final]);
  const rawLoudFinal = join(dir, "final-cru.mp4");
  await ff(["-i", video, "-i", raw, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy", rawLoudFinal]);

  const shiftedVideo = join(dir, "video-deslocado.mp4");
  await ff(["-ss", String(3 + 1 / 24), "-t", "2", "-i", source, "-r", "24", "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", shiftedVideo]);
  const shiftedFinal = join(dir, "final-deslocado.mp4");
  await ff(["-i", shiftedVideo, "-i", normalized, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy", shiftedFinal]);

  const entry = join(dir, "index.html");
  await writeFile(entry, PLAIN_ENTRY);
  const captionsHtml = buildCaptionComposition([{ start: 1, end: 2, text: "olá" }], { width: W, height: H, fps: 24 });
  return { dir, ffmpeg, ffprobe, source, final, rawLoudFinal, shiftedFinal, entry, captionsHtml };
}

const fixtures = (): Promise<Fixtures | undefined> => (fixturesPromise ??= buildFixtures());

after(async () => {
  await Promise.all(removers.map((remove) => remove()));
});

/** Spec da fixture: mesmo formato do A001, em coordenadas de 320x180 e 2 s. */
const FIXTURE_SPEC = [
  { t: 1.5, source: 4.5, region: "0,0,320,100", minPsnr: 30 },
  { t: 0.5, expect: "motion-enter", from: 0.1, to: 0.9 },
  { t: 1.2, expect: "lower-third", region: "0,120,320,60" },
  { t: "palavra", expect: "caption", region: "0,120,320,60" },
];

test("FFmpeg real: tom de 1 kHz normalizado pelo mixAudio passa no checkLoudness; o cru reprova", { timeout: 300_000 }, async (t) => {
  const fx = await fixtures();
  if (fx === undefined) return t.skip("FFmpeg/FFprobe indisponível");

  const probe = await probeMedia(fx.ffprobe, fx.final);
  assert.equal(probe.nbFrames, 48);
  assert.deepEqual(probe.fps, { num: 24, den: 1 });
  assert.notEqual(probe.audioSeconds, null);

  const measured = await measureLoudness(fx.ffmpeg, fx.final);
  const input: LoudnessInput = { measured, audioSeconds: probe.audioSeconds, videoSeconds: probe.videoSeconds, fps: probe.fps };
  const checks = checkLoudness(input);
  assert.ok(checks.every((check) => check.ok), `normalizado: ${JSON.stringify(checks)}`);

  const rawProbe = await probeMedia(fx.ffprobe, fx.rawLoudFinal);
  const rawChecks = checkLoudness({ measured: await measureLoudness(fx.ffmpeg, fx.rawLoudFinal), audioSeconds: rawProbe.audioSeconds, videoSeconds: rawProbe.videoSeconds, fps: rawProbe.fps });
  assert.equal(byName(rawChecks, "audio.lufs").ok, false, `cru: ${JSON.stringify(byName(rawChecks, "audio.lufs").medido)}`);
});

test("FFmpeg real: framePsnr dá o teto para frames iguais e valor baixo para frames diferentes", { timeout: 120_000 }, async (t) => {
  const fx = await fixtures();
  if (fx === undefined) return t.skip("FFmpeg/FFprobe indisponível");
  const size = { width: W, height: H };
  const region = { x: 0, y: 0, w: 320, h: 100 };
  assert.equal(await framePsnr(fx.ffmpeg, { file: fx.source, t: 1 }, { file: fx.source, t: 1 }, region, size), PSNR_CAP);
  const different = await framePsnr(fx.ffmpeg, { file: fx.source, t: 1 }, { file: fx.source, t: 6 }, region, size);
  assert.ok(different < 30, `frames de instantes distantes: ${different} dB`);
  await assert.rejects(framePsnr(fx.ffmpeg, { file: fx.source, t: 100 }, { file: fx.source, t: 1 }, region, size), (error: unknown) => error instanceof AcceptError && error.code === "E_ACCEPT_TOOL" && error.hint.length > 10);
});

test("FFmpeg real: runAcceptance aprova o MP4 sintético em todas as verificações", { timeout: 300_000 }, async (t) => {
  const fx = await fixtures();
  if (fx === undefined) return t.skip("FFmpeg/FFprobe indisponível");

  const report = await runAcceptance({ final: fx.final, entry: fx.entry, source: fx.source, spec: FIXTURE_SPEC, captionsHtml: fx.captionsHtml, expectedSeconds: 2 });
  const failed = report.checks.filter((check) => !check.ok);
  assert.deepEqual(failed, [], `reprovadas: ${JSON.stringify(failed)}`);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((check) => check.name), [
    "lint",
    "duration.lint", "duration.mp4", "duration.frames",
    "audio.stream", "audio.lufs", "audio.truePeak", "audio.duration",
    "keyframe[0].match", "keyframe[1].motion-enter", "keyframe[2].lower-third", "keyframe[3].caption",
  ]);
  // o relatório é JSON puro com {name, ok, medido, esperado}
  const roundTrip = JSON.parse(JSON.stringify(report)) as typeof report;
  for (const check of roundTrip.checks) assert.deepEqual(Object.keys(check).sort(), ["esperado", "medido", "name", "ok"]);
});

test("FFmpeg real: runAcceptance reprova só o que está errado (áudio cru, camada ausente, corte errado, duração)", { timeout: 300_000 }, async (t) => {
  const fx = await fixtures();
  if (fx === undefined) return t.skip("FFmpeg/FFprobe indisponível");
  const base = { entry: fx.entry, source: fx.source, spec: FIXTURE_SPEC, captionsHtml: fx.captionsHtml, expectedSeconds: 2 };

  const quiet = await runAcceptance({ ...base, final: fx.rawLoudFinal });
  assert.deepEqual(quiet.checks.filter((check) => !check.ok).map((check) => check.name), ["audio.lufs"]);
  assert.equal(quiet.ok, false);

  // Região de cima: o MP4 igual à fonte ali, então "camada presente" tem de reprovar.
  const noLayer = await runAcceptance({ ...base, final: fx.final, spec: [FIXTURE_SPEC[0], { t: 1.2, expect: "lower-third", region: "0,0,320,100" }] });
  assert.deepEqual(noLayer.checks.filter((check) => !check.ok).map((check) => check.name), ["keyframe[1].lower-third"]);

  // `source` errado (instante diferente do corte): o PSNR cai e o item de corte reprova.
  const wrongCut = await runAcceptance({ ...base, final: fx.final, spec: [{ t: 1.5, source: 7, region: "0,0,320,100", minPsnr: 30 }] });
  assert.deepEqual(wrongCut.checks.filter((check) => !check.ok).map((check) => check.name), ["keyframe[0].match"]);

  // Promessa de 3 s para um MP4 de 2 s.
  const wrongLength = await runAcceptance({ ...base, final: fx.final, expectedSeconds: 3 });
  assert.deepEqual(wrongLength.checks.filter((check) => !check.ok).map((check) => check.name), ["duration.lint", "duration.frames"]);
});

test("FFmpeg real: corte deslocado de 1 frame só passa pelo frame vizinho da fonte (AV1 com perda do plano)", { timeout: 300_000 }, async (t) => {
  const fx = await fixtures();
  if (fx === undefined) return t.skip("FFmpeg/FFprobe indisponível");
  const report = await runAcceptance({ final: fx.shiftedFinal, entry: fx.entry, source: fx.source, spec: [FIXTURE_SPEC[0]], expectedSeconds: 2 });
  const cut = byName(report.checks, "keyframe[0].match");
  assert.equal(cut.ok, true, JSON.stringify(cut));
  assert.equal(cut.medido["tried"], 3, "frame exato (reprova) + os dois vizinhos");
  assert.ok((cut.medido["psnr"] as number) >= 30);
});

test("FFmpeg real: runAcceptance falha alto sem legendas, com spec inválido e com MP4 ilegível", { timeout: 300_000 }, async (t) => {
  const fx = await fixtures();
  if (fx === undefined) return t.skip("FFmpeg/FFprobe indisponível");
  const base = { final: fx.final, entry: fx.entry, source: fx.source, spec: FIXTURE_SPEC, captionsHtml: fx.captionsHtml, expectedSeconds: 2 };

  const { captionsHtml: _omitted, ...withoutCaptions } = base;
  await assert.rejects(runAcceptance(withoutCaptions), (error: unknown) => error instanceof AcceptError && error.code === "E_ACCEPT_ARGS" && /--captions/.test(error.hint));
  await assert.rejects(runAcceptance({ ...base, spec: [{ t: 1, source: 4, region: "0,0,400,100" }] }), (error: unknown) => error instanceof AcceptError && error.code === "E_ACCEPT_SPEC");
  await assert.rejects(runAcceptance({ ...base, final: join(fx.dir, "nao-existe.mp4") }), (error: unknown) => error instanceof AcceptError && error.code === "E_ACCEPT_TOOL");
});
