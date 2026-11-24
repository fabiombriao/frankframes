---
name: frankframes-generate
description: Gerar um vídeo pronto no FrankFrames a partir de um pedido em texto (ex.: "abertura 16:9 de 6 s com este título"). Use quando o pedido for produzir o vídeo inteiro, não só ajustar um arquivo: escolhe blocos do catálogo, monta um HTML de várias cenas, corrige com o lint, renderiza em rascunho e confere os frames antes de entregar.
---

# FrankFrames — gerar vídeo a partir de um pedido

Este é o roteiro de produção: pedido em texto → HTML de cenas → MP4 conferido. As regras do contrato
(atributos, tempo, fontes) estão na skill `frankframes`; leia-a quando precisar do detalhe. Aqui só entra
o que muda de um pedido para outro.

## 1. Decida o formato

| Pedido | `data-width` × `data-height` | Blocos |
|---|---|---|
| horizontal, 16:9 (padrão) | 1920 × 1080 | slugs sem prefixo |
| vertical, 9:16 (reels, stories) | 1080 × 1920 | slugs `vertical-*` |
| quadrado, 1:1 | 1080 × 1080 | não há bloco pronto: monte do zero |

`data-fps="30"` salvo pedido em contrário. Anote também a **duração total** e o **tom** (sóbrio,
enérgico, editorial). Se o pedido não dá duração, escolha uma e diga qual foi na entrega.
Divida o tempo entre as cenas: uma ideia por cena, de 2 a 6 s cada.

## 2. Escolha os blocos (sem ler o catálogo inteiro)

```sh
frankframes blocks index --json
```

Cada item traz `slug`, `summary`, `durationSeconds`, `width`, `height` e `tags`. Filtre por `width`/`height`
do formato, depois por `tags` e `summary`. Fique com **um bloco por cena**. A duração do bloco é só
referência: a cena pode ser mais curta ou mais longa (passo 3).

Leia o HTML **sob demanda**, só dos blocos que escolheu:

```sh
frankframes blocks add chart-bars blocos/chart-bars   # copia index.html, meta.json e miniatura
```

No monorepo o mesmo arquivo está em `catalog/blocks/<slug>/index.html`. Não abra blocos que não vai usar.

## 3. Monte UM arquivo, uma cena por bloco

Cada cena é um **host de sub-composição**: um elemento com `data-composition-id` e `data-clip-id` iguais, com
`data-start` e `data-duration`. Dentro dele o tempo é **local** (começa em 0) e o conteúdo não vaza para
fora. As cenas se encadeiam pelo id: `data-start="cena-1"` começa quando `cena-1` termina.

```html
<div data-composition-id="video" data-root="true" data-width="1920" data-height="1080" data-fps="30" data-duration="10">
  <div class="cena-1" data-composition-id="cena-1" data-clip-id="cena-1" data-start="0" data-duration="4">
    <h1 class="titulo" data-clip-id="c1-titulo" data-start="0.1" data-duration="3.9" data-enter="subir">Relatório</h1>
  </div>
  <div class="cena-2" data-composition-id="cena-2" data-clip-id="cena-2" data-start="cena-1" data-duration="6">
    <p class="texto" data-clip-id="c2-texto" data-start="0.2" data-duration="5.8" data-enter="surgir">Resultados</p>
  </div>
</div>
```

Para trazer um bloco para dentro de uma cena:

1. **Raiz do bloco vira a cena.** O `.stage` (ou `.frame`) do bloco passa a ser `.cena-N`: mantenha o
   tamanho, fundo, cor e `font-family` dele, troque `position: relative` por `position: absolute; left: 0; top: 0`
   (as cenas se sobrepõem no mesmo quadro; só a cena ativa aparece), e ponha `data-composition-id`/`data-clip-id`
   `cena-N`, o `data-start` e a `data-duration` da cena. Descarte `html, body {…}` e `<title>` do bloco.
2. **CSS com prefixo.** `.titulo { … }` vira `.cena-N .titulo { … }`, para dois blocos nunca brigarem por
   `.titulo`. O mesmo vale para `* { … }`: use `.cena-N * { … }`.
3. **`@keyframes` únicos.** Renomeie com o prefixo da cena (`c1-subir`) e atualize todo `animation:` que o cita.
4. **Ids únicos em todo o arquivo.** Ids de clip valem na árvore inteira: `kicker` em duas cenas é
   `E_DUPLICATE_ID`. Prefixe com `cN-` e atualize toda referência `data-start="…"` que apontava para eles.
5. **Texto do pedido no lugar do texto do bloco.** Troque cada texto, número e rótulo. Se o bloco tem mais
   itens que o pedido (barras, tópicos), apague os extras e refaça a conta de largura/posição; se tem menos,
   duplique a linha. Nada de texto do bloco sobrando.
6. **Tempos ajustados à cena.** Clip que deve ficar até o fim da cena leva `data-duration = duração da cena − data-start`;
   senão ele some antes e a cena fica vazia. Nenhum clip passa do fim da cena.
7. **Duração da raiz** = soma das cenas (menos a sobreposição das transições). Declare-a em `data-duration`.

Fontes: só as do catálogo (lista na skill `frankframes`). Mantenha as que o bloco já usa.

## 4. Movimento

Prefira os atributos de motion do contrato (§7b): o tempo é relativo ao clip e o lint os valida. Formato:
`preset chave=valor` (toda chave é opcional). Chaves comuns: `dur`, `at`, `curve`, e por preset `distance`,
`amount`, `dir`, `repeat`. Se o bloco já traz `data-enter`/`data-keyframes`, **preserve-os**: eles
continuam valendo dentro da cena.

<!-- presets:begin (gerado por scripts/sync-skill.ts a partir de listPresets do contrato) -->
| atributo | presets |
|---|---|
| `data-enter` (entrada) | `surgir`, `subir`, `descer`, `chegar-esquerda`, `chegar-direita`, `crescer`, `assentar`, `focar`, `girar`, `abrir`, `erguer`, `saltar` |
| `data-exit` (saída) | `apagar`, `partir-cima`, `partir-baixo`, `partir-esquerda`, `partir-direita`, `recuar`, `desfocar`, `fechar` |
| `data-emphasis` (ênfase) | `pulsar`, `balancar`, `tremer`, `respirar`, `piscar`, `quicar` |
| `data-camera` (só `<img>`/`<video>`) | `aproximar`, `afastar`, `panoramica-esquerda`, `panoramica-direita`, `deriva` |
| `data-transition` (entre clips) | `dissolver`, `cortina`, `empurrar`, `zoom`, `iris` |
<!-- presets:end -->

- Entrada no texto principal e saída suave (`data-exit`) no fim da cena dão ritmo sem esforço.
- Entre cenas, `data-transition="<preset> dir=…"` no clip que **entra**, com `data-start="cena-1 - 0.5"`
  (a sobreposição é a duração da transição; o vídeo encurta isso).
- Texto cinético: `data-split="word stagger=0.08"` no elemento mais `data-enter`.
- Contagem e números que mudam (cor, largura, contador) ficam em CSS `@keyframes`, com nome único por cena.
  Detalhe e miniaturas em `docs/motion.md`.

## 5. Valide com o lint (no máximo 5 rodadas)

```sh
frankframes lint video.html --json
```

Repita até `"ok": true`. Cada rodada: leia `diagnostics`, corrija **todos** os erros, rode de novo.
Passou de 5 rodadas sem `ok: true`: pare, entregue o arquivo como está e diga qual erro sobrou.

| Código | O que houve | Correção |
|---|---|---|
| `E_NO_ROOT` | nenhuma raiz | `data-composition-id` + `data-root="true"` no elemento que envolve tudo |
| `E_DUPLICATE_ID` | `data-clip-id` repetido | prefixe com a cena (`c2-titulo`) |
| `E_REF_UNKNOWN` | `data-start` aponta para id que não existe | confira o id do clip anterior (cena-1…) |
| `E_REF_CYCLE` | A começa quando B termina e B quando A termina | uma das duas passa a ter `data-start` absoluto |
| `E_START_INVALID` | forma de `data-start` inválida | só `2.5`, `id` ou `id + 1` / `id - 0.5` |
| `E_DURATION_UNRESOLVED` | falta duração | `data-duration` na raiz e em todo clip/mídia |
| `E_FPS_INVALID` | fps inválido | inteiro (`30`) ou racional (`30000/1001`); nunca `29.97` |
| `E_SIZE_INVALID` | largura/altura inválidas | pixels inteiros > 0 |
| `E_MOTION_*`, `E_TRANSITION_*`, `E_CURVE_INVALID` | motion mal escrito ou sem alvo | a mensagem traz a dica; chaves e alvos em `docs/motion.md` |

Outros códigos: a mensagem do lint traz a dica; a lista completa está em `docs/reference/diagnostics.md`.

## 6. Renderize em rascunho

```sh
frankframes render video.html -o out/video-draft.mp4 --preset draft --json
```

O rascunho é rápido e basta para conferir. Render com erro de contrato não gera arquivo: volte ao passo 5.

## 7. Confira os frames

```sh
frankframes frames out/video-draft.mp4 --json
```

Sem `--at`, olha 10%, 50% e 90%. Para conferir cada cena, use um instante dentro de cada uma
(`--at 1,5,9`). Dois passos:

1. **Chapado.** Nenhum frame com `"uniform": true`, a não ser que a cena seja de fundo chapado de propósito.
   Frame chapado costuma ser clip que sumiu cedo, bloco que não entrou ou fonte/cor sem contraste.
2. **Olhe os PNGs** (campo `png` de cada frame) contra o pedido: texto legível e igual ao pedido, nada cortado
   nas bordas, números certos, sem sobra de texto do bloco original. Em 9:16, mantenha o texto longe de
   **topo (200 px) e base (300 px)**, onde a interface do app cobre, e das laterais (80 px).

Achou problema: corrija o HTML e volte ao passo 5. Não entregue sem ter aberto os PNGs.

## 8. Entregue

Responda com: caminho do HTML, caminho do MP4, duração (s), formato e a lista de blocos usados (um por
cena). O MP4 do passo 6 já é o entregável; só rode `--preset standard` (`-o out/video.mp4`) se o pedido
exigir qualidade final, e então repita o passo 7 no arquivo novo.

## O que evitar

O render é offline e determinístico; o lint **não** barra o que está abaixo, mas o resultado sai errado.

- Sem `<script>` e sem biblioteca de animação (GSAP e afins). Animação é CSS ou atributos de motion.
- Sem URL externa (`http://`, `https://`, CDN, fonte remota): todo recurso é local ou desenhado em CSS.
- Sem animação por interação (`:hover`, clique, scroll).
- Sem `data-media-start`: o nome certo é `data-offset`.
- Não invente tempo: toda duração vem do pedido ou de uma conta que você consegue explicar.

## Variações em série

Para a mesma peça com textos diferentes (um vídeo por cliente), marque os textos com `data-var="nome"` e
renderize com `frankframes render --batch lote.json`. O formato está em `docs/batch.md`.
