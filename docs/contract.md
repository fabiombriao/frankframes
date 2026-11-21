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
| `data-enter` / `data-exit` / `data-emphasis` / `data-camera` / `data-transition` | movimento declarativo do clip ou de um descendente; ver §7b |
| `data-keyframes` | JSON com pontos de volume (só no clip) e de propriedades visuais (clip ou descendente); ver §7b.7 |
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

## 7b. Motion

### 7b.1 Princípio

Movimento é declarado em atributos `data-` com tempo **relativo ao clip**. O compilador (producer)
converte para animações WAAPI com tempo do escopo (o mesmo de `data-ff-comp-start`). O runtime só
reproduz. CSS `@keyframes` continua permitido; os atributos de motion são a forma recomendada.
`lint`, Studio e render passam pelo mesmo módulo puro do contrato e veem os mesmos erros.

### 7b.2 Alvos

- **Clip**: o próprio elemento temporizado (§4).
- **Descendente**: qualquer elemento dentro de um clip; o tempo dele é relativo ao clip dono. Num clip
  comum o parser não enxerga clips internos (um `data-start` aninhado não cria clip), então todo
  descendente pertence ao clip de fora. Num host de sub-composição (§5), elementos temporizados e hosts
  internos são clips do próprio escopo e levam o próprio motion.
- Erros `E_MOTION_TARGET`:
  - motion na raiz, fora de qualquer clip, ou em `<audio>`;
  - `data-camera` fora de `<img>`;
  - `data-transition` fora de um clip, ou em descendente (vale só no clip que entra);
  - motion em `<video>`: ainda não é suportado.

### 7b.3 Atributos

| Atributo | Onde | Valor |
|---|---|---|
| `data-enter` | clip ou descendente | `<preset> [chave=valor ...]` |
| `data-exit` | clip ou descendente | `<preset> [chave=valor ...]` |
| `data-emphasis` | clip ou descendente | `<preset> [chave=valor ...]` |
| `data-camera` | `<img>` (clip ou descendente) | `<preset> [chave=valor ...]`; reservado: ainda sem presets |
| `data-transition` | clip que **entra** | `<preset> [chave=valor ...]`; reservado: ainda sem presets |

Atributo reservado aceita só a gramática de §7b.4: qualquer valor dá `E_MOTION_PRESET_UNKNOWN`.

`data-keyframes` (clip ou descendente) tem formato próprio, em JSON: §7b.7.

### 7b.4 Gramática

```
valor      = preset { ws+ param } ;            (* espaços nas pontas são ignorados *)
preset     = minúscula { minúscula | dígito | "-" } ;
param      = chave "=" texto ;                 (* texto: sem espaço nem "=" *)
chave      = minúscula { minúscula } ;
segundos   = dígito+ [ "." dígito+ ] ;
âncora     = segundos | "-" segundos | segundos "%" | "end" | "end-" segundos ;
curva      = "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out"
           | "suave" | "freio" | "arranque" | "vaivem" | "mola" | "mola-firme"
           | "cubic-bezier(" num "," num "," num "," num ")"      (* sem espaços *)
           | "spring(" num "," num ")" ;                           (* ζ, ω; sem espaços *)
num        = [ "-" ] dígito+ [ "." dígito+ ] ;
distância  = num [ "px" | "%" ] ;              (* sem unidade = px *)
```

Chaves comuns a todo preset; cada preset acrescenta as dele:

| Chave | Tipo | Regra |
|---|---|---|
| `dur` | segundos > 0 | duração do movimento (por ciclo, na ênfase) |
| `at` | âncora | §7b.5 |
| `curve` | curva | substitui a curva padrão do preset em todos os trechos |

Chaves de uso geral nos presets que as declaram: `distance` (distância), `amount` (número; unidade
depende do preset), `dir` (`left|right|up|down`), `repeat` (inteiro 1..20), `fx`/`fy` (número em [0,1]).

Presets disponíveis (a lista completa e as chaves de cada um ficam em `docs/motion.md`, quando existir):

| Atributo | Preset | Movimento | `dur` | Curva | Chaves próprias |
|---|---|---|---|---|---|
| `data-enter` | `surgir` | `opacity` 0→1 | 0.5 | `suave` | — |
| `data-exit` | `apagar` | `opacity` 1→0 | 0.5 | `suave` | — |
| `data-emphasis` | `pulsar` | `scaleX` e `scaleY` 1→`amount`→1 | 0.6 | `suave` | `amount` em [0.5,3] (padrão 1.08), `repeat` |

Diagnósticos de gramática (todos `error`, com `clipId` e `hint`):

| Código | Quando | Hint |
|---|---|---|
| `E_MOTION_SYNTAX` | valor vazio, token sem `=`, chave repetida ou caractere inválido | `use data-enter="subir dur=0.6 at=0.2"` (com um preset existente) |
| `E_MOTION_PRESET_UNKNOWN` | preset inexistente para aquele atributo | lista os presets válidos do atributo |
| `E_MOTION_PARAM` | chave que o preset não tem, ou valor fora do tipo ou da faixa (`dur=-1`, `at=-1` fora de `data-enter`) | lista as chaves aceitas, ou mostra a faixa |
| `E_CURVE_INVALID` | `curve` desconhecida; `cubic-bezier` com x1 ou x2 fora de [0,1] ou y fora de [-5,5]; `spring` com ζ fora de [0.05,1] ou ω fora de [1,100]; mola que não assenta no trecho (§7b.11) | `use cubic-bezier(0.3,0,0.2,1) ou um nome: linear, ease, suave, freio, arranque, vaivem, mola, mola-firme`; na mola que não assenta, `mola precisa de dur ≥ <mín> s` |

### 7b.5 Tempo

`D` é a duração do clip (`end − start`, no escopo do clip). A âncora `T` resolve assim:

- `n` → n;
- `-n` → −n (só em `data-enter`);
- `p%` → p/100·D;
- `end` → D;
- `end-n` → D − n.

Intervalo de cada atributo:

| Atributo | `at` padrão | Intervalo do movimento |
|---|---|---|
| enter | `0` | [T, T+dur] |
| exit | `end` | [T−dur, T]: a âncora marca o **fim** |
| emphasis | fim da entrada (`0` se não houver entrada) | [T, T+dur·repeat] |
| camera | `0` | [T, T+dur]; `dur` padrão = D − T |

Regras de faixa (`E_MOTION_OUT_OF_RANGE`; o hint mostra o intervalo calculado e D):

- todo intervalo precisa terminar em ≤ D;
- nenhum intervalo pode começar antes de 0; a exceção é a entrada, que pode começar antes (o trecho
  anterior a 0 não aparece, porque o clip ainda está invisível).

D conhecida:

- Âncoras `%`, `end`, `end-n` e câmera sem `dur` exigem D. Sem D, a faixa de um movimento só é checada
  quando D existe.
- Se a duração da composição ainda é `unresolved`, a validação espera: o diagnóstico de duração já bloqueia o
  render e nada de motion é resolvido para o que depende de D.
- Se a composição resolveu mas o clip não tem fim, o que depende de D é `E_MOTION_OUT_OF_RANGE` com hint
  `defina data-duration no clip`.

### 7b.6 Propriedades, valores neutros e posse

| Propriedade | CSS animado | Neutro | Faixa |
|---|---|---|---|
| `opacity` | `opacity` | 1 | [0,1] |
| `x`, `y` | `--ff-x`, `--ff-y` → `translate` | 0 | px ou % da própria caixa |
| `scaleX`, `scaleY` | `--ff-sx`, `--ff-sy` → `scale` | 1 | [0,20] |
| `rotate` | `--ff-rot` → `rotate` | 0 | graus, [-3600,3600] |
| `blur` | `--ff-blur` → `filter: blur()` | 0 | px, [0,200] |
| `clip` | `clip-path` | `inset(0% 0% 0% 0%)` | `inset(t% r% b% l%)` ou `circle(r% at x% y%)` |
| `zoom` | `--ff-zoom` → `object-view-box` | 1 | [1,10], só `<img>`; reservado à câmera (sem preset ainda); em `data-keyframes` dá `E_KEYFRAME_INVALID` até a câmera existir (§7b.7) |
| `focusX`, `focusY` | `--ff-fx`, `--ff-fy` → `object-view-box` | 0.5 | [0,1], só `<img>`; reservado à câmera (sem preset ainda); mesma regra de `zoom` |

- `scale` é atalho para `scaleX` e `scaleY` iguais.
- O alvo com motion passa a ser **dono** das propriedades CSS que o movimento usa (`opacity`, `translate`,
  `scale`, `rotate`, `filter`, `clip-path`, `object-view-box`).
- O `transform` do autor continua valendo e compõe depois: `translate`, `rotate`, `scale` e então
  `transform`. `transform-origin` vale para escala e rotação.
- Conflitos (`E_MOTION_CONFLICT`):
  - declarar no `style` inline uma propriedade possuída que o movimento usa (estático). Exceção:
    `opacity` inline é permitida: a animação sobrepõe o valor estático sem ambiguidade;
  - uma animação CSS do autor que anima, no mesmo elemento, uma propriedade possuída: detectado no runtime, e
    o render falha com `E_MOTION_RUNTIME`.
- Num mesmo alvo, dois movimentos da mesma propriedade não podem se sobrepor no tempo
  (`E_MOTION_OVERLAP`); encostar nas pontas é permitido.
- Entre movimentos, o valor fica parado; antes do primeiro, vale o valor inicial dele; depois do último, o
  valor final.
- Se um movimento começa num valor diferente do que estava parado, o salto é aplicado e o contrato avisa
  com `W_MOTION_JUMP`.

### 7b.7 Keyframes visuais (`data-keyframes`)

`data-keyframes` é um array JSON de pontos, no clip ou em qualquer descendente. O mesmo atributo carrega o
volume do clip (EDT-40) e as propriedades visuais (§7b.6):

```
ponto = { "time": s, "volume"?, "opacity"?, "x"?, "y"?, "scale"? | "scaleX"? | "scaleY"?,
          "rotate"?, "blur"?, "clip"?, "zoom"?, "focusX"?, "focusY"?, "curve"? }
```

```html
<div data-start="0" data-duration="3"
     data-keyframes='[{"time":0,"opacity":0,"x":0,"curve":"mola"},
                      {"time":1,"opacity":1,"x":400}]'>…</div>
```

- `time` é em segundos ≥ 0, relativo ao início do clip dono (o mesmo dos pontos de volume). A ordem dos
  pontos no JSON não importa: as trilhas usam a ordem de `time`.
- Valores aceitos (faixas de §7b.6):

  | Chave | Valor |
  |---|---|
  | `opacity` | número em [0,1] |
  | `x`, `y` | número (px) ou texto `"<n>px"` / `"<n>%"` (% da própria caixa) |
  | `scale`, `scaleX`, `scaleY` | número em [0,20]; `scale` é atalho de `scaleX` e `scaleY` iguais |
  | `rotate` | número em graus, [-3600,3600] |
  | `blur` | número em px, [0,200] |
  | `clip` | `inset(t r b l)` (1 a 4 valores, todos em `%`, [0,100]) ou `circle(r% at x% y%)` (r em [0,150], x e y em [0,100]) |
  | `volume` | só no clip; número ≥ 0, como em §4 |
  | `curve` | curva de §7b.4 |

- Cada propriedade forma uma **trilha** com os pontos que a têm. O intervalo da trilha é [primeiro `time`,
  último `time`]. Um ponto único é uma trilha constante: o valor vale o clip inteiro.
- `curve` vale para os trechos que **começam** no ponto, em todas as propriedades dele; o padrão é `linear`.
  Um trecho de uma trilha vai do ponto ao próximo ponto que **tem aquela propriedade**, com a curva do
  ponto de partida. A duração do trecho (`time` seguinte − `time`) decide a emissão da mola (§7b.11).
- A trilha entra nas mesmas regras de posse, sobreposição e salto de §7b.6 contra presets e outras trilhas
  da mesma propriedade no mesmo alvo (`E_MOTION_OVERLAP`, `W_MOTION_JUMP`). Exemplo:
  `opacity` de 0 a 1 em `[0,1]` mais `data-enter="surgir"` no mesmo alvo dá `E_MOTION_OVERLAP`.
- `volume` mantém o formato e o resultado de sempre: `RawClip.keyframes` traz só `{time, volume}` dos
  pontos que têm `volume`, sempre lineares. Ponto só de volume não cria alvo de motion.
- `zoom`, `focusX` e `focusY` são reservados à câmera (§7b.6): enquanto ela não existe, dão
  `E_KEYFRAME_INVALID` com hint explicando; nunca um movimento que não aparece.

Diagnósticos (todos com `clipId`; os erros têm `hint`):

| Código | Severidade | Quando | Hint |
|---|---|---|---|
| `E_NUMBER_INVALID` | error | JSON malformado, não é array, ou `time`/`volume` não finito ou negativo (como antes) | o de hoje |
| `E_KEYFRAME_INVALID` | error | chave desconhecida; valor fora do tipo ou da faixa; `scale` junto com `scaleX`/`scaleY` no mesmo ponto; dois pontos com o mesmo `time`; ponto sem nenhuma propriedade; `clip` misturando `inset` e `circle` na mesma trilha; `zoom`/`focusX`/`focusY` (reservados à câmera); `volume` em descendente | diz o ponto (índice), a chave e a faixa válida |
| `E_KEYFRAME_LIMIT` | error | mais de 256 pontos | `divida em elementos ou reduza para ≤ 256 pontos` |
| `W_KEYFRAME_OUT_OF_RANGE` | warning | `time` maior que a duração D do clip; o ponto é mantido | `o ponto em t=<n> s nunca aparece: o clip termina em <D> s` |
| `W_KEYFRAME_CURVE_IGNORED` | warning | `curve` num ponto só de volume (o volume é sempre linear) | `remova curve ou acrescente uma propriedade visual ao ponto` |

### 7b.11 Curvas

- `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`: as do CSS.
- Curvas próprias:

  | Nome | Definição |
  |---|---|
  | `suave` | `cubic-bezier(0.34,0.1,0.18,1)` |
  | `freio` | `cubic-bezier(0.18,0.72,0.28,1)` |
  | `arranque` | `cubic-bezier(0.56,0,0.84,0.42)` |
  | `vaivem` | `cubic-bezier(0.58,0.04,0.3,0.97)` |
  | `mola` | `spring(0.45,18)` |
  | `mola-firme` | `spring(0.7,14)` |

- Cada trecho entre dois pontos (do preset ou de `data-keyframes`) leva a curva do preset (ou a de `curve`),
  ou a do ponto de partida em keyframes.
- O easing sai como o nome CSS (`linear`, `ease-in`...) ou `cubic-bezier(x1, y1, x2, y2)`; a avaliação
  (`evaluateCurve`) usa bissecção determinística de 40 iterações.
- `spring(ζ,ω)`, com ζ em [0.05,1] e ω em [1,100] (rad/s), é função fechada do tempo do trecho, τ ∈ [0,dur]
  em segundos, com `x(0)=0` e `x(dur)=1`:
  - ζ < 1: `x(τ) = 1 − e^(−ζωτ)·(cos(ω_d τ) + (ζω/ω_d)·sin(ω_d τ))`, com `ω_d = ω·√(1−ζ²)`;
  - ζ = 1: `x(τ) = 1 − e^(−ωτ)·(1 + ωτ)`.
  Passa de 1 (overshoot) quando ζ < 1. Nada é simulado passo a passo.
- A mola precisa **assentar** dentro do trecho:
  - envelope `e^(−ζω·dur)/√(1−ζ²)` ≤ 0.01 (com ζ = 1: `e^(−ω·dur)(1+ω·dur)` ≤ 0.01);
  - senão `E_CURVE_INVALID`, com hint `mola precisa de dur ≥ <mín> s` (mín arredondado para cima em 0.01).
    Exemplo: `spring(0.45,18)` pede dur ≥ 0.59 s.
- Emissão da mola: como depende de `dur`, o easing do trecho é `linear(v0, v1, ..., v63)`:
  - 64 amostras em p = i/63, com τ = p·dur; i = 0 vale 0 e i = 63 é forçado a 1;
  - 4 casas decimais (`Number(v.toFixed(4))`).
  Valores acima de 1 são válidos em `linear()`; o render prova que o Chrome pinado não os limita.

### 7b.12 Compilação e runtime

- O compilador grava em cada alvo `data-ff-motion` com JSON:
  - formato: `{"v":1,"a":[{"p":<propriedade CSS>,"d":<atraso ms>,"n":<duração ms>,"k":[[offset,valor,easing|null],...]}],"s":[[<propriedade CSS>,<valor do binding>],...]}`;
  - `d` é relativo ao `data-ff-comp-start` mais próximo do alvo (o mesmo que o relógio usa para
    sincronizar animações): início absoluto do clip dono, menos esse escopo, mais o tempo local, em ms com
    3 casas; pode ser negativo (entrada que começa antes de 0);
  - `n` ≥ 1;
  - uma entrada em `a` por propriedade CSS; `easing` é o do trecho que **começa** naquele ponto e `null`
    vale `linear`;
  - `s` traz as declarações de ligação, por exemplo `["translate","var(--ff-x) var(--ff-y)"]`;
  - valores dos pontos: `x`/`y` viram `"<n>px"` (ou ficam em `%`), `rotate` vira `"<n>deg"`, `blur` vira
    `"<n>px"`, `scale*` são números, e `clip` vai direto em `clip-path`, normalizado (`inset(0% 10% 0% 0%)`:
    sempre `%`, 4 valores; `circle(50% at 50% 50%)`);
  - trilha constante (ponto único) sai com duas chaves iguais e `n` = 1.
- O runtime (engine):
  - registra as propriedades `--ff-*` (`inherits:false`);
  - aplica `s` no `style` do alvo;
  - cria `el.animate(k, {delay:d, duration:n, fill:"both", easing:"linear", id:"ff-motion"})`;
  - deixa o relógio sincronizar como qualquer animação (`currentTime = agora − data-ff-comp-start`).
- Conflito de posse detectado no runtime sai como `E_MOTION_CONFLICT: ...` na prontidão do relógio e o render
  falha com `E_MOTION_RUNTIME` (etapa `capture`).
- Seek em qualquer ordem dá o mesmo frame.
- `<video>` com motion: as animações vão para a `<img>` que substitui o vídeo (§6); o vídeo continua
  decodificado pelo FFmpeg. Ainda não é suportado: o runtime recusa `video[data-ff-motion]` com
  `E_MOTION_TARGET`.
- Composição sem atributos de motion compila exatamente como antes (§10).

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
   As animações CSS/WAAPI existentes ficam **pausadas em 0 já na prontidão**, antes de esperar fontes e imagens:
   não correm em tempo real até o primeiro seek. Se corressem, o tempo real decorrido (a carga da máquina)
   decidiria quais terminam e quais ficam como camada do compositor, e o raster do texto mudaria 1 px de
   uma execução para outra (visto nos goldens `vertical-toc` e `vertical-callout` com 4 capturas paralelas).
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
8. **Fonte declarada que não carrega bloqueia o render.** Na prontidão o engine carrega **toda** face
   declarada (`@font-face`, inclusive as embarcadas), e não só as que algum elemento usa. Se uma falha, a
   prontidão é rejeitada e o render para na etapa `capture` com `E_FONT_LOAD`, sem capturar um frame na fonte de
   reserva. A mensagem traz a família, o peso e o estilo da face e manda conferir o `src` do `@font-face` ou a
   fonte em `vendor/fonts`. Face declarada e nunca usada também falha: declarar é prometer que carrega, e
   apagar o `@font-face` morto é a correção. O código é de render, como `E_MOTION_RUNTIME`.
9. **Captura nunca espera para sempre.** O servidor local e a sessão do browser falham alto, com código e `hint`:
   - **Servidor de assets.** Caminho que não existe (`ENOENT`, `ENOTDIR`, `EISDIR`) responde `404`. Qualquer outro
     erro de leitura responde `500` com o código do sistema no corpo (`erro ao servir o arquivo: EBUSY`); nunca
     vira `404`. Só `EBUSY`, `EPERM` e `EACCES` são repetidos, e só dentro da leitura do servidor: no máximo 3
     repetições, com 50, 100 e 200 ms de espera; esgotadas, `500`. Cada falha e cada repetição vai para o
     log do servidor (uma linha em stderr: `[frankframes] servidor: EBUSY ao ler /x (tentativa 2, vai repetir)`) e para o
     registro dele (`failures()`, as 50 mais recentes: caminho, código, tentativa, resultado), e esse
     registro é anexado à mensagem da falha da sessão (`E_FONT_LOAD: … [servidor: EBUSY ao ler fonts/X.woff2 (4 falha(s),
     sem sucesso)]`). Nenhuma outra camada repete leitura de arquivo.
   - **Queda do browser.** Se o Chrome cai ou é encerrado, toda operação pendente da sessão rejeita com
     `E_BROWSER_CLOSED`, e toda operação seguinte rejeita na hora com o mesmo código. A sessão não repete por
     conta própria; o render faz uma única repetição classificada dessa falha (`retryOnceIfTransient`).
   - **Prazos explícitos.** Abrir o Chrome (60 s), a prontidão da página (120 s), cada seek (60 s) e cada captura
     (120 s) têm prazo. Estourar um deles rejeita com `E_BROWSER_TIMEOUT`, cuja mensagem diz qual operação
     passou do prazo e cujo `hint` diz o que conferir. Estouro de prazo não é repetido.
   - **Quem abre fecha.** Se a abertura da sessão rejeita, o Chrome e o servidor local são fechados antes de
     a rejeição chegar ao chamador (`openSessionFor`); fechar o servidor duas vezes é permitido.
   Os dois códigos são códigos de render (`stage: "capture"`), como `E_FONT_LOAD`.

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

No preview o relógio roda em **tempo real** (`__ff.startLive`) e **termina no último frame**
(`(frames − 1) / fps`): ao chegar lá, para e fica nele; Play no fim recomeça do 0. Com **Loop** ligado
(botão ⟳ da barra; tecla L no Studio; lembrado na aba), volta ao 0 sem parar. Animações e visibilidade
avançam sozinhas, sem seek. Salvar qualquer arquivo do diretório recompila (~4 ms medidos) e recarrega por
SSE; o instante atual é guardado em `sessionStorage` (nunca acima do último frame) e retomado após a
recarga. `__ff.transportHooks` recebe `start`, `stop`, `seek`, `end` e `loop`. Sem `__ff.setLiveBounds`
o relógio ao vivo é ilimitado; a barra de controle sempre o chama.

**Áudio no preview** é o mesmo mix do render (mesmo grafo: volume, fades, `data-offset`,
`data-playback-rate` com tom preservado, `data-keyframes`, ducking de `music` sob `voice` e loudnorm de
entrega), feito pelo FFmpeg em WAV e guardado em `cache/preview-audio/<sha256>.wav`. A chave só muda quando
muda algo que entra no mix (faixas, tempos, arquivos de mídia), então editar texto ou layout não refaz o
áudio. O navegador toca o WAV pelo Web Audio, sincronizado com o relógio ao vivo, e recomeça o som quando a
deriva passa de meio frame; o `<audio>` nativo da página fica mudo, para o som sair só do mix. Se o navegador
bloquear o som, a barra mostra "Som bloqueado — clique para ativar". Falha do mix aparece na barra
(`E_PREVIEW_AUDIO`) e em `__ff.liveErrors`, sem derrubar o vídeo. Acima de 20 min o áudio do preview fica
desligado, com aviso na barra. O servidor entrega o mix em `/__ff_audio/<sha256>.wav` (só nomes de 64 hex).
Se o mix inteiro é silêncio digital, não há o que normalizar: o loudnorm não é aplicado e o aviso
`áudio silencioso: loudnorm não aplicado` sai nos avisos do render (e no log do preview, quando o mix é feito).
Qualquer outra falha de medição continua falhando alto.

## 9d. Studio

`frankframes studio` edita o HTML da entrada; toda escrita passa pelo contrato antes de ir para o disco
(contrato inválido não grava, `E_CONTRACT_INVALID` com os diagnósticos) e preserva formatação e comentários.

- **Importar mídia** (`POST /api/media?name=&start=`, arquivo cru no corpo). Vídeo (`.mp4 .m4v .mov .webm
  .mkv`), áudio (`.mp3 .wav .m4a .aac .ogg .opus .flac`) ou imagem (`.png .jpg .jpeg .webp .gif .svg`) é
  copiado para `assets/` ao lado da entrada com nome seguro (sem acento, espaço ou caminho). Conteúdo
  idêntico a um arquivo existente reaproveita o arquivo; nome igual com conteúdo diferente ganha sufixo
  `-<sha256[0:8]>` — nada é sobrescrito. O clip entra no fim da raiz com `data-start` no playhead e
  `data-duration` medida pelo ffprobe (imagem: 3 s). Arquivo ilegível falha com `E_MEDIA_PROBE` e é
  apagado; extensão fora da lista é `E_MEDIA_UNSUPPORTED`; teto de 4 GiB (`E_MEDIA_TOO_LARGE`).
- **Dividir** (`POST /api/clips/<id>/split {at}`). Só para clip de topo com `data-clip-id` explícito, sem
  `data-keyframes`, atributos de motion (§7b) nem filhos (`E_SPLIT_UNSUPPORTED`), e com `at` a mais de 1 ms das bordas
  (`E_SPLIT_OUT_OF_RANGE`). A primeira metade fica com `data-duration = at − início` e perde o
  `data-fade-out`; a cópia entra logo depois com `data-start="<id>"` (começa onde a primeira termina),
  o resto da duração, sem `data-fade-in` e, em vídeo/áudio, `data-offset` avançado em
  `(at − início) × data-playback-rate`. Clips que referenciavam o fim do original passam a referenciar a
  cópia, então nada mais na timeline se move.
- **Desfazer/refazer** (`POST /api/undo`, `POST /api/redo`, `GET /api/history`). O histórico guarda até
  200 versões completas do arquivo, só em memória, e some quando o Studio fecha. Se o arquivo mudou fora
  do Studio, desfazer/refazer recusa com `409 E_HISTORY_STALE` e descarta o histórico em vez de
  sobrescrever a mudança. Desfazer uma importação remove o clip, não o arquivo em `assets/`.
- **Playhead.** Vai de 0 ao início do último frame, `(frames − 1) / fps`, nunca ao fim da composição. A
  barra do preview no Studio não abre `/__ff_reload`: o Studio recarrega pelo próprio `/api/events`.
- **Caminhos relativos** do preview resolvem contra o diretório da entrada via `<base href="/__ff_site/">`.
  Nenhum caminho com segmento começando por `.` (`.env`, `.git`) é servido.

- **Composição** (`GET /api/composition`). Devolve, por clip, `track`, `kind` (`video`, `text` ou `audio`),
  `editable` e os campos de mídia (`hasAudio`, `mediaSrc`, `fadeIn`, `fadeOut`, `hasKeyframes`,
  `hasChildren`, `parentId`). Ferramentas de edição só operam em clip `editable`: de topo e com
  `data-clip-id` explícito no arquivo.

As escritas são serializadas: duas edições nunca intercalam leitura e gravação do mesmo arquivo.

## 10. Compatibilidade

Composições escritas para outro framework entram por um **importador separado** (`compat-*`), que traduz
nomes no parsing. O núcleo não ganha um segundo nome para o mesmo conceito, nem modo "congela em t=0".

Composições sem atributos de motion (§7b) compilam exatamente como antes: o compilador não grava
`data-ff-motion` e o runtime de motion não cria animação. Pontos de `data-keyframes` só com `volume`
continuam idênticos: mesmo `RawClip.keyframes`, mesma mixagem, nenhum alvo de motion.
