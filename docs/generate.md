# `frankframes generate` — vídeo a partir de texto

Pedido em texto → composição HTML conferida → rascunho em MP4. Quem escreve a composição é o **Codex CLI**,
logado na **conta ChatGPT** do titular; o FrankFrames confere tudo do lado dele (lint, formato, duração, render,
frames) e pede correção ao Codex quando algo reprova. Nada aqui muda o contrato (`docs/contract.md`): o resultado é
um `index.html` comum, que você edita, previsualiza e renderiza como qualquer outro.

## Uso

```bash
frankframes generate "<pedido>" [-o <pasta>] [--format 16:9|9:16|1:1] [--duration S] [--attempts N]
                                [--model M] [--timeout S] [--project <pasta>] [--no-render] [--no-studio]
                                [--force] [--keep-context] [--json]
```

| Opção | Padrão | O que faz |
|---|---|---|
| `-o <pasta>` | `out/gerado-<slug do pedido>` | pasta de saída |
| `--format` | `16:9` | `16:9` (1920×1080), `9:16` (1080×1920) ou `1:1` (1080×1080); sempre 30 fps |
| `--duration S` | o agente escolhe (4 a 15 s) | duração pedida; o resultado precisa ficar a até 0,5 s dela |
| `--attempts N` | 3 (1 a 6) | tentativas no total (a 1ª + correções) |
| `--model M` | o do Codex | repassa `-m M` ao Codex |
| `--timeout S` | 600 | tempo máximo de **cada** chamada ao Codex |
| `--project <pasta>` | nenhum | deixa o agente ver os **nomes e durações** das mídias da pasta (nunca os bytes) |
| `--no-render` | desligado | não gera `draft.mp4` (só confere o HTML) |
| `--no-studio` | desligado | não abre o Studio no fim |
| `--force` | desligado | sobrescreve um `index.html` existente na pasta de saída |
| `--keep-context` | desligado | guarda a pasta de contexto que o Codex viu (para auditoria) |
| `--json` | desligado | relatório em JSON no stdout (progresso e erros continuam no stderr) |

Com `--project`, os caminhos de mídia no HTML são relativos ao **arquivo** gerado. Para que eles resolvam, use
`-o <pasta do projeto>` (ou copie a mídia para a pasta de saída).

Exemplo:

```bash
frankframes generate "teaser vertical de 8 s do lançamento, fundo escuro, título grande" --format 9:16 --duration 8
```

Códigos de saída: `0` ok, `1` erro de geração (vem com código `E_*` e dica), `2` uso incorreto.

## O que sai da máquina

- **Vai para a OpenAI, pela sua conta ChatGPT**: o texto do pedido, o material de texto descrito abaixo (skill, contrato,
  presets, índice do catálogo), o HTML das tentativas anteriores e os diagnósticos, quando há correção.
- **Não vai**: vídeo, áudio, imagem, miniatura, o seu projeto inteiro. Com `--project` só entram caminho, tipo e duração
  de cada mídia. O Codex nunca recebe `-i/--image`.
- O FrankFrames **não usa chave de API**. As variáveis `OPENAI_API_KEY`, `CODEX_API_KEY`, `GROQ_API_KEY` e
  `FRANKFRAMES_*` são tiradas do ambiente do Codex, e também qualquer variável cujo nome (em maiúsculas) termine em
  `_KEY`, `_TOKEN`, `_SECRET` ou `_PASSWORD`, ou contenha `SECRET`, `PASSWORD` ou `CREDENTIAL` (por exemplo
  `JIRA_API_TOKEN`, `AWS_SECRET_ACCESS_KEY`). `PATH`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`,
  `TEMP`/`TMP` e `CODEX_HOME` passam sempre.

## O que o Codex recebe

O Codex roda em `exec --ephemeral -s read-only --ignore-user-config`, com a pasta de trabalho numa pasta temporária
`ff-generate-*` que só tem texto. **Tudo que ele precisa vai dentro do prompt** (pelo stdin), porque o Codex 0.170 no
Windows, em `read-only`, bloqueia os comandos de shell que leriam arquivos (`Get-Content`, `type`): ele não consegue
abrir nada da pasta. O prompt leva:

```
pedido                   entre os delimitadores <<<PEDIDO … PEDIDO>>>
regras duras             sem <script>, URL, CDN, GSAP nem data-media-start; raiz e formato obrigatórios
SKILL.md                 roteiro da skill frankframes-generate
contract.md              só as seções 1–8 e 9b do docs/contract.md (as seções do Studio ficam de fora)
motion/presets.json      presets de motion (compacto)
catalog/index.json       índice dos blocos (slug, resumo, tags; compacto)
project.json             só com --project: caminho, tipo e duração das mídias
HTML anterior + diagnósticos   só nas tentativas de correção
```

A pasta de contexto tem os mesmos arquivos (mais `catalog/blocks/<slug>/index.html` e `output-schema.json`), para
auditoria e para versões do Codex que leiam arquivos; o HTML dos blocos **não** vai no prompt (peso demais), então hoje o
agente monta as cenas do zero seguindo o contrato. `--ignore-user-config` fica ligado: com ele o Codex usa a conta
ChatGPT e não herda os hooks, o gateway local nem o `sandbox_mode` do seu `~/.codex/config.toml`.

`read-only` impede escrita, mas **não** impede o Codex de ler o disco: o que o FrankFrames garante é que nada além
desse material é mostrado a ele. A pasta é apagada no fim (use `--keep-context` para guardá-la).

## Conta ChatGPT obrigatória

Antes de qualquer escrita o comando roda `codex login status`. Só passa se a resposta for
`Logged in using ChatGPT`; deslogado ou logado com chave de API é `E_CODEX_AUTH`. O Codex é achado assim:

1. `FRANKFRAMES_CODEX` apontando para um executável (`.js/.mjs/.cjs/.ts` rodam no Node). Se estiver definido e o
   arquivo não existir, é `E_CODEX_MISSING`, sem procurar no PATH.
2. No PATH: `codex.exe`, depois `codex.cmd` (no Windows, roda `node_modules\@openai\codex\bin\codex.js` ao lado dele,
   com o `node.exe` do mesmo diretório se houver). `codex.ps1` e o `codex` sem extensão do npm são ignorados. Nunca
   há `shell: true`.

## Como a geração decide

Cada tentativa é uma chamada nova ao Codex (`--ephemeral`, sem `resume`):

1. o Codex devolve JSON `{html, blocks, notes}`; qualquer desvio é `E_CODEX_OUTPUT` e conta como tentativa;
2. `lint`, mais as checagens do gerador: `<script`, URL `http(s)://` (só o `xmlns` do SVG é aceito), `//cdn`,
   `gsap` e `data-media-start` são `E_GEN_FORBIDDEN`; raiz de outro tamanho é `E_GEN_FORMAT_MISMATCH`; duração
   fora de ±0,5 s do pedido é `E_GEN_DURATION_MISMATCH`;
3. render em rascunho (`draft.mp4`); se o render falhar, o erro vai como diagnóstico para a correção;
4. três frames (10%, 50%, 90%) conferidos; um frame chapado (`W_GEN_FRAME_BLANK`) vale **uma** correção e, se
   persistir, o vídeo é entregue com o aviso.

Reprovou: o HTML anterior e os diagnósticos vão no prompt e o Codex corrige. Sem HTML aproveitável (resposta
ilegível) só os diagnósticos vão. Esgotadas as tentativas: `E_GEN_EXHAUSTED`, **sem** `index.html`; a última tentativa
fica em `.generate/attempt-N.html`.

## Arquivos de saída

```
<out>/index.html          a composição entregue
<out>/draft.mp4           rascunho (ausente com --no-render)
<out>/generate.json       relatório: agente, versão, tentativas (tempo, diagnósticos), frames, avisos
<out>/.generate/attempt-N.html   o HTML de cada tentativa
<out>/.generate/attempt-N.log    saída do Codex (stdout+stderr)
<out>/.generate/attempt-N.last.json   a última mensagem crua do Codex
<out>/.generate/frames-N/        PNGs dos frames conferidos
```

`generate.json` também é gravado quando a geração falha (`ok: false`, com o código e a dica).

Sem `--no-studio` (e com render), o comando sobe o Studio no `index.html`, imprime a URL, abre o navegador e fica até
Ctrl+C. Ctrl+C durante a geração encerra o Codex e toda a árvore de processos dele.

## Códigos de erro

| Código | Quando | Dica |
|---|---|---|
| `E_CODEX_MISSING` | Codex não encontrado, `FRANKFRAMES_CODEX` inválido, `codex.cmd` sem `codex.js` | instale (`npm i -g @openai/codex`) e rode `codex login`, ou aponte `FRANKFRAMES_CODEX`; para `codex.cmd` sem `codex.js`: reinstale |
| `E_CODEX_AUTH` | deslogado ou logado com chave de API | `codex login` e entre com a conta ChatGPT; o FrankFrames não usa chave de API |
| `E_CODEX_FAILED` | o Codex saiu com erro (ou foi interrompido); **não** é repetido | veja `.generate/attempt-N.log` |
| `E_CODEX_TIMEOUT` | uma chamada passou de `--timeout`; **não** é repetido | aumente `--timeout` |
| `E_CODEX_OUTPUT` | resposta que não segue o schema; **é** repetida como correção | — |
| `E_GEN_REQUEST_INVALID` | pedido vazio, com mais de 4000 caracteres ou com o delimitador reservado | reescreva o pedido |
| `E_GEN_OUT_EXISTS` | já existe `index.html` na pasta de saída | `--force` ou outra pasta |
| `E_GEN_EXHAUSTED` | as tentativas acabaram sem um vídeo válido | veja o último `attempt-N.html` e `generate.json`; `--attempts` maior |
| `E_GEN_FORBIDDEN`, `E_GEN_FORMAT_MISMATCH`, `E_GEN_DURATION_MISMATCH`, `W_GEN_FRAME_BLANK` | diagnósticos de correção (aparecem em `generate.json`) | — |
| `W_GEN_CLEANUP` | com o vídeo entregue, a pasta de contexto (`ff-generate-*`) não pôde ser removida; o aviso traz o caminho e o motivo, em `warnings` e em `generate.json` (em falha, o aviso vai para o stderr e o erro original é mantido) | apague a pasta indicada |

## Observação sobre a leitura do login

O Codex 0.170 escreve a resposta de `codex login status` no **stderr**, não no stdout; o FrankFrames lê os dois.
