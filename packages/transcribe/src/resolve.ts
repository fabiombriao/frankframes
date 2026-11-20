// FrankFrames — proprietário. Ver LICENSE na raiz.
import { stat } from "node:fs/promises";
import { createLocal } from "./local.ts";
import { createOpenAiCompatible } from "./openai.ts";
import { TranscribeError } from "./types.ts";
import type { ProviderConfig, Transcriber } from "./types.ts";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_MODEL = "whisper-large-v3-turbo";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MODEL = "whisper-1";
const DEFAULT_WHISPER_BIN = "vendor/whisper/whisper-cli.exe";
const DEFAULT_WHISPER_MODEL = "vendor/models/ggml-large-v3-turbo.bin";

const UNAVAILABLE_MESSAGE = [
  "Nenhum provedor de transcrição disponível. Escolha uma das três opções:",
  "  1. Groq: defina GROQ_API_KEY (modelo whisper-large-v3-turbo, sem download).",
  "  2. OpenAI-compatible: defina OPENAI_API_KEY e, se necessário, OPENAI_BASE_URL (modelo whisper-1).",
  "  3. Local: instale whisper.cpp em FRANKFRAMES_WHISPER_BIN e baixe o modelo com",
  '     "frankframes models install whisper-large-v3-turbo" (~550 MB q5 / ~1.5 GB f16).',
  "Sem modelo e sem chave, a transcrição falha — nada é baixado em silêncio.",
].join("\n");

function withLanguage(transcriber: Transcriber, language: string | undefined): Transcriber {
  if (!language) return transcriber;
  return {
    name: transcriber.name,
    transcribe: (file, options) => transcriber.transcribe(file, { language: options?.language ?? language }),
  };
}

function explicit(config: ProviderConfig): Transcriber | undefined {
  if (config.provider === "groq") {
    const apiKey = config.apiKey ?? process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new TranscribeError("E_TRANSCRIBE_UNAVAILABLE", "Provedor groq selecionado, mas GROQ_API_KEY não está definida.");
    }
    return createOpenAiCompatible({
      name: "groq",
      baseUrl: config.baseUrl ?? GROQ_BASE_URL,
      apiKey,
      model: config.model ?? GROQ_MODEL,
    });
  }

  if (config.provider === "openai-compatible" || (!config.provider && config.baseUrl && config.apiKey)) {
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!config.baseUrl || !apiKey) {
      throw new TranscribeError(
        "E_TRANSCRIBE_UNAVAILABLE",
        "Provedor openai-compatible exige baseUrl e apiKey (ou OPENAI_API_KEY).",
      );
    }
    return createOpenAiCompatible({
      name: "openai",
      baseUrl: config.baseUrl,
      apiKey,
      model: config.model ?? OPENAI_MODEL,
    });
  }

  return undefined;
}

/**
 * Ordem: configuração explícita → GROQ_API_KEY → OPENAI_API_KEY → modelo local.
 * Só faz `stat` dos arquivos locais; nunca baixa nem chama installLocalModel.
 */
export async function resolveProvider(config: ProviderConfig = {}): Promise<Transcriber> {
  if (config.provider === "local") {
    const whisperBin = process.env.FRANKFRAMES_WHISPER_BIN ?? DEFAULT_WHISPER_BIN;
    const modelPath = process.env.FRANKFRAMES_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL;
    return withLanguage(createLocal({ whisperBin, modelPath }), config.language);
  }

  const fromConfig = explicit(config);
  if (fromConfig) return withLanguage(fromConfig, config.language);

  if (process.env.GROQ_API_KEY) {
    return withLanguage(
      createOpenAiCompatible({
        name: "groq",
        baseUrl: GROQ_BASE_URL,
        apiKey: process.env.GROQ_API_KEY,
        model: GROQ_MODEL,
      }),
      config.language,
    );
  }

  if (process.env.OPENAI_API_KEY) {
    return withLanguage(
      createOpenAiCompatible({
        name: "openai",
        baseUrl: process.env.OPENAI_BASE_URL ?? OPENAI_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY,
        model: OPENAI_MODEL,
      }),
      config.language,
    );
  }

  const whisperBin = process.env.FRANKFRAMES_WHISPER_BIN ?? DEFAULT_WHISPER_BIN;
  const modelPath = process.env.FRANKFRAMES_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL;
  const available = await Promise.all([
    stat(whisperBin).then(() => true, () => false),
    stat(modelPath).then(() => true, () => false),
  ]);
  if (available[0] && available[1]) {
    return withLanguage(createLocal({ whisperBin, modelPath }), config.language);
  }

  throw new TranscribeError("E_TRANSCRIBE_UNAVAILABLE", UNAVAILABLE_MESSAGE);
}
