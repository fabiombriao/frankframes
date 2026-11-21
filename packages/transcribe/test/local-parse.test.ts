// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWhisperJson } from "../src/local.ts";
import { TranscribeError } from "../src/types.ts";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof TranscribeError && error.code === code;
}

test("parseWhisperJson converte offsets em segundos e devolve palavras", () => {
  const raw = JSON.stringify({
    transcription: [
      { offsets: { from: 0, to: 1500 }, text: " Olá " },
      { offsets: { from: 1500, to: 3200 }, text: "mundo" },
    ],
  });

  assert.deepEqual(parseWhisperJson(raw), {
    text: "Olá mundo",
    segments: [
      { start: 0, end: 1.5, text: "Olá" },
      { start: 1.5, end: 3.2, text: "mundo" },
    ],
    words: [
      { start: 0, end: 1.5, word: "Olá" },
      { start: 1.5, end: 3.2, word: "mundo" },
    ],
  });
});

test("parseWhisperJson normaliza espaços extras entre segmentos", () => {
  const raw = JSON.stringify({
    transcription: [
      { offsets: { from: 0, to: 1000 }, text: "   primeiro   " },
      { offsets: { from: 1000, to: 2000 }, text: "  segundo  " },
    ],
  });

  const parsed = parseWhisperJson(raw);
  assert.equal(parsed.text, "primeiro segundo");
  assert.deepEqual(parsed.segments.map((segment) => segment.text), ["primeiro", "segundo"]);
});

test("parseWhisperJson omite words quando algum item não tem offsets válidos", () => {
  const raw = JSON.stringify({
    transcription: [
      { offsets: { from: 0, to: 1000 }, text: "com offsets" },
      { text: "sem offsets" },
    ],
  });

  const parsed = parseWhisperJson(raw);
  assert.equal(parsed.words, undefined);
  assert.deepEqual(parsed.segments, [
    { start: 0, end: 1, text: "com offsets" },
    { start: 0, end: 0, text: "sem offsets" },
  ]);
  assert.equal(parsed.text, "com offsets sem offsets");
});

test("parseWhisperJson rejeita JSON inválido com E_WHISPER_OUTPUT", () => {
  assert.throws(
    () => parseWhisperJson("{ not json"),
    (error) => hasErrorCode(error, "E_WHISPER_OUTPUT"),
  );
});

test("parseWhisperJson rejeita JSON sem transcription com E_WHISPER_OUTPUT", () => {
  assert.throws(
    () => parseWhisperJson(JSON.stringify({ result: { text: "só texto" } })),
    (error) => hasErrorCode(error, "E_WHISPER_OUTPUT"),
  );
});
