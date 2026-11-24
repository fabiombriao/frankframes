// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaRotationError, jpegSize, parseDisplayMatrix, parseVideoProbe } from "../src/media.ts";

/** Matriz como o ffprobe imprime (campo `displaymatrix`): 3 linhas `índice: a b c`, ponto fixo 16.16. */
const fixed = (value: number): string => String(Math.round(value * 65536)).padStart(12);
const matrix = (a: number, b: number, c: number, d: number): string =>
  `\n00000000: ${fixed(a)} ${fixed(b)} ${"0".padStart(12)}\n` +
  `00000001: ${fixed(c)} ${fixed(d)} ${"0".padStart(12)}\n` +
  `00000002: ${"0".padStart(12)} ${"0".padStart(12)} ${"1073741824".padStart(12)}\n`;

/** Saída real do ffprobe para um celular em retrato: H.264 1920x1080 com rotation=-90. */
const PORTRAIT_PHONE = JSON.stringify({
  streams: [
    {
      width: 1920,
      height: 1080,
      side_data_list: [{ side_data_type: "Display Matrix", displaymatrix: matrix(0, 1, -1, 0), rotation: -90 }],
    },
  ],
  format: { duration: "68.164583" },
});

test("celular em retrato: gravado 1920x1080, exibe 1080x1920 com rotação -90", () => {
  const probe = parseVideoProbe(PORTRAIT_PHONE, "A.MOV");
  assert.equal(probe.width, 1920);
  assert.equal(probe.height, 1080);
  assert.equal(probe.rotation, -90);
  assert.equal(probe.mirrored, false);
  assert.equal(probe.displayWidth, 1080);
  assert.equal(probe.displayHeight, 1920);
  assert.equal(probe.duration, 68.164583);
});

test("sem Display Matrix: sem rotação, exibição igual à gravada", () => {
  const probe = parseVideoProbe(JSON.stringify({ streams: [{ width: 320, height: 180 }], format: { duration: "2.0" } }), "a.mp4");
  assert.deepEqual(
    { rotation: probe.rotation, mirrored: probe.mirrored, w: probe.displayWidth, h: probe.displayHeight },
    { rotation: 0, mirrored: false, w: 320, h: 180 },
  );
});

test("matriz: 90, 180, 270 e espelhamentos seguem a conta do FFmpeg", () => {
  const cases: Array<[string, string, { rotation: number; mirrored: boolean }]> = [
    ["identidade", matrix(1, 0, 0, 1), { rotation: 0, mirrored: false }],
    ["90 anti-horário", matrix(0, -1, 1, 0), { rotation: 90, mirrored: false }],
    ["-90 (270)", matrix(0, 1, -1, 0), { rotation: -90, mirrored: false }],
    ["180", matrix(-1, 0, 0, -1), { rotation: -180, mirrored: false }],
    ["espelho horizontal", matrix(-1, 0, 0, 1), { rotation: -180, mirrored: true }],
    ["espelho vertical", matrix(1, 0, 0, -1), { rotation: 0, mirrored: true }],
    ["90 com espelho", matrix(0, -1, -1, 0), { rotation: 90, mirrored: true }],
  ];
  for (const [name, text, expected] of cases) assert.deepEqual(parseDisplayMatrix(text, "a.mp4"), expected, name);
});

test("rotação que não é múltipla de 90 falha com E_MEDIA_ROTATION e hint", () => {
  const s = Math.SQRT1_2;
  assert.throws(
    () => parseDisplayMatrix(matrix(s, -s, s, s), "giro.mp4"),
    (error: unknown) =>
      error instanceof MediaRotationError &&
      error.code === "E_MEDIA_ROTATION" &&
      error.hint.length > 0 &&
      error.message.includes("45") &&
      error.message.includes("giro.mp4") &&
      error.message.includes(error.hint),
  );
  // O JSON inteiro do probe propaga o mesmo erro (o render e o Studio dependem disso).
  const json = JSON.stringify({
    streams: [{ width: 160, height: 96, side_data_list: [{ side_data_type: "Display Matrix", displaymatrix: matrix(s, -s, s, s) }] }],
    format: { duration: "1.0" },
  });
  assert.throws(() => parseVideoProbe(json, "giro.mp4"), MediaRotationError);
});

test("matriz com cisalhamento falha com E_MEDIA_ROTATION", () => {
  assert.throws(
    () => parseDisplayMatrix(matrix(1, 0, 0.5, 1), "torto.mp4"),
    (error: unknown) => error instanceof MediaRotationError && error.code === "E_MEDIA_ROTATION" && error.message.includes("cisalhamento"),
  );
});

test("saída ilegível do ffprobe falha alto, sem virar rotação zero", () => {
  assert.throws(() => parseVideoProbe("não é json", "a.mp4"), /não é JSON/);
  assert.throws(() => parseVideoProbe(JSON.stringify({ streams: [], format: { duration: "1" } }), "a.mp4"), /sem trilha de vídeo/);
  assert.throws(() => parseVideoProbe(JSON.stringify({ streams: [{ width: 10, height: 10 }], format: { duration: "N/A" } }), "a.mp4"), /duração inválida/);
  assert.throws(() => parseVideoProbe(JSON.stringify({ streams: [{ width: 0, height: 10 }], format: { duration: "1" } }), "a.mp4"), /dimensões inválidas/);
  assert.throws(() => parseDisplayMatrix("lixo", "a.mp4"), /ilegível/);
});

test("jpegSize lê o tamanho do marcador SOF e recusa o que não é JPEG", () => {
  // SOI, APP0 (vazio, 2 bytes de tamanho), SOF0 com altura 160 e largura 96.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0xa0, 0x00, 0x60, 0x01, 0x01, 0x11, 0x00]);
  assert.deepEqual(jpegSize(jpeg), { width: 96, height: 160 });
  assert.throws(() => jpegSize(Buffer.from("PNG")), /não é um JPEG/);
  assert.throws(() => jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02])), /sem marcador de tamanho/);
});
