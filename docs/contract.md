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
| `data-volume` | ganho linear; `1` = 0 dB, `0` = silêncio. Negativo é erro; acima de `4` avisa (+12 dB) |
| `data-audio-role` | `voice`, `music` ou `sfx`. Música (`music`) abaixa 9 dB sob qualquer `voice`, com 80 ms de ataque e 250 ms de release |
| `data-fade-in` / `data-fade-out` | segundos ≥ 0; entram no mixer. Fade maior que a duração é ajustado com aviso |
| `data-track` | **só UI**. O render ignora. Não use para lógica |
| `class="clip"` | convenção de autoria. **Nunca** governa visibilidade — o runtime usa o atributo `data-start` |

## 5. Sub-composições

- Inline: `<template>` dentro do host **ou** filhos diretos do host. Um host de sub-composição é uma
  fronteira de escopo: o conteúdo interno é outra composição, com tempo local, e **não** vaza para a raiz.
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
6. **Uma captura por frame, depois do paint.** A primeira captura de cada sessão é descartada; depois
   de cada seek, `__ff.settle` espera dois frames de compositor e um `setTimeout` (que cai **depois** do
   paint) antes do screenshot. Com software + `--disable-gpu-compositing`, uma leitura já é estável —
   medido em 3 comparações dos 24 blocos e 2 renders de vídeo real.
   Existe um modo conservador por variável de ambiente: `FRANKFRAMES_CAPTURE_SHOTS=3` exige três
   screenshots consecutivos idênticos (para hardware ou máquina sob carga).
   - em software, `--disable-gpu-compositing`: o compositor SwiftShader re-apresenta raster parcial em
     camadas com `clip-path`/`transform`;
   - **composição com vídeo roda sempre em software.** O compositor de GPU atrasa a textura da `<img>`
     fora de banda de forma não determinística (medido: 54 de 90 frames divergentes em D3D11, 0 em
     SwiftShader). `--gpu hardware` explícito é honrado, com o risco assumido.
7. **Prova**: SHA-256 por frame amostrado, versionado no repositório. Divergência de hash cai para
   comparação de PSNR contra o PNG de referência (`catalog/goldens/<bloco>/<frame>.png`): jitter de
   rasterização de 1–2 pixels passa (≥50 dB); mudança visual real falha.

**GPU:** o padrão é `auto` — hardware quando existe, SwiftShader como fallback. Igualdade byte-a-byte
entre *máquinas diferentes* só é prometida em `software`; em `hardware` a promessa é "igual nesta
máquina" (o pixel depende do driver).

Verificado em `2026-11-20`: 60 frames 720p × 2 execuções + 1 em ordem invertida, nos modos `auto`
(RTX 4060 via D3D11) e `software` (SwiftShader) → todos os hashes idênticos por frame.

## 9b. Fontes

25 famílias SIL OFL-1.1 ficam em `vendor/fonts` e são servidas em `/__ff_fonts/`: Inter (padrão),
Poppins, Montserrat, Roboto, Assistant, DM Sans, Manrope, Nunito, Raleway, Space Grotesk, Oswald,
Bebas Neue, Anton, Alfa Slab One, Bangers, Righteous, Permanent Marker, Playfair Display, Lora,
Merriweather, Great Vibes, Dancing Script, Caveat, Lobster, JetBrains Mono.

O autor usa o nome real da família (`font-family: "Poppins"`). Nenhuma fonte de CDN: o CSS injetado
só aponta para o servidor local. `html` recebe `Inter` como padrão, então `sans-serif` nunca resolve
para fonte do sistema.

## 9c. Preview

`frankframes preview` compila a mesma página que o `render` (sub-composições inlinadas, tempo
anotado, mídia extraída), então o que aparece no navegador é o que sai no MP4 — exceto a garantia de
pixel, que só existe no render.

No preview o relógio roda em **tempo real** (`__ff.startLive`): animações e visibilidade avançam
sozinhas, sem seek. Salvar qualquer arquivo do diretório recompila (~4 ms medidos) e recarrega por SSE;
o instante atual é guardado em `sessionStorage` e retomado após a recarga.

## 10. Compatibilidade

Composições escritas para outro framework entram por um **importador separado** (`compat-*`), que traduz
nomes no parsing. O núcleo não ganha um segundo nome para o mesmo conceito, nem modo "congela em t=0".
