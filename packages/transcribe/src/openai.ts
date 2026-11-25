// FrankFrames — proprietário. Ver LICENSE na raiz.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { TranscribeError } from "./types.ts";
import type { Segment, Transcriber, TranscriptionResult, Word } from "./types.ts";

export interface OpenAiCompatibleConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface RawSegment {
  start?: unknown;
  end?: unknown;
  text?: unknown;
}

interface RawWord {
  start?: unknown;
  end?: unknown;
  word?: unknown;
}

interface RawResponse {
  text?: unknown;
  segments?: unknown;
  words?: unknown;
}

function toSeconds(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toSegments(raw: unknown): Segment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const seg = (item ?? {}) as RawSegment;
    return { start: toSeconds(seg.start), end: toSeconds(seg.end), text: String(seg.text ?? "") };
  });
}

function toWords(raw: unknown): Word[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((item) => {
    const word = (item ?? {}) as RawWord;
    return { start: toSeconds(word.start), end: toSeconds(word.end), word: String(word.word ?? "") };
  });
}

/**
 * Provedor compatível com `POST /audio/transcriptions` da OpenAI (Groq incluído).
 * Não baixa modelo: toda a transcrição acontece no servidor remoto.
 */
export function createOpenAiCompatible(config: OpenAiCompatibleConfig): Transcriber {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;

  return {
    name: config.name,
    async transcribe(file, options): Promise<TranscriptionResult> {
      const bytes = await readFile(file);
      const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]);
      const form = new FormData();
      form.append("file", blob, basename(file));
      form.append("model", config.model);
      form.append("response_format", "verbose_json");
      // Sem pedir `word` o provedor não devolve tempo por palavra e a legenda nunca sai em karaokê.
      // `segment` vai junto: pedir granularidade substitui o padrão, e `segments` é obrigatório.
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
      if (options?.language) form.append("language", options.language);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new TranscribeError(
          "E_OPENAI_HTTP",
          `Transcrição falhou (HTTP ${response.status}): ${body.slice(0, 300)}`,
          { status: response.status },
        );
      }

      let raw: RawResponse;
      try {
        raw = (await response.json()) as RawResponse;
      } catch (error) {
        throw new TranscribeError("E_OPENAI_RESPONSE", "Resposta de transcrição não é JSON válido.", { cause: error });
      }

      const text = typeof raw.text === "string" ? raw.text : "";
      const segments = toSegments(raw.segments);
      const words = toWords(raw.words);

      const result: TranscriptionResult = {
        text: text || segments.map((segment) => segment.text).join(" ").trim(),
        segments,
        provider: config.name,
      };
      // `words` é opcional: só existe quando o provedor devolve timestamps por palavra.
      if (words !== undefined) result.words = words;
      return result;
    },
  };
}
