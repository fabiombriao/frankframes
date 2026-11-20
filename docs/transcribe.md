# Transcrição (política de custo)

Transcrição **nunca** é pré-requisito do render. Quem não usa legenda não paga o disco nem o download.

## Regra dura: opt-in explícito

| Ação | Permitido sem confirmação? |
|---|---|
| Baixar o modelo local (~550 MB q5, ~1,5 GB f16) | **Não.** Só por comando explícito do usuário (`frankframes models install whisper-large-v3-turbo`) ou botão "Baixar modelo" na UI |
| Instalar `whisper.cpp` | **Não.** Mesmo comando, mesma confirmação, com o tamanho declarado antes de começar |
| Requerer transcrição para renderizar | **Nunca.** `render` não importa `transcribe` |
| Verificar se o modelo existe | Sim (custa um `stat`, não uma rede) |
| Usar provedor remoto | Só com chave configurada pelo usuário |

Sem modelo e sem provedor, o comando de transcrição falha com instrução — nunca baixa em silêncio.

## Ordem de detecção

1. Configuração explícita (`transcribe.provider`).
2. `GROQ_API_KEY` → Groq (`whisper-large-v3-turbo`).
3. `OPENAI_API_KEY` / base URL compatível.
4. Modelo local presente → `whisper.cpp` como processo.
5. Nada disso → erro `E_TRANSCRIBE_UNAVAILABLE` com as três opções e o tamanho de cada uma.

## Interface

```ts
interface Transcriber {
  transcribe(file: string, options: { language?: string }): Promise<{
    text: string;
    segments: Array<{ start: number; end: number; text: string }>;
    words?: Array<{ start: number; end: number; word: string }>;
  }>;
}
```

`segments` é obrigatório; `words` degrada (legenda por frase quando o provedor não retorna palavra).

## Licenças

| Peça | Licença | Observação |
|---|---|---|
| `whisper.cpp` | MIT | roda como processo, como o FFmpeg |
| Modelo Whisper `large-v3-turbo` | MIT (OpenAI) | verificar hash na instalação |
| Groq / OpenAI-compatible | serviço de terceiro | nada nosso é distribuído; a chave é do usuário |
| NVIDIA Parakeet | CC-BY-4.0 | fora por ora: exige atribuição e é en-US |

## Espaço em disco

O instalador **não** contém modelo nem binário de transcrição. `uninstall` do modelo é um comando
(`frankframes models remove whisper-large-v3-turbo`) e devolve o espaço.
