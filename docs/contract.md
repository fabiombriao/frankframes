# Contrato FrankFrames

> Este documento é a **fonte de verdade**. O código é a implementação dele; `_lab/` e o dossiê de
> engenharia reversa não são consultados durante o desenvolvimento (ver `PROVENANCE.md`).

## 1. Princípio

Um vídeo é um arquivo HTML. O autor declara tempo com atributos `data-*`; o motor nunca "toca" o
vídeo — ele pergunta "como é o frame 90?", fotografa a tela e passa para o frame seguinte.

Consequências que o contrato assume:

- **Seek, não play.** O mesmo frame tem a mesma resposta em qualquer ordem e em qualquer worker.
- **Falhar alto.** Contrato inválido bloqueia o render. Nenhum caminho "renderiza com sucesso um
  vídeo errado".
- **Nada é estimado.** Duração desconhecida é `unresolved` com a lista exata do que falta.

## 2. Raiz

| Atributo | Regra |
|---|---|
| `data-composition-id` | obrigatório na raiz; identifica a composição |
| `data-root="true"` | desempata quando existe mais de um `data-composition-id`; senão vale o primeiro em ordem de documento |
| `data-width`, `data-height` | pixels inteiros > 0. Ausente = dimensão do viewport do render |
| `data-fps` | inteiro (`30`) ou racional exato (`30000/1001`). `29.97` é **inválido** — é ambíguo para o encoder |
| `data-duration` | segundos > 0. Tem precedência sobre qualquer derivação |
| `data-start` na raiz | ignorado; a raiz começa em 0 (aviso `W_ROOT_START_IGNORED`) |

## 3. Tempo

`data-start` aceita exatamente quatro formas:

| Forma | Significado |
|---|---|
| ausente / vazio | `0` |
| `2.5` | absoluto, em segundos |
| `intro` | quando o clip `intro` **termina** |
| `intro + 1`, `intro-0.5` | fim do alvo, deslocado |

Referência sempre aponta para o **fim** do alvo, nunca para o início. Um identificador que não existe
é `E_REF_UNKNOWN`; uma forma que não é número nem identificador é `E_START_INVALID`. Não há fallback.

`data-duration` é segundos ≥ 0. `data-end` não existe no vocabulário: o fim é sempre derivado.

## 4. O que é um clip

Uma linha de timeline, nesta ordem de decisão:

1. **host de sub-composição** — tem `data-composition-src` ou `data-composition-id` (fora a raiz);
2. **elemento temporizado** — tem `data-start`, ou tem `data-track` e `data-duration`, ou é `<video>`, `<audio>`, `<img>`.

Wrapper sem tempo é atravessado: `div > section > clip` produz um clip, não três. Um container que só
tem `data-track` (sem duração) **não** é clip.

| Atributo | Regra |
|---|---|
| `data-clip-id` | identidade estável, alvo de `data-start`; padrão `<tag>#<n>` |
| `data-offset` | instante dentro da fonte, segundos ≥ 0. **Nome único** para esse conceito |
| `data-playback-rate` | `[0.1, 10]`; fora da faixa é aviso + clamp |
| `data-volume` | ganho linear; `1` = 0 dB |
| `data-track` | **só UI**. O render ignora. Não use para lógica |
| `class="clip"` | convenção de autoria. **Nunca** governa visibilidade — o runtime usa o atributo `data-start` |

## 5. Sub-composições

- Inline: `<template>` dentro do host, contendo um elemento com `data-composition-id`. Os clips
  internos são resolvidos no próprio escopo e **não** vazam para a raiz.
- Externa: `data-composition-src="card.html"`.
- Profundidade máxima 20; ids de clip são **únicos em toda a árvore** (referências atravessam escopos).
- Duração do host: `data-duration` do host; senão `data-duration` da raiz interna; senão indefinida.

## 6. Mídia

O contrato puro não abre arquivos. Duração de `<video>`/`<audio>` vem de:

1. `data-duration` no elemento; ou
2. `mediaDurations` medido por probe (`loadComposition(html, { mediaDurations })`).

Sem nenhum dos dois, o clip fica **pendente** e a composição é `unresolved` (`pending-clips`).
O render nunca começa com duração pendente.

## 7. Duração da composição

1. `data-duration` da raiz > 0 → `authored`.
2. senão, se algum clip não tem início resolvível → `unresolved` (`invalid-start`).
3. senão, se algum clip não tem duração → `unresolved` (`pending-clips`) com a lista.
4. senão → `derived` = maior `start + duration`, com piso de `1/60` s.

## 8. Diagnósticos

Todo diagnóstico tem `code` estável, `severity` e `message`; os erros têm `hint` acionável.
`severity: "error"` bloqueia; `"warning"` só informa. A lista canônica está em
`packages/contract/src/errors.ts`.

## 9. Determinismo esperado do runtime

O contrato promete isto ao autor, e o engine tem que cumprir:

1. **Clock virtual injetado antes de qualquer script da composição.** `Date`, `performance.now`,
   `requestAnimationFrame`, `setTimeout/setInterval`, `Math.random` e `crypto.getRandomValues` são do host,
   não do sistema.
2. **Exatamente uma geração de `requestAnimationFrame` por frame.** Liberar duas gerações consome o
   PRNG duas vezes: o resultado é determinístico e errado.
3. **`Math.random` re-semeado por frame** a partir do tempo do frame.
4. **Vídeo fora de banda**: frames extraídos por FFmpeg e `<video>` substituído por `<img>`; o Chrome não
   decodifica vídeo durante a captura.
5. **Prontidão explícita** antes do frame 0: fontes, imagens (`decode()`), metadados de mídia, N ticks de warmup.
6. **Captura atômica**: layout+paint+composite num round-trip.
7. **Prova**: SHA-256 por frame amostrado, versionado no repositório. Divergência falha o CI.

Verificado em `2026-11-20`: 30 frames 720p, duas execuções e ordem invertida → 30/30 hashes idênticos,
~97 ms/frame (caminho ingênuo de screenshot).

## 10. Compatibilidade

Composições escritas para outro framework entram por um **importador separado** (`compat-*`), que traduz
nomes no parsing. O núcleo não ganha um segundo nome para o mesmo conceito, nem modo "congela em t=0".
