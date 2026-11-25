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
O provedor remoto pede `timestamp_granularities[]=word,segment` (um campo do formulário para cada valor), e a
linha de saída do `captions` informa se a legenda saiu em karaokê, com o total de palavras, ou por frase.

## Legendas curtas e destaque (karaokê)

Segmento **com** palavras com tempo é dividido em legendas curtas, um clip por legenda (`cap-0`, `cap-1`… em
sequência na composição inteira). Uma legenda nova abre antes de uma palavra quando:

- a legenda atual já tem `maxWords` palavras (padrão 4; `frankframes captions --max-words N`, inteiro ≥ 1,
  outro valor falha com `E_CAPTIONS`);
- a palavra anterior termina em `.` `,` `?` `!` `;` ou `:`;
- a pausa entre o fim da palavra anterior e o início desta passa de 0,35 s.

Os tempos são encadeados, em milissegundos: a primeira legenda do segmento começa em `segment.start`, cada uma
das outras no início da sua primeira palavra, cada uma dura até o início da seguinte (a pausa entre elas fica na
legenda anterior) e a última vai até `segment.end`. Palavra que começa no mesmo milissegundo da legenda atual
fica nela, mesmo que ela passe de `maxWords`; palavra que começa fora do intervalo do segmento não ganha legenda
própria (a duração mínima, abaixo, a junta). As regras são aplicadas na ordem das palavras, sem equilibrar: pode
sobrar uma legenda de uma palavra só.

**Duração mínima.** Depois das quebras, cada legenda mais curta que a mínima é juntada à seguinte do mesmo
segmento (a última, à anterior), até nenhuma ficar abaixo. A mínima é 0,4 s; com `--motion`, é o maior valor entre
0,4 s e o que a mola do preset precisa para assentar (`saltar`, ou qualquer preset com `curve=mola`: 0,59 s; na
biblioteca, mola na entrada e na saída soma as duas). **A duração vence o `maxWords`**: uma legenda juntada pode
passar de N palavras, e pode atravessar uma quebra por pontuação ou pausa. Um segmento inteiro mais curto que a
mínima fica como uma legenda só, sem erro da divisão (com mola, o contrato recusa como antes). Legendas de
segmentos diferentes nunca são juntadas.

O ajuste de fonte e de linhas vale para o texto de cada legenda.

Destaque: só a palavra que está sendo falada fica na cor de destaque (`highlight`, padrão `#ffd400`); antes e
depois dela é branca. Cada palavra acende no seu início e apaga no início da palavra seguinte da mesma legenda; a
última apaga com a legenda.

Segmento **sem** palavras continua como veio do provedor: uma legenda por frase, sem destaque, e `maxWords` não
se aplica.

## Estado do modo local

O binário do `whisper.cpp` **não é embarcado**: o projeto não publica binário pré-compilado no release
(`whisper-bin-x64.zip` responde 404) e compilar exige MSVC/CMake na máquina do usuário. Duas saídas,
quando isso virar prioridade:

1. compilar `whisper.cpp` no nosso pipeline de release e publicar com SHA-256 (mesmo modelo do FFmpeg);
2. trocar o runtime local por `sherpa-onnx`, que publica binários prontos (Apache-2.0) e aceita os mesmos
   modelos em ONNX.

Até lá, o modo local funciona com `FRANKFRAMES_WHISPER_BIN` apontando para um binário do usuário, e o
modo remoto (Groq / OpenAI-compatible) está completo.

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
