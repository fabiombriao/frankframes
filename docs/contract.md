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

**Tamanho do quadro (EDT-87).** `data-width` × `data-height` da raiz são a **única fonte** do viewport: o render
abre o navegador nesse tamanho (padrão 1920×1080 se faltar) e o preview do Studio também (§9d). O CSS da página não
define o quadro: o `init` gera o `#stage` com `width: 100vw; height: 100vh`, então mudar a raiz (pelo inspetor de
Composição, §9d) muda o quadro sem editar CSS. Composição com tamanho fixo em CSS diferente da raiz é do autor.

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

Ids podem ter hífen, então `clip-1` também lê como `clip − 1`. **O id exato vence**: quando o valor inteiro,
sem espaços, é o `data-clip-id` de um clip da composição, é referência a esse clip com deslocamento 0. Só
se não houver clip com esse id vale `id ± n` (`a-0.25` sem clip `a-0.25` é o fim de `a` menos 0,25 s). Com
os dois ids existindo (`clip` e `clip-1`), `clip-1` é o fim de `clip-1`. Com espaços (`clip - 1`) é sempre
`id ± n`, sem ambiguidade. A escolha é feita uma vez, na resolução; todo consumidor de `startExpr` vê a
referência já normalizada.

`data-duration` é segundos ≥ 0. `data-end` não existe no vocabulário: o fim é sempre derivado.

## 4. O que é um clip

Uma linha de timeline, nesta ordem de decisão:

1. **host de sub-composição** — tem `data-composition-src` ou `data-composition-id` (fora a raiz);
2. **elemento temporizado** — tem `data-start`, ou tem `data-track` e `data-duration`, ou é `<video>`, `<audio>`, `<img>`.

Wrapper sem tempo é atravessado: `div > section > clip` produz um clip, não três. Um container que só
tem `data-track` (sem duração) **não** é clip. A varredura para no primeiro clip: um `data-start` dentro de
um clip comum não cria outro clip e avisa (`W_NESTED_START_IGNORED`, §7b.2).

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
| `data-track` | inteiro. Num clip **visual**, define a camada: o compilador acrescenta `z-index:<n>` ao `style` do clip, salvo se o autor já declarou `z-index` nele. Faixa maior fica por cima. Só tem efeito em elemento posicionado (ou item de flex/grid). Não mexe em tempo. Em `<audio>` é só organização. Clip sem `data-track` segue a ordem do documento |
| `class="clip"` | convenção de autoria. **Nunca** governa visibilidade — o runtime usa o atributo `data-start` |

## 5. Sub-composições

- Inline: `<template>` dentro do host **ou** filhos diretos do host. Um host de sub-composição é uma
  fronteira de escopo: o conteúdo interno é outra composição, com tempo local, e **não** vaza para a raiz.
- Externa: `data-composition-src="card.html"`.
- O compilador remove `data-composition-src` depois de inlinar o arquivo; por isso o host externo também leva
  `data-composition-id` (é ele que o mantém como sub-composição, com o tempo interno isolado e a checagem de id
  duplicado entre arquivos). Só o conteúdo da raiz interna entra no host: a classe e o `style` da raiz interna
  não são copiados, e o `<style>`/`<script>` do `<head>` do arquivo valem para a página inteira.
- Profundidade máxima 20; ids de clip são **únicos em toda a árvore** (referências atravessam escopos).
- Duração do host: `data-duration` do host; senão `data-duration` da raiz interna; senão indefinida.

## 6. Mídia

O contrato puro não abre arquivos. Duração de `<video>`/`<audio>` vem de:

1. `data-duration` no elemento; ou
2. `mediaDurations` medido por probe (`loadComposition(html, { mediaDurations })`).

Sem nenhum dos dois, o clip fica **pendente** e a composição é `unresolved` (`pending-clips`).
O render nunca começa com duração pendente.

O Chrome nunca decodifica `<video>`: o render troca cada um por uma `<img>` com os frames extraídos pelo
FFmpeg (§9). A `<img>` substituta:

- **herda `object-fit` e `object-position` computados do vídeo** (`fill`, `cover`, `contain`...): o vídeo
  com `object-fit:cover` aparece com `cover` também no render. Antes da EDT-53 a substituta sempre usava
  `object-fit:fill`; agora o enquadramento do vídeo é o que o autor escreveu;
- leva o `data-ff-start`/`data-ff-end` (janela de visibilidade), o `data-ff-comp-start` e o
  `data-ff-motion` do vídeo: `data-enter`, `data-exit`, `data-emphasis`, `data-camera` e `data-keyframes`
  em `<video>` animam a `<img>` (§7b.12);
- é `position:fixed` na caixa medida do vídeo. Limite: motion num **ancestral** do `<video>` não move a
  `<img>`; ponha o motion no próprio `<video>` ou num elemento que não seja ancestral dele.

**Rotação do contêiner (EDT-86).** Vídeo de celular em retrato costuma ser gravado em paisagem (ex.: 1920x1080)
com uma Display Matrix de rotação (`-90`), e aparece em 1080x1920. A regra é uma só para todos os caminhos:

- o probe (`probeVideo`) reporta as dimensões gravadas (`width`/`height`), a `rotation` (convenção do ffprobe:
  anti-horário positivo, em [-180, 180); o retrato do celular dá `-90`), `mirrored` (espelhamento) e as
  dimensões de exibição `displayWidth`/`displayHeight` (as gravadas, trocadas quando a rotação é ±90). O
  manifesto de mídia leva essa `orientation` em cada clip;
- as dimensões de exibição são as que valem onde dimensão importa; `object-fit`/`object-position` da `<img>`
  agem sobre o tamanho já girado;
- a extração usa `-autorotate` explícito e confere que o primeiro frame tem exatamente o tamanho de exibição;
  render, `frankframes preview` e Studio mostram esses mesmos frames na `<img>` (o Chrome nunca decodifica o
  vídeo), então a orientação é idêntica nos três;
- só rotação de 0, 90, 180 ou 270 graus, com ou sem espelhamento, é aceita. Outro ângulo ou matriz com
  cisalhamento falha alto com **`E_MEDIA_ROTATION`** (estágio `probe`; `extract` se o FFmpeg não aplicar a
  rotação), com `hint`: o FFmpeg giraria com cantos pretos e o navegador ignoraria o ângulo, e preview e render
  divergiriam. Vale mesmo com `data-duration` no `<video>`;
- fora do escopo: proporção de pixel anamórfica (SAR) e a tag legada `rotate` do stream.

## 7. Duração da composição

1. `data-duration` da raiz > 0 → `authored`.
2. senão, se algum clip não tem início resolvível → `unresolved` (`invalid-start`).
3. senão, se algum clip não tem duração → `unresolved` (`pending-clips`) com a lista.
4. senão → `derived` = maior `start + duration`, com piso de `1/60` s.

**`data-duration` da raiz manda e corta (EDT-84).** Em `authored` o fim da composição é o valor escrito, mesmo que
um clip termine depois: o preview, o playhead e o render param ali. Para o corte nunca ser silencioso, todo clip de
topo cujo fim (`start + duration`) passa do fim autoral gera o aviso **`W_CLIP_PAST_END`** (`warning`, não bloqueia o
render: cortar na duração declarada é legítimo, por exemplo uma vinheta de 4 s sobre uma mídia longa), com o id do
clip (`clipId`) e os dois instantes na mensagem (fim do clip × fim da composição) e um `hint` que aponta a saída:
aumentar `data-duration` ou removê-lo para derivar do conteúdo. A tolerância é de 1 µs. Clips dentro de
sub-composição não entram (o fim deles é local ao host); a raiz sem `data-duration` (`derived`) nunca dispara o
aviso, porque a duração já acompanha o maior fim.

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
  descendente pertence ao clip de fora. Como isso é fácil de errar (o autor espera um clip e o motion
  do elemento passa a contar do início do clip dono), cada descendente de clip comum que declara
  `data-start` gera um aviso `W_NESTED_START_IGNORED` (por elemento, `clipId` = o clip dono, nunca
  bloqueia o render). Não avisa dentro de host de sub-composição, onde o temporizado é clip do escopo;
  hosts aninhados num clip comum avisam pelo próprio `data-start` e não são atravessados. O critério é o
  atributo `data-start`: descendente só com `data-enter` e mídia sem `data-start` não avisam. Num host de sub-composição (§5), elementos temporizados e hosts
  internos são clips do próprio escopo e levam o próprio motion.
- Erros `E_MOTION_TARGET`:
  - motion na raiz, fora de qualquer clip, ou em `<audio>`;
  - `data-camera` fora de `<img>` e `<video>`;
  - `data-transition` fora de um clip, ou em descendente (vale só no clip que entra).

`<video>` aceita todo o motion: ele vai para a `<img>` que substitui o vídeo no render (§6, §7b.12).

### 7b.3 Atributos

| Atributo | Onde | Valor |
|---|---|---|
| `data-enter` | clip ou descendente | `<preset> [chave=valor ...]` |
| `data-exit` | clip ou descendente | `<preset> [chave=valor ...]` |
| `data-emphasis` | clip ou descendente | `<preset> [chave=valor ...]` |
| `data-camera` | `<img>` ou `<video>` (clip ou descendente) | `<preset> [chave=valor ...]`: §7b.9 |
| `data-transition` | clip que **entra** (B) | `<preset> [chave=valor ...]`, com `data-start="<id de A> - <d>"`: §7b.10 |
| `data-split` | elemento com texto | `word` ou `letter`, mais `stagger=<s>` e `order=forward\|reverse\|center`: §7b.8 |
| `data-unit` | descendente de um `data-split` | vazio ou âncora em segundos; marca a unidade à mão: §7b.8 |

Atributo reservado aceita só a gramática de §7b.4: qualquer valor dá `E_MOTION_PRESET_UNKNOWN`.

Os presets de `data-enter`, `data-exit` e `data-emphasis` estão em [`docs/motion.md`](motion.md).

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

Presets disponíveis: 26, sendo 12 de `data-enter`, 8 de `data-exit` e 6 de `data-emphasis`. A lista (nome, label,
movimento, `dur` e curva padrão, chaves e miniatura de cada um) é a de [`docs/motion.md`](motion.md), que é a fonte
de verdade; esta seção fixa só as regras comuns:

- Entrada vai do deslocamento até o neutro; saída vai do neutro até o deslocamento; ênfase sai do neutro e volta a
  ele (neutros em §7b.6). `dur` é por ciclo na ênfase; a duração total é `dur × repeat`.
- Nomes ASCII em `kebab-case`; o `label` em português com acento serve só à UI.
- `curve=` do autor substitui todas as curvas do preset, inclusive as de dois trechos (`saltar`, `quicar`).
- Faixas das chaves de uso geral (valor fora da faixa é `E_MOTION_PARAM`, e o hint traz a faixa):

| Chave | Tipo | Faixa | Padrão |
|---|---|---|---|
| `distance` | distância (`px` ou `%`, com sinal) | \|n\| ≤ 2000 px ou ≤ 200 % | por preset (16, 32 ou 48 px) |
| `amount` de escala (`crescer`, `assentar`, `recuar`, `saltar`, `respirar`) | número | [0.05,5] | por preset |
| `amount` de escala em `pulsar` (já existente) | número | [0.5,3] | 1.08 |
| `amount` em graus (`girar`, `balancar`) | número | [0,180] | por preset |
| `amount` em px (`focar`, `desfocar`: blur; `tremer`: deslocamento) | número | blur [0,100]; `tremer` [0,200] | 12, 12 e 6 |
| `amount` de opacidade (`piscar`) | número | [0,1] | 0.2 |
| `dir` (`abrir`, `fechar`) | `left`, `right`, `up` ou `down` | — | `abrir` right, `fechar` left |
| `repeat` (ênfase) | inteiro | [1,20] | 1 |

- Uma chave que o preset não declara é `E_MOTION_PARAM` (`surgir distance=10`, `focar dir=left`).
- Mola em preset: `saltar` usa `mola` na escala e `suave` na opacidade; com `dur=0.3` a mola não assenta
  e dá `E_CURVE_INVALID` (mínimo de 0.59 s por trecho; o padrão de 0.7 s assenta). Em `quicar` cada meio ciclo é
  um trecho, então `curve=mola` pede `dur` ≥ 1.18 s.

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
| `zoom` | `--ff-zoom` → `object-view-box` | 1 | [1,4], só `<img>` e `<video>`; zoom ≥ 1 (câmera, §7b.9) |
| `focusX`, `focusY` | `--ff-fx`, `--ff-fy` → `object-view-box` | 0.5 | [0,1], fração da imagem; só `<img>` e `<video>` |

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
  | `zoom` | só em `<img>` e `<video>`; número em [1,4] (fator; 1 = imagem inteira) |
  | `focusX`, `focusY` | só em `<img>` e `<video>`; número em [0,1] (fração da imagem sob o centro do quadro) |
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
- `zoom`, `focusX` e `focusY` são a câmera (§7b.9) e só valem em `<img>` e `<video>`: em qualquer outro
  elemento dão `E_KEYFRAME_INVALID` com o hint `zoom e foco só valem em img ou video`; nunca um movimento
  que não aparece. Num `<video>` o movimento vai para a `<img>` que o substitui (§6).

Diagnósticos (todos com `clipId`; os erros têm `hint`):

| Código | Severidade | Quando | Hint |
|---|---|---|---|
| `E_NUMBER_INVALID` | error | JSON malformado, não é array, ou `time`/`volume` não finito ou negativo (como antes) | o de hoje |
| `E_KEYFRAME_INVALID` | error | chave desconhecida; valor fora do tipo ou da faixa; `scale` junto com `scaleX`/`scaleY` no mesmo ponto; dois pontos com o mesmo `time`; ponto sem nenhuma propriedade; `clip` misturando `inset` e `circle` na mesma trilha; `zoom`/`focusX`/`focusY` fora de `<img>`/`<video>` ou fora da faixa (`zoom` em [1,4], foco em [0,1]); `volume` em descendente | diz o ponto (índice), a chave e a faixa válida |
| `E_KEYFRAME_LIMIT` | error | mais de 256 pontos | `divida em elementos ou reduza para ≤ 256 pontos` |
| `W_KEYFRAME_OUT_OF_RANGE` | warning | `time` maior que a duração D do clip; o ponto é mantido | `o ponto em t=<n> s nunca aparece: o clip termina em <D> s` |
| `W_KEYFRAME_CURVE_IGNORED` | warning | `curve` num ponto só de volume (o volume é sempre linear) | `remova curve ou acrescente uma propriedade visual ao ponto` |

### 7b.8 Tipografia cinética (`data-split`)

`data-split` divide o texto de um elemento em **unidades** (palavras ou letras) e aplica `data-enter`,
`data-exit` e `data-emphasis` do mesmo elemento a **cada unidade**, com um atraso escalonado.

```
split   = modo { ws+ param } ;
modo    = "word" | "letter" ;
param   = "stagger=" segundos | "order=" ( "forward" | "reverse" | "center" ) ;
```

```html
<h1 data-start="0" data-duration="4" data-split="word stagger=0.08" data-enter="subir dur=0.5">
  Coração, ação e emoção
</h1>
```

- `stagger` (segundos ≥ 0, no máximo 10): padrão `0.06` em `word` e `0.03` em `letter`. `order` padrão
  `forward`.
- O elemento precisa ter `data-enter`, `data-exit` ou `data-emphasis`; sem nenhum dá `E_MOTION_TARGET` com
  hint `data-split precisa de data-enter, data-exit ou data-emphasis`. Os três valem por unidade, com a
  gramática, os presets e as faixas de §7b.4 a §7b.6.
- `data-keyframes` no mesmo elemento continua valendo para o **elemento inteiro** (não por unidade).
- `data-split` não combina com `data-camera` nem `data-transition` (`E_MOTION_TARGET`).

**Segmentação** (`Intl.Segmenter` com locale fixo `und`, nunca o do sistema). O texto alvo são os nós de
texto descendentes do elemento (ignora `script`, `style`, `textarea`, `title`, `svg`, `math`, `noscript` e
sub-composições); cada nó é segmentado sozinho. A soma dos pedaços reconstrói o texto byte a byte.

- `word`: cada palavra é uma unidade; espaço e quebra de linha ficam soltos, fora das unidades. Pontuação
  colada ao fim gruda na palavra anterior (`Olá,` é uma unidade); a do começo (`“Sim`, `¿Qué`) gruda na
  seguinte. Pontuação ou emoji isolado entre espaços vira unidade própria.
- `letter`: cada grafema é uma unidade (`é` decomposto, `👍🏽` e `👨‍👩‍👧` são uma só). Espaços ficam soltos e
  cada palavra vai num `<span>` com `white-space:nowrap`, para a linha nunca quebrar no meio dela.
- Elemento com motion próprio dentro do alvo (`data-enter`, `data-exit`, `data-emphasis`, `data-keyframes`,
  `data-split`) dá `E_MOTION_TARGET`: o split anima o texto, não dois níveis de movimento. Sem nenhuma
  unidade, `E_MOTION_TARGET` com hint `data-split sem texto: ponha texto no elemento ou marque as unidades
  com data-unit`.

**Tempo por unidade.** Com `n` unidades, a unidade `i` tem posto `r`: `forward` = i, `reverse` = n−1−i,
`center` = ⌊|i−(n−1)/2|⌋. Seja `R` o maior posto. Cada preset usa a âncora `T` de §7b.5 e ganha o
deslocamento:

| Atributo | Intervalo da unidade |
|---|---|
| enter | começa em `T + r·stagger` |
| exit | termina em `T − (R−r)·stagger` (a última a sair termina em `T`) |
| emphasis | começa em `T + r·stagger`; sem `at`, `T` = fim da última entrada |

Cada intervalo passa pelas regras de faixa de §7b.5; estourar dá `E_MOTION_OUT_OF_RANGE` dizendo qual unidade
(`unidade 3 de 8`) e com hint sugerindo reduzir `stagger` ou `dur`. Sobreposição de trilhas de **uma mesma
unidade** segue §7b.6 (`E_MOTION_OVERLAP`); unidades diferentes nunca conflitam entre si.

**Modo explícito** (`data-unit`). Se há descendentes com `data-unit`, só eles são unidades, na ordem do
documento, e o texto não é reescrito. Valor vazio segue o escalonamento; um número em segundos (aceita
negativo) fixa o **início da entrada** daquela unidade, no tempo do clip; `data-exit` e `data-emphasis`
seguem sempre o escalonamento pelo posto. Valor inválido dá `E_MOTION_PARAM`. `data-unit` fora de um `data-split`, ou
dentro de outro `data-unit`, é `E_MOTION_TARGET`. `style` inline de uma unidade com propriedade possuída
(§7b.6) dá `E_MOTION_CONFLICT` com o número da unidade.

**Compilação.** O producer reescreve o texto como `<span data-ff-unit="<i>" style="display:inline-block">`
(o `transform` não vale em elemento `inline`) e grava `data-ff-motion` (§7b.12) em cada unidade, usando o
serializer do HTML, que escapa o texto. Unidades explícitas só ganham `data-ff-unit` e
`display:inline-block` (a não ser que o autor já declare `display`). O `textContent` do elemento não muda;
a fonte, o tamanho e a cor continuam herdados.

**Legendas.** `buildCaptionComposition(segments, { motion: { enter, exit? } })` e a flag
`frankframes captions --motion "<preset de entrada>"` ligam o split nas legendas: o bloco de cada legenda
recebe `data-split="word"`, `data-enter` e `data-exit`. Com palavras temporizadas o segmento sai dividido em
legendas curtas (`docs/transcribe.md`), cada palavra leva `data-unit="<início da palavra − início da legenda>"`
e o `stagger` é 0, de modo que a entrada acompanha a fala. Depois das quebras, a legenda mais curta que a
duração mínima é juntada à seguinte do mesmo segmento (a última, à anterior) até nenhuma ficar abaixo, mesmo
que passe de `maxWords`. A mínima é o maior valor entre 0,4 s e o que as molas do motion pedem: para a entrada
mais a saída, a menor `dur` em que cada trecho com mola assenta (§7b.11; `saltar`: 0,59 s), do preset ou de
`curve=`; sem mola, 0,4 s. Um segmento inteiro mais curto que a mínima fica como uma legenda só, sem erro da
divisão. A `dur` do autor abaixo do que a mola pede não é corrigida: continua `E_CURVE_INVALID`. A mínima não
reserva sozinha o espaço da saída depois da entrada da última palavra. Sem palavras com tempo, a legenda é o segmento
inteiro, as palavras do texto entram em sequência e o `stagger` encolhe (até 0.06 s) para a última terminar
dentro dela. A duração do preset é limitada à duração da legenda (`D`) e as âncoras são limitadas a `D − dur`.
O gerador passa o resultado pelo contrato: o que ainda não couber (mola curta demais para a legenda, saída sem
espaço depois da última entrada) falha na geração com o diagnóstico, nunca vira legenda inválida.

**Legendas: layout (EDT-89).** A caixa `.caption` é centralizada por `left:0; right:0; margin-inline:auto;
width:fit-content` e cresce até `max-width: 84%` do quadro (`box-sizing: border-box`, padding incluído). Não usa
`left:50%` nem `transform`: uma caixa absoluta com `left:50%` encolhe até a largura que sobra a partir dali e
parava em 50% do quadro (540 px no 1080×1920), e o `transform` colidiria com o `data-enter` do próprio bloco. A
fonte padrão é `round(min(altura × 0,055, largura × 0,065))` (1920×1080 → 59 px, igual ao que sempre foi;
1080×1920 → 70 px em vez de 106); `fontSize` explícito manda. `maxCharsPerLine` continua `largura × 0,84 ÷
(fonte × 0,55)`, agora coerente com a caixa que de fato chega a 84%.

**Legendas: destaque da palavra (EDT-95, EDT-99).** No karaokê, cada palavra é
`<span class="w" [data-unit="…"] style="animation-delay:<início>s,<fim>s">`, com o início e o fim do destaque no
tempo da própria sub-composição, em milissegundos inteiros escritos com três casas (`14.100s,14.440s`). O span não
leva `animation-duration`. No CSS gerado, `.w` é branca e roda `animation-name: hl-on, hl-off`, com
`animation-duration: 0s` e `animation-fill-mode: forwards`: `hl-on` pinta a cor de destaque no 1º atraso e `hl-off`
volta ao branco no 2º (a última da lista vence). Antes do início a palavra é branca; do fim em diante, também. Cada
palavra fica acesa até o início da seguinte (a última, até o fim da legenda), e o fim de uma é gravado com o
**mesmo texto** do início da seguinte: o navegador faz a mesma comparação para as duas, então no instante da troca
acende só a que começa, nunca duas nem nenhuma. Com duração no lugar do fim, o arredondamento no Chrome deixava a
palavra que termina acesa junto da nova em parte das trocas. `forwards` é obrigatório: sem ele a animação terminada
sai de `document.getAnimations()`, o relógio virtual deixa de movê-la e um seek para trás não reacende a palavra.
Arquivo já gerado guarda o próprio CSS: para receber esta correção, precisa ser gerado de novo com `captions`.

**Legendas: opções gravadas e edição do texto (EDT-97).** A composição gerada leva no `<head>` a
`<meta name="frankframes:captions" content='{JSON}'>`, com o JSON escapado como atributo. O JSON tem `v: 1` e as
opções de layout **já resolvidas**: `width`, `height`, `fontSize` (a fonte base), `maxChars`, `maxLines`, `bottom`,
`highlight`, `maxWords` e, quando há motion, `motion: {enter, exit?}` como o autor pediu. É o que permite desenhar
de novo uma legenda igual ao `captions`: gerador e edição usam a mesma função (`renderCue`).

- `readCaptionFile(html)` devolve `{options, cues: [{id, start, end, text, words}]}`, com tempos em segundos da
  própria sub-composição. `words` é `null` na legenda por frase; no karaokê, cada `.w` vira `{start, end, word}`
  (`start` e `end` = o 1º e o 2º `animation-delay`). Na legenda por frase `text` é o texto das linhas, juntadas por
  um espaço.
- `editCaptionText(html, id, text)` troca **só o elemento daquela legenda**, pela posição no arquivo: o resto
  continua byte a byte. `data-clip-id`, `data-start` e `data-duration` não mudam; a quebra de linha e o
  `font-size` são recalculados. O elemento é redesenhado por inteiro: atributo que alguém tenha acrescentado à
  mão nele não sobrevive.
  - **Mesmo número de palavras** (separadas por espaço): cada uma mantém o início, o fim e, com motion, o
    instante de onde sai o `data-unit` (o gravado: refazê-lo dos tempos arredondados erraria por 1 ms).
    Reaplicar o mesmo texto não muda o arquivo.
  - **Número diferente** (EDT-98): só o trecho trocado muda de tempo. As palavras iguais no começo e, no que
    sobra, as iguais no fim (comparadas pelo texto exato) mantêm o início, o fim e a âncora do `data-unit`. As palavras novas do trecho repartem o intervalo das antigas que elas substituem, do
    início da primeira ao fim da última, pelo número de caracteres de cada uma, em milissegundos inteiros
    encadeados (uma acaba onde a outra começa), cada uma com pelo menos 1 ms. O início da 1ª palavra da legenda,
    o fim da última e o encadeamento não mudam. Com duas mudanças separadas na mesma edição, tudo entre elas é
    repartido.
    - **Só inserção** (nenhuma palavra antiga trocada) ou **só remoção** (nenhuma nova no lugar): a palavra
      anterior ao ponto entra no trecho; sem anterior, a seguinte. A inserida divide o intervalo dela pelo tamanho
      das duas, e o intervalo das removidas passa para ela.
    - Trecho com menos milissegundos que palavras novas é `E_ATTRIBUTE_INVALID`.
  - **Por frase:** só o texto muda.
  - Texto vazio ou só com espaços é `E_ATTRIBUTE_INVALID`. O texto é sempre texto: `<`, `&` e aspas são escapados.
  - Com motion, `data-split`, `data-enter`, `data-exit` e os `data-unit` passam pelo mesmo ajuste da geração
    (a âncora gravada vale para o instante que não mudou; a palavra que passa a começar em outro instante parte do
    novo início); o que não couber é `E_ATTRIBUTE_INVALID`.
- Arquivo sem a meta (gerado por versão anterior), com a meta ilegível ou com legenda fora do formato gerado é
  `E_CAPTIONS_LEGACY` (`hint`: gere de novo com `frankframes captions`). Fora do formato inclui a palavra no
  formato antigo (um `animation-delay` mais `animation-duration`; os dois formatos não são lidos) e a de fim antes
  do início. `id` que não existe é `E_CAPTIONS_CUE_NOT_FOUND`.

**Limitações.** Em escritas cursivas (árabe) o modo `letter` perde a ligação entre letras, porque cada
grafema vira uma caixa; use `word`. Ligaduras entre unidades vizinhas e o kerning entre elas se perdem. O
resultado do `letter` depende da tabela Unicode do ICU: o teste de segmentação imprime a versão do Node e do
ICU quando falha.

### 7b.9 Câmera (`data-camera`)

`data-camera="<preset> [dur=] [at=] [curve=] [amount=] [fx=] [fy=]"` move o **enquadramento** de uma
imagem ou de um vídeo: zoom e deslocamento do foco, sem mexer na caixa do elemento. Só vale em `<img>` e
`<video>` (clip ou descendente); em outro elemento é `E_MOTION_TARGET`. A gramática e os erros de
parâmetro são os de §7b.4; o tempo é o da linha `camera` de §7b.5 (`at` padrão `0`).

**Ligação.** As propriedades animadas são `zoom` (`--ff-zoom`, ≥ 1) e o foco `focusX`/`focusY`
(`--ff-fx`/`--ff-fy`, em [0,1]). O alvo recebe, com `m = (100% − 100% / var(--ff-zoom))`:

```
object-view-box: inset(calc(var(--ff-fy) * m) calc((1 − var(--ff-fx)) * m)
                       calc((1 − var(--ff-fy)) * m) calc(var(--ff-fx) * m))
```

O recorte visível tem `1/zoom` da imagem em cada eixo; o foco diz **onde** a janela fica dentro da folga
`m`: `focusX = 0` encosta na borda esquerda, `1` na direita, `0.5` centra. **zoom ≥ 1**: nunca se vê
além da imagem, então não há borda vazia. O `object-fit` do elemento continua valendo sobre o recorte.

**Tempo.** Sem `dur=`, a câmera ocupa **do `at` até o fim do clip** (`D − at`, §7b.5): é movimento de
fundo, e o fim dele é o fim da imagem. `at` no fim do clip ou depois dele não deixa duração: dá
`E_MOTION_OUT_OF_RANGE` com o hint `sem dur, a câmera ocupa do at até o fim do clip`. Com `dur=`, vale o
que o autor escreveu (e a regra de faixa de §7b.5).

| Preset | Movimento | Curva | `amount` (padrão) | Outros |
|---|---|---|---|---|
| `aproximar` | zoom 1 → `amount` | `suave` | [1,4] (1.15) | `fx`, `fy` (0.5) |
| `afastar` | zoom `amount` → 1 | `suave` | [1,4] (1.15) | `fx`, `fy` (0.5) |
| `panoramica-esquerda` | `focusX` 0.75 → 0.25 com zoom fixo `amount` | `linear` | [1,4] (1.12) | `fy` (0.5) |
| `panoramica-direita` | `focusX` 0.25 → 0.75 com zoom fixo `amount` | `linear` | [1,4] (1.12) | `fy` (0.5) |
| `deriva` | zoom 1.06 → 1.10, `focusX` 0.45 → 0.55, `focusY` 0.48 → 0.52 | `linear` | n/d | n/d |

- `fx` e `fy` fora de [0,1] e `amount` fora de [1,4] dão `E_MOTION_PARAM`; panorâmica não tem `fx` (o foco
  horizontal é o próprio movimento) e `deriva` não tem parâmetros.
- Foco em 0.5 (o neutro registrado) não gera trilha: só sai trilha de `fx`/`fy` quando o valor é outro.
  Zoom e foco também podem ser animados à mão em `data-keyframes` (§7b.7); misturar os dois no mesmo alvo
  e no mesmo intervalo é `E_MOTION_OVERLAP`.
- `object-view-box` inline no alvo com câmera é `E_MOTION_CONFLICT` (§7b.6).
- Em `<video>`, a câmera anima a `<img>` que o substitui (§6) e **não** decodifica nada no Chrome: o recorte
  é aplicado ao frame já extraído. A mesma `<img>` também recebe entrada, saída e ênfase do vídeo.

### 7b.10 Transições (`data-transition`)

Uma transição liga **dois clips adjacentes** do mesmo escopo: A sai, B entra, e os dois se sobrepõem por `d`
segundos. É o único movimento que escreve trilhas em dois elementos.

```html
<div data-clip-id="a" data-start="0" data-duration="4">…</div>
<div data-clip-id="b" data-start="a - 0.5" data-duration="4" data-transition="empurrar dir=left">…</div>
```

**Representação.** O clip que entra (B) carrega `data-transition="<preset> [chave=valor ...]"` e o
`data-start="<id de A> - <d>"` de §3. Não existe `dur`: a duração da transição **é** a sobreposição `d`, e é
`data-start` quem a decide (o 0.5 s da tabela abaixo é só a sobreposição sugerida nos exemplos). `dur`
dá `E_MOTION_PARAM` com o hint `a duração da transição é a sobreposição em data-start`; `at` e qualquer outra
chave que o preset não tem dão `E_MOTION_PARAM` listando o que ele aceita (`curve` e as chaves da tabela). A
gramática e `curve` são as de §7b.4; as curvas, as de §7b.11.

**Validação** (`E_TRANSITION_PARTNER`, com `clipId` de B e hint `use data-start="<id-anterior> - 0.5"`):

- o `data-start` de B não é uma referência com deslocamento negativo (`"a - 0.5"`);
- A não é um clip **irmão** de B (mesmo escopo, §5) ou não vem **antes** de B no documento.

Dois outros erros valem como em §7b.5: `E_MOTION_OUT_OF_RANGE` quando `d` passa da duração do menor dos dois clips
(a transição precisa caber nos dois), e quando B não tem duração. Sem tempo resolvido (referência ou duração
pendente), a validação espera, como em §7b.5. `data-transition` em descendente, fora de um clip, ou junto de
`data-split` segue §7b.2 e §7b.8 (`E_MOTION_TARGET`).

**Intervalos.** `D_A` e `D_B` são as durações dos clips. A transição ocupa `[0, d]` em B e `[D_A − d, D_A]` em
A, que é o mesmo trecho da linha do tempo. A duração total da composição passa a contar a partir do início
de B: `d` segundos a menos do que dois clips em fila.

| Preset | B (entra) | A (sai) | Curva | Chaves (padrão) |
|---|---|---|---|---|
| `dissolver` | `opacity` 0 → 1 | nenhuma | `suave` | — |
| `cortina` | `clip-path` de `inset(...)` fechado do lado de `dir` até aberto | nenhuma | `vaivem` | `dir` (`right`) |
| `empurrar` | `x` (ou `y`) de ±100 % até 0, vindo do lado de `dir` | `x` (ou `y`) de 0 até ∓100 % | `vaivem` | `dir` (`left`) |
| `zoom` | `opacity` 0 → 1 e escala 1.2 → 1 | nenhuma | `freio` | — |
| `iris` | `clip-path` `circle(0% at fx% fy%)` até o círculo que cobre o quadro (75 % com `fx`=`fy`=0.5, senão 150 %) | nenhuma | `arranque` | `fx`, `fy` ([0,1], 0.5) |

- `dir` é `left`, `right`, `up` ou `down`; em `empurrar`, `up` e `down` usam `y`. `empurrar` com `dir=left`
  traz B da direita para a esquerda e A sai pela esquerda.
- **Empilhamento.** B está acima de A pela ordem do documento (§7b.1): `dissolver`, `cortina`, `zoom` e `iris`
  só animam B e A fica parado por baixo, visível até o último frame da sobreposição.
- **Posse.** A recebe trilhas só em `empurrar`. As propriedades de A são possuídas como em §7b.6:
  `translate` inline em A dá `E_MOTION_CONFLICT`, e uma trilha de `x`/`y` de A (por exemplo a `data-exit`
  `partir-esquerda`) que se sobreponha a `[D_A − d, D_A]` dá `E_MOTION_OVERLAP`; terminar a saída antes de
  `D_A − d` não conflita. A parte de A é um
  **alvo sintético** (`MotionTarget.own`): é o próprio clip, mesmo sem nenhum atributo de motion, e não entra na
  lista de elementos com motion.
- **Mola.** A curva `curve=mola` assenta por trecho como em §7b.11; vale também para a trilha de A, e o
  mínimo vale para `d` (hint: `aumente a sobreposição em data-start`).
- **Camada.** Os alvos de uma transição (A e B) recebem `will-change: transform, opacity` pelo `s` de §7b.12
  (`MotionTarget.layer`). A emenda entre os dois clips tem bordas fracionárias, e sem camada própria desde o
  primeiro frame o raster dela dependeria do frame visto antes, quebrando "seek em qualquer ordem dá o mesmo
  frame". Efeito colateral: o elemento cria um *stacking context* (`z-index` de descendentes fica confinado a ele).

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
  - `s` traz as declarações de ligação, por exemplo `["translate","var(--ff-x) var(--ff-y)"]`; nos alvos de
  uma transição (§7b.10) vem também `["will-change","transform, opacity"]`;
  - valores dos pontos: `x`/`y` viram `"<n>px"` (ou ficam em `%`), `rotate` vira `"<n>deg"`, `blur` vira
    `"<n>px"`, `scale*` são números, e `clip` vai direto em `clip-path`, normalizado (`inset(0% 10% 0% 0%)`:
    sempre `%`, 4 valores; `circle(50% at 50% 50%)`);
  - trilha constante (ponto único) sai com duas chaves iguais e `n` = 1;
  - com `data-split` (§7b.8) o `data-ff-motion` vai em cada `<span data-ff-unit>`, com o atraso `d` da
    unidade; o elemento só recebe o seu se tiver `data-keyframes`. O runtime não sabe de unidades: cada
    `[data-ff-motion]` é uma animação como qualquer outra.
- O runtime (engine):
  - registra as propriedades `--ff-*` (`inherits:false`);
  - aplica `s` no `style` do alvo;
  - cria `el.animate(k, {delay:d, duration:n, fill:"both", easing:"linear", id:"ff-motion"})`;
  - deixa o relógio sincronizar como qualquer animação (`currentTime = agora − data-ff-comp-start`).
- Conflito de posse detectado no runtime sai como `E_MOTION_CONFLICT: ...` na prontidão do relógio e o render
  falha com `E_MOTION_RUNTIME` (etapa `capture`).
- Seek em qualquer ordem dá o mesmo frame.
- `<video>` com motion: as animações vão para a `<img>` que substitui o vídeo (§6); o vídeo continua
  decodificado pelo FFmpeg e nunca é animado. O shim de mídia copia `data-ff-motion` e `data-ff-comp-start`
  para a `<img>` e chama `window.__ffMotion.attach(img)` no primeiro seek (a troca é preguiçosa); o relógio
  então sincroniza essas animações como as demais. O runtime só aceita `video[data-ff-motion]` quando o shim
  vai trocá-lo; sem mídia fora de banda recusa com `E_MOTION_TARGET` (hint: renderizar pelo FrankFrames ou
  mover o motion para uma `<img>` ou um elemento que envolva o vídeo, §6).
- Composição sem atributos de motion compila exatamente como antes (§10).

## 8. Diagnósticos

Todo diagnóstico tem `code` estável, `severity` e `message`; os erros têm `hint` acionável.
`severity: "error"` bloqueia; `"warning"` só informa. A lista canônica está em
`packages/contract/src/errors.ts`.

**Saída do render.** O render grava o arquivo em `<nome>.partial<ext>` ao lado do destino (o sufixo vem antes da
extensão, para o FFmpeg continuar inferindo o contêiner) e só o `rename` final lhe dá o nome definitivo; falha ou
cancelamento apagam o `.partial`, então um arquivo que já existia no destino nunca é corrompido nem
truncado. Se o `rename` falha porque o destino está aberto em outro programa (Windows: `EBUSY`/`EPERM`/`EACCES`),
o render falha com `E_INTERNAL` (`stage: "assemble"`) e uma mensagem que diz qual arquivo está em uso; nunca
termina "com sucesso" sem o arquivo. **Cancelamento:** `RenderOptions.signal` (um `AbortSignal`) mata o FFmpeg em
andamento, derruba os workers de captura (as sessões do Chrome fecham), apaga temporários e `.partial` e rejeita com
`E_CANCELED` no estágio em que estava; qualquer falha depois do abort vira `E_CANCELED`. `E_CANCELED` é código de
render e não é repetido.

**Limpeza nunca é engolida (EDT-83).** Temporários (`ff-render-*`, o workspace `ff-audio-*` do mix) saem em `finally`, sem
`force`. Se o render ou o mix já terminou e a remoção falha (Windows: `EBUSY`), o resultado vale e o aviso
`não consegui remover <caminho>: <motivo>` entra em `warnings`; se o corpo já tinha falhado, o aviso vai para o
stderr com o prefixo `[frankframes]` e o erro original sobe intacto. `--keep` guarda a pasta de trabalho também
depois que o processo sai.

**Captura e encode andam juntos (EDT-62, H2+H3).** Os frames não vão para o disco: cada worker de captura entrega o
PNG a um reordenador de buffer limitado (`orderedFeeder`, janela de `max(2, workers)` lotes de 8 frames, com
backpressure) e ele empurra os frames **em ordem** para a entrada do FFmpeg (`-f image2pipe -c:v png -i -`) enquanto
a captura continua. Os frames decodificados são os mesmos da sequência em disco (mesmos PNG, mesma ordem, mesmos
argumentos de saída; coberto por teste com `framemd5`). O disco só guarda o vídeo parcial e o áudio; `--keep` (`keepWorkDir`) também grava os PNG em
`<pasta de trabalho>/frames/frame_%06d.png` para inspeção. Consequências do contrato:
- Estágios: `capture` 25→75 cobre a captura **com** o encode em andamento; o áudio (78) roda enquanto o FFmpeg
  termina de fechar o vídeo; `encode` 80→90 é só essa cauda (esperar o FFmpeg depois do último frame); `assemble`
  segue depois. Em `onProgress`, `capture 75` significa "todos os frames entregues", não "vídeo pronto".
- **Falha alta nos dois sentidos.** Erro no pipe (`EPIPE`) ou FFmpeg que morre derruba a captura na hora (os workers
  presos no backpressure são liberados) com a stderr do FFmpeg na mensagem: `E_ENCODE`, `stage: "encode"`, hint para conferir o FFmpeg com
  `frankframes doctor` e o espaço livre em disco. Falha da
  captura mata o FFmpeg. Cancelamento encerra os dois e não deixa `.partial`. Um frame que nunca chega faz o encode
  falhar em vez de fechar um vídeo curto.
- **Repetição (EDT-72).** A repetição única de falha transiente do browser reinicia o pipe do zero: FFmpeg novo,
  nenhum frame duplicado. Falha do encode nunca é repetida nem classificada por texto como falha de browser.

**Workers de captura pela memória livre (EDT-91).** Sem `--workers` (`workers`), o render usa
`max(1, min(8, porCpu, porMemória))`, com `porCpu = max(1, floor(CPUs / 2))` e
`porMemória = floor((memória livre − 1 GiB) / 768 MiB)`: 768 MiB por browser e 1 GiB de fora para o FFmpeg e o encode.
Conta a memória **livre**, não a total, porque os outros programas da máquina já ocupam parte dela; a medida é tirada
uma vez, no começo do render, e não muda com ele andando (nem na repetição da captura).
- A escolha vai na `message` do `onProgress` com que o estágio `capture` começa (no CLI sem `--json`, a linha
  `[capture]` do stderr): `N worker(s) de captura, limite de cpu|memória (C CPUs, M MB livres)`. `limite de memória`
  quer dizer que mais memória livre daria mais workers; no empate o limite dito é o da CPU.
- Se a memória livre não comporta nem 1 worker mais a reserva (menos de 1792 MiB), o render **segue com 1 worker**, sem
  falhar, com o aviso em `warnings` (e no `render --json`):
  `memória livre baixa (N MB): render com 1 worker; feche programas se o seek estourar o prazo`.
- `--workers` explícito vale como está: nada é medido, sem aviso e sem a linha da escolha. Isso inclui o lote com
  concorrência maior que 1, que passa a cada job um número já calculado ([batch.md](batch.md#concorrência)).

**Áudio de entrega: o true peak vale para o arquivo codificado (EDT-90).** O mix de entrega é normalizado em
−14 LUFS com teto de −1 dBTP (`loudnorm`), mas o AAC (MP4) e o Opus (WebM) sobem os picos entre amostras, então o
teto do PCM não garante o do arquivo. Por isso o `mixAudio` mede o **próprio arquivo codificado** (`loudnorm` em modo
análise, a mesma medida do aceite) e a garantia é `true peak ≤ −1 dBTP` nesse arquivo, não no PCM:
- Passou de −1 dBTP: calcula `ganho = −1 − medido − 0,2 dB` (a margem de 0,2 dB é fixa; cobre a variação do
  re-encode), recodifica **uma única vez** a partir do mesmo grafo com `volume=<ganho>dB` depois do `loudnorm` e mede de
  novo. Sem laço e sem segunda correção. O render avisa em `warnings`:
  `true peak do arquivo codificado X dBTP acima do limite −1 dBTP; ganho de G dB aplicado e áudio recodificado (agora Y dBTP, Z LUFS)`.
- Ainda acima de −1 dBTP depois da correção, ou medição ausente/ilegível: falha com **`E_AUDIO_TRUE_PEAK`**
  (`stage: "audio"`), com a medida na mensagem e o hint (baixar `data-volume`, reduzir o pico de origem ou usar
  `--no-loudness`). Nunca entrega arquivo acima do limite em silêncio.
- WebM: o mix já sai em Opus 128 kb/s (`audio.opus`) e o mux copia o stream (`-c:a copy`); não há mais AAC → Opus em
  duas gerações, e a medida vale para o que vai ao arquivo. MP4: AAC 192 kb/s, copiado no mux.
- Não mudam: mix silencioso (`áudio silencioso: loudnorm não aplicado`, sem medida de pico), `--no-loudness`
  (`loudness: false`, mix cru sem garantia) e o WAV do preview (PCM, sem codec com perdas). O loudness integrado
  segue alvo −14 LUFS; a correção tira no máximo o excesso de pico (o `Z LUFS` do aviso mostra o valor final).

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
   As animações **CSS** são pausadas ainda antes: o relógio injeta `<style data-ff-freeze>` com
   `*,*::before,*::after{animation-play-state:paused!important}` como primeira coisa do `<head>`, então elas nascem
   pausadas e nenhum frame real as roda antes de `DOMContentLoaded` (script, fonte ou recurso lento, máquina
   carregada). Congelar só na prontidão deixava essa janela: um frame do Chrome antes dela começava a animação no
   compositor e o raster do meio da animação mudava para o resto da sessão, mesmo com `pause()` e `currentTime = 0`
   depois (EDT-72; reproduzido sem carga atrasando `DOMContentLoaded` em 100 ms). O relógio continua sendo quem move
   as animações, por `currentTime`. Animação WAAPI criada por script do autor antes da prontidão ainda não é coberta
   por essa regra.
6. **Uma captura por frame, depois do paint.** A primeira captura de cada sessão é descartada; depois
   de cada seek, `__ff.settle` espera dois frames de compositor e um `setTimeout` (que cai **depois** do
   paint) antes do screenshot. A captura usa essa espera do seek, em software e em hardware: **uma espera de paint
   por frame** (EDT-62/H1); não existe espera a mais dentro da captura. Com `--disable-gpu-compositing` uma leitura
   já é estável: em software, medido em 3 comparações dos 24 blocos e 2 renders de vídeo real; em hardware, ver o
   item de hardware da lista abaixo (EDT-77).
   O screenshot é PNG pedido com `optimizeForSpeed: true` (EDT-62/H4): o Chrome usa compressão mais barata,
   os **pixels decodificados são idênticos** aos do PNG padrão (conferido nos 240 frames dos goldens, diferença
   zero em todos os canais), mas os bytes são outros e o arquivo fica ~2× maior. O hash por frame é o SHA-256 do
   PNG e, por isso, depende deste parâmetro: mudá-lo exige regenerar `catalog/goldens.json`.
   Existe um modo conservador por variável de ambiente: `FRANKFRAMES_CAPTURE_SHOTS=3` exige três
   screenshots consecutivos idênticos (para hardware ou máquina sob carga).
   - em software, `--disable-gpu-compositing`: o compositor SwiftShader re-apresenta raster parcial em
     camadas com `clip-path`/`transform`;
   - em hardware, `--disable-gpu-compositing` também (EDT-77), em Windows, macOS e Linux. Com vários workers, o
     compositor de GPU não reproduzia o hash na mesma máquina: 110 de 240 frames instáveis com 6 workers, 0 com 1
     worker, e esperar mais (1 a 3 esperas extras, ou 100 ms de atraso fixo) não resolvia (103 a 152 instáveis).
     Com a flag, 0 de 240 em 5 rodadas intercaladas, inclusive com a CPU em 61–78%. O ANGLE segue no driver real
     (WebGL e canvas na GPU); só o compositor vira software, como em `software`. Custo medido: ~5% de fps com a
     segunda espera mantida (47,8 → 45,7 fps); sem a segunda espera a captura em hardware fica mais rápida que
     antes (~55 fps contra ~46). A promessa do item é a mesma: hardware é igual **nesta máquina**, não entre máquinas;
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
   Classificação (`classifyFailure`): `E_FONT_LOAD` é erro de **autoria** e não se repete, exceto num caso de infraestrutura:
   toda face reprovada falhou só com `A network error occurred` **e** o servidor local não registrou falha nenhuma
   (nenhum `[servidor: …]` na mensagem). O arquivo está certo e a requisição não chegou ou foi derrubada no caminho
   (conexão de loopback cortada sob carga, antivírus, sincronizador de pasta); isso é `transient` e o render repete a
   captura **uma vez**, avisando a causa pelo progresso (`repetindo a captura uma vez (E_FONT_LOAD): …`). A segunda
   falha sobe como `E_FONT_LOAD`. `@font-face` do autor para arquivo que não existe, arquivo que não decodifica e
   qualquer falha com registro do servidor continuam sem repetição.
9. **Captura nunca espera para sempre.** O servidor local e a sessão do browser falham alto, com código e `hint`:
   - **Servidor de assets.** Caminho que não existe (`ENOENT`, `ENOTDIR`, `EISDIR`) responde `404`; quando o arquivo
     é de fonte (`.woff2`, `.woff`, `.ttf`, `.otf`) o `404` também entra no registro de falhas (sem retry), para a
     mensagem de `E_FONT_LOAD` distinguir fonte que não existe de conexão derrubada. Qualquer outro
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
   - **Onde o seek e a captura pararam.** No estouro do seek ou da captura, a mensagem continua depois de
     `… passou de 60 s sem responder` com: o frame e o instante do último seek pedido, a etapa em que parou, há
     quanto tempo está nela e o que estava pendente (`…; frame 41 (t=1,367 s), parou na etapa "img.decode() de
     frame de vídeo" há 59,9 s; <img> pendentes: __ff_media/clip/000041.jpg (carregando)`); a captura leva o
     número do frame também no nome da operação (`a captura do frame 41`). Etapas: `envio do pedido (a página não
     começou a executá-lo)`, `entrada do __ff.seek`, `timers e requestAnimationFrame da composição`,
     `syncAnimations`, `visibilidade e ganchos de seek`, `img.decode() de frame de vídeo`,
     `settle (requestAnimationFrame)` e `screenshot`. A página anuncia cada etapa antes de entrar nela, por um
     binding do CDP, então o nome sai mesmo com a thread presa. Vencido o prazo, uma sonda de no máximo 2 s lista
     as `<img>` sem resposta (carregamento ou `decode()`) e as famílias com carregamento em andamento (`fontes
     carregando: …`; o seek não espera fonte, quem espera é a prontidão). Se a sonda não volta, a mensagem diz
     `a página não respondeu à sonda em 2 s` e, quando a etapa pediu imagens, `<img> pedidas nessa etapa: …`; se
     ela falha, diz por quê. Cada lista mostra até 5 itens e conta o resto. O nome do recurso sai sem esquema,
     usuário, query nem fragmento (do próprio servidor, o caminho sem a barra inicial; de fora, host e caminho),
     e `data:` e `blob:` saem como `data:…` e `blob:…`.
   - **Quem abre fecha.** Se a abertura da sessão rejeita, o Chrome e o servidor local são fechados antes de
     a rejeição chegar ao chamador (`openSessionFor`); fechar o servidor duas vezes é permitido. Num render
     paralelo, a falha de um worker fecha os outros antes de a rejeição sair: a sessão aberta é fechada, e a que
     ainda está abrindo, assim que abrir, sem capturar frame. A rejeição espera essas aberturas e fechamentos,
     que têm prazo, mas não um worker parado na entrega de um frame. Se um fechamento também falha, o erro
     continua sendo o da falha (mesma classe, código e mensagem) e o do fechamento vai como causa dele; Chrome
     cujo fechamento rejeita é morto. Captura completa em que um fechamento falha também rejeita, dizendo por quê.
   Os dois códigos são códigos de render (`stage: "capture"`), como `E_FONT_LOAD`.

**GPU:** o padrão é `auto` — hardware quando existe, SwiftShader como fallback. Em `software` a promessa é
igualdade de hash por frame **para o mesmo SO, a mesma arquitetura e o mesmo browser pinado** (a versão do Chrome
headless shell que `doctor` e `setup` conferem por SHA-256); em `hardware` a promessa é "igual nesta máquina"
(o pixel depende do driver). **Entre sistemas operacionais não se promete igualdade**: o mesmo bloco renderizado no
Windows e no Linux sai com pixels diferentes (medição abaixo).

**Plataformas:** o produto tem pin (Chrome headless shell e FFmpeg LGPL, cada um por SHA-256) para
`win32/x64` (`win64`) e `linux/x64` (`linux64`). Qualquer outra combinação de SO e arquitetura falha alto, antes
de baixar ou lançar qualquer coisa: `E_BROWSER_PLATFORM_UNSUPPORTED` (navegador) e `E_FFMPEG_PLATFORM_UNSUPPORTED`
(FFmpeg), com `hint`; o `doctor` e o `setup` reportam o código no passo que falhou. `setup`, `doctor`,
`browser install` e `render` rodam em Linux x64 (medido em contêiner Docker `node:24-bookworm`, WSL2).

**Goldens por plataforma:** o catálogo guarda um conjunto por plataforma, `catalog/goldens/<win64|linux64>/`
(`goldens.json` e os PNGs). A conferência usa o conjunto da plataforma em que roda e nunca o de outra. Plataforma
sem conjunto gerado falha alto com `E_GOLDENS_PLATFORM_MISSING` e `hint` — não há skip silencioso. Os dois conjuntos
estão gerados. O `linux64` só foi gerado depois de a auto-prova do Linux fechar 240/240 em 3 execuções sob carga
(`docs/determinismo-plataformas.md`).

**`software` reproduz o hash sob carga (EDT-13):** o mesmo bloco, na mesma máquina, dá o mesmo hash por frame mesmo com
sessões em paralelo e CPUs saturadas. O defeito que quebrava isso (o raster do texto de `subtitles` caía em outra fase de
subpixel em ~1/3 das sessões sob carga e ficava assim a sessão toda) é corrigido em `startSession`: depois do `ready`, o
`body` sai do layout e volta com paint real entre os dois, e o compositor recria as camadas do mesmo estado. Teste:
`packages/producer/test/subtitles-load.test.ts`.

**Medido entre plataformas (EDT-13):** em `software`, os goldens gerados no Windows **não** são reproduzidos no
Linux x64 (mesma CPU): 0 de 240 frames com o mesmo hash, 18 só por PSNR ≥ 50 dB e 222 abaixo de 50 dB (PSNR mín.
34,6 dB, mediana 42,6 dB, máx. 66,8 dB). Números, método e limites em `docs/determinismo-plataformas.md`.

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
SSE; o instante atual e o estado de transporte (tocando ou parado) são guardados em `sessionStorage` por
composição (`__ffTime:<id>`, nunca acima do último frame, e `__ffPlaying:<id>`) e retomados após a
recarga: parado volta parado no mesmo instante, tocando volta tocando dali. Instante acima do novo fim
(composição encurtada) vira o último frame; um valor salvo inválido ou `sessionStorage` bloqueado aparece
em `__ff.liveErrors`, nunca vira 0 em silêncio. Na recarga o instante salvo vale mais que o `#f=` da URL
(que só reflete o último scrub da barra); numa abertura nova (sem recarga) o `#f=` manda.
`__ff.transportHooks` recebe `start`, `stop`, `seek`, `end` e `loop`. Sem `__ff.setLiveBounds`
o relógio ao vivo é ilimitado; a barra de controle sempre o chama.

**Scrub da barra** (EDT-85). O clique ou arraste na barra mapeia a posição do ponteiro sobre a largura inteira da
barra, e não sobre a trilha encurtada pela metade do polegar do controle nativo: há uma zona de borda de
`max(12 px, 1% da largura)` em cada ponta, e o ponteiro dentro da zona esquerda dá sempre o **frame 0** e dentro da
direita sempre o **último frame** (`frames − 1`); entre as zonas o mapa é linear e arredondado ao frame mais
próximo. Teclado (setas, Home, End) segue o controle nativo. A conta é pura (`frameFromPointer`, em
`packages/engine/src/preview-logic.ts`) e é a mesma que roda na página.

**Estado inicial.** O `preview` abre **tocando** do 0 (ou do instante salvo, acima). O Studio injeta o preview com
`autoplay: false`: a abertura (navegação nova do iframe) fica **pausada no frame 0**, sem avançar sozinha, e o
playhead só anda depois de um Play. Recarga pelo próprio Studio (`location.reload()` depois de uma edição) continua
restaurando instante e estado de play como descrito acima; só a abertura é pausada.

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

- **Bloco do catálogo** (`POST /api/blocks`, corpo `{slug, start}`; EDT-88). Clicar num bloco do painel "Blocos"
  insere o bloco, não um texto. O Studio copia a pasta do bloco para `blocks/<slug>/` ao lado da entrada com a mesma
  rotina do `frankframes blocks add <slug>` (`installBlock` em `@frankframes/catalog`) e insere no fim da raiz um host
  de sub-composição (§5) `data-composition-src="blocks/<slug>/index.html"` com `data-start` no playhead,
  `data-duration` do próprio bloco e faixa acima de todas as visuais; o preview e o export mostram o bloco. Resposta
  `200 {ok, id, slug, src, duration, reused, history}`. Slug fora do catálogo é `404 E_BLOCK_UNKNOWN` (com `hint`
  para `frankframes blocks list`); o `blocks add` local falha com o mesmo código. A árvore inteira é validada antes de
  gravar (`compileComposition`): id de clip do bloco que já existe na composição, por exemplo inserir **o mesmo bloco
  duas vezes** ou um bloco cujo id colide com o de um clip seu, é `400 E_CONTRACT_INVALID` com `E_DUPLICATE_ID`, e a
  composição não muda. Desfazer remove o clip; **os arquivos copiados ficam em `blocks/<slug>/`** (como o arquivo
  importado em `assets/`), e inserir de novo reaproveita a cópia sem sobrescrever edição sua (`reused: true`).
- **Texto** (`POST /api/clips {template:"text", start}`; botão "Inserir texto"). É o único template: cria um
  `<div>` com o texto "Texto" no playhead, e o botão diz isso. Qualquer outro `template` (inclusive o antigo
  `title`/`subtitle`) é `400 E_TEMPLATE_INVALID` com `hint`; nada vira texto genérico em silêncio.
- **Importar `.html`** (o mesmo "Importar", `POST /api/media?name=x.html&start=`). `.html`/`.htm` local entra como
  sub-composição (§5) em vez de mídia: o arquivo vai para `compositions/` (mesma regra de nome seguro e de não
  sobrescrever de `assets/`), o host recebe `data-start` no playhead e a `data-duration` **derivada da raiz do
  arquivo** (`legendas.html` de `frankframes captions` traz a sua). Arquivo que não é uma composição válida
  (`E_NO_ROOT` etc.), sem duração na raiz (`E_DURATION_UNRESOLVED`) ou cujo id colide com a composição é
  `400 E_CONTRACT_INVALID` com os diagnósticos do contrato, é apagado se foi criado agora e nada muda no projeto.
- **Importar mídia** (`POST /api/media?name=&start=`, arquivo cru no corpo). Vídeo (`.mp4 .m4v .mov .webm
  .mkv`), áudio (`.mp3 .wav .m4a .aac .ogg .opus .flac`) ou imagem (`.png .jpg .jpeg .webp .gif .svg`) é
  copiado para `assets/` ao lado da entrada com nome seguro (sem acento, espaço ou caminho). Conteúdo
  idêntico a um arquivo existente reaproveita o arquivo; nome igual com conteúdo diferente ganha sufixo
  `-<sha256[0:8]>` — nada é sobrescrito. O clip entra no fim da raiz com `data-start` no playhead e
  `data-duration` medida pelo ffprobe (imagem: 3 s), **gravada com a precisão do probe**, sem arredondar (nem para
  cima): um vídeo de 68,164583 s vira `data-duration="68.164583"`; vários arquivos de uma vez entram em sequência com o
  `data-start` também exato. Vídeo responde também com `orientation` (rotação e
  dimensões de exibição, §6) e rotação que o render não honraria igual (`E_MEDIA_ROTATION`) é recusada e o
  arquivo apagado. Arquivo ilegível falha com `E_MEDIA_PROBE` e é
  apagado; extensão fora da lista é `E_MEDIA_UNSUPPORTED`; teto de 4 GiB (`E_MEDIA_TOO_LARGE`).
- **Inspetor de clip grava só o que o usuário mudou** (EDT-85). "Aplicar" compara cada campo com o **texto que o
  inspetor mostrou** (o valor arredondado para exibir) e só envia os atributos cujo texto o usuário editou; os demais
  atributos ficam como estão no HTML, byte a byte (`data-duration="68.164583"` não vira `68.165` ao trocar
  `data-start`). Um valor derivado da fonte nunca é arredondado para cima por causa de outro campo. O inspetor de
  Composição segue a mesma regra (`compositionPatch` só envia o que difere do que mostrou).
- **Player segue a raiz** (EDT-87). O iframe do preview tem o viewport de `data-width` × `data-height` da raiz
  (`GET /api/composition` → `width`/`height`; padrão 1920×1080 se faltar, como no render) e é escalado por **uma**
  razão, `min(largura livre / largura, altura livre / altura)`, centrado no painel: nada é cortado nem esticado, em
  16:9 ou 9:16. Editar largura/altura pelo inspetor de Composição muda o player na hora (`player-fit.js`, lógica pura).
- **Dividir** (`POST /api/clips/<id>/split {at}`). Só para clip de topo com `data-clip-id` explícito, sem
  `data-keyframes`, atributos de motion (§7b) nem filhos (`E_SPLIT_UNSUPPORTED`), e com `at` a mais de 1 ms das bordas
  (`E_SPLIT_OUT_OF_RANGE`). A primeira metade fica com `data-duration = at − início` e perde o
  `data-fade-out`; a cópia entra logo depois com `data-start="<id>"` (começa onde a primeira termina),
  o resto da duração, sem `data-fade-in` e, em vídeo/áudio, `data-offset` avançado em
  `(at − início) × data-playback-rate`. Clips que referenciavam o fim do original passam a referenciar a
  cópia, então nada mais na timeline se move.
- **Desfazer/refazer** (`POST /api/undo`, `POST /api/redo`, `GET /api/history`). O histórico guarda até
  200 versões completas de arquivo, só em memória, e some quando o Studio fecha. Cada passo guarda **qual arquivo**
  mudou (a entrada ou o arquivo de uma legenda, EDT-97), e desfazer/refazer restauram aquele arquivo. Se ele mudou
  fora do Studio, desfazer/refazer recusa com `409 E_HISTORY_STALE` e descarta o histórico em vez de
  sobrescrever a mudança (a conferência é por arquivo). Desfazer uma importação remove o clip, não o arquivo em `assets/`.
- **Legendas** (EDT-97). Em `GET /api/composition`, o host cuja `data-composition-src` aponta para um arquivo com a
  meta `frankframes:captions` (§7b.8) vem com `captions: true`. Vale para clip de topo: `<hostId>` é o id de um clip
  de topo do arquivo da entrada.
  - `GET /api/captions/<hostId>` → `{src, cues}` (as de `readCaptionFile`). Os tempos são os da sub-composição: na
    timeline da entrada, somam o início do host.
  - `POST /api/captions/<hostId>/<cueId>` com `{text}` grava o arquivo da legenda com `editCaptionText`. Antes de
    gravar, a árvore inteira é validada com o conteúdo novo (`compileComposition`): na falha responde
    `400 E_CONTRACT_INVALID` com os diagnósticos e o arquivo fica intacto. Sucesso devolve
    `{ok, id, changed, duration, diagnostics, history}` e entra no histórico como `editar legenda <cueId>`; texto
    que não muda o arquivo devolve `changed: false`, sem passo no histórico.
  - Erros, todos com `hint`: `404 E_CLIP_NOT_FOUND` (host inexistente), `400 E_CAPTIONS_HOST` (o clip não é um host
    de legendas utilizável: não tem `data-composition-src`, o caminho é URL, tem `..` ou segmento oculto, sai da
    pasta da entrada ou o arquivo não existe), `400 E_CAPTIONS_LEGACY`, `404 E_CAPTIONS_CUE_NOT_FOUND`,
    `400 E_ATTRIBUTE_INVALID` (texto vazio ou que não cabe) e `400 E_BODY_INVALID` (`text` ausente ou não é texto).
  - O observador de arquivos só olha o arquivo da entrada: gravar uma legenda (ou desfazer essa gravação) recarrega
    o preview por conta própria. Mudança feita **fora** do Studio num arquivo de sub-composição não recarrega o
    preview sozinha.
  - **Na tela:** com um host de legendas selecionado, o inspetor mostra a seção "Legendas", uma linha por legenda
    com início–fim (tempo da timeline da entrada) e o texto. A linha sob o playhead fica marcada e acompanha o
    tempo; tocar no tempo leva o playhead ao primeiro frame daquela legenda e pausa. Enter ou "Aplicar" envia a
    linha; erro aparece na própria linha com código e `hint`. Texto digitado e ainda não aplicado sobrevive à
    recarga da composição e mantém o Exportar desabilitado; selecionar outro clip descarta esse texto.
- **Inspetor de Composição** (`POST /api/composition`, corpo `{duration?, width?, height?, fps?}`; EDT-84). Edita a
  raiz: `duration` (segundos, `> 0`; **`null` remove `data-duration`**, a duração passa a ser derivada dos clips, §7),
  `width` e `height` (inteiros `> 0`) e `fps` (`"30"`, `"30000/1001"` ou número). Campo ausente não é tocado; corpo sem
  nenhum campo é `E_ATTRIBUTE_INVALID`. A escrita muda só os atributos da raiz (`editComposition`, mesma
  edição por posição das demais: formatação e comentários ficam), o resultado passa pelo contrato antes de gravar
  (`E_CONTRACT_INVALID` com os diagnósticos, por exemplo `E_DURATION_INVALID`, `E_SIZE_INVALID`, `E_FPS_INVALID` ou
  `E_DURATION_UNRESOLVED` ao pedir "derivada" sem clips que a derivem; arquivo intacto) e entra no histórico (Ctrl+Z
  desfaz, inclusive a remoção de `data-duration`). `GET /api/composition` traz, além do que já trazia, `width`,
  `height`, `durationKind` (`authored`, `derived` ou `unresolved`) e `contentEnd` (o maior fim entre os clips de
  topo, o que "derivada" daria) e, em `diagnostics`, o `code` e o `clipId` de cada diagnóstico. A tela mostra o
  formulário "Composição" quando nenhum clip está selecionado (e pelo botão "Composição" do topo); marcar
  "derivada dos clips" envia `duration: null`. Depois de gravar, o arquivo muda, o Studio recarrega o preview pelo
  `/api/events` e o preview e o playhead passam a cobrir a duração nova.
- **Fim da composição visível.** Quando há `W_CLIP_PAST_END` (§7), a barra da timeline mostra a faixa "a composição
  termina em X (data-duration fixo) e o clip "id" passa do fim", com o botão que abre o inspetor de Composição, e o
  indicador de duração do topo diz `fixa (data-duration)` ou `derivada dos clips`: o playhead parar no fim autoral
  nunca é silencioso. O Studio não estende o preview além do fim autoral; para isso se edita a composição.
- **Abertura pausada** (EDT-85). O Studio abre com o preview **parado no frame 0**, com o botão no estado "play" e o
  playhead em 0; nada avança até o primeiro Play ou clique na barra do preview (§9c, "Estado inicial").
- **Playhead.** Vai de 0 ao início do último frame, `(frames − 1) / fps`, nunca ao fim da composição. A
  barra do preview no Studio não abre `/__ff_reload`: o Studio recarrega pelo próprio `/api/events`. Depois
  de qualquer edição que recarrega o preview (cortar, colar, duplicar, apagar, aparar, mover keyframe) o
  playhead fica no mesmo instante e no mesmo estado de play; quem guarda e restaura é o preview, o Studio
  só recarrega. Erro do relógio do preview (`__ff.liveErrors`) ou preview inacessível aparece no indicador
  de conexão do Studio.
- **Caminhos relativos** do preview resolvem contra o diretório da entrada via `<base href="/__ff_site/">`.
  Nenhum caminho com segmento começando por `.` (`.env`, `.git`) é servido.

- **Composição** (`GET /api/composition`). Devolve, por clip, `track`, `kind` (`video`, `text` ou `audio`),
  `editable` e os campos de mídia (`hasAudio`, `mediaSrc`, `fadeIn`, `fadeOut`, `hasKeyframes`,
  `hasChildren`, `parentId`). Ferramentas de edição só operam em clip `editable`: de topo e com
  `data-clip-id` explícito no arquivo.

- **Movimento** (§7b). `GET /api/composition` traz, por clip, `motion` com só as chaves presentes no HTML
  (`enter`, `exit`, `emphasis`, `camera`, `transition`), cada uma como `{raw, preset, params}` (`preset` é
  `null` quando o texto não é válido), mais `split` quando há `data-split`. Os keyframes saem em `keyframes`
  no próprio clip (lista unificada, ver "Keyframes" abaixo). Fontes passivas (filhos que só herdam) não aparecem. `transition` ganha
  `dur` (a sobreposição: o deslocamento negativo de `data-start`, `null` se não for uma referência com
  deslocamento negativo) e `partner` (o id de A referenciado em `data-start`, ou `null`); ambos são só leitura
  e a escrita é `POST /api/clips/<id>/transition`.
- **Presets** (`GET /api/motion/presets`). Devolve `{enter, exit, emphasis, camera, transition}`, cada lista
  com `{name, label, dur, curve, keys}`; `keys` descreve os parâmetros aceitos (`type`, `default`, `min`,
  `max`, `values`, `doc`). `transition` não tem `dur` nem `at` (a duração é a sobreposição). A miniatura de
  cada preset sai em `GET /__ff_motion/<name>.gif`; nome fora da lista de presets (inclusive `../`) é 404.
- **Escolher um preset** não tem rota própria: o inspetor chama `POST /api/clips/<id>` com
  `{attributes: {"data-enter": "<texto>" | null}}` (idem `data-exit`, `data-emphasis`, `data-camera`). O texto
  passa pelo contrato antes de gravar (`E_MOTION_PRESET_UNKNOWN`, `E_CONTRACT_INVALID` com `hint`; arquivo
  intacto na falha), e a escolha entra no histórico, então Ctrl+Z desfaz. O cliente só escreve parâmetros que
  diferem do default do preset (`subir dur=0.8`); trocar de preset preserva `dur`, `at` e `curve` que o
  novo preset aceita e descarta o resto.
- **Transição entre clips adjacentes** (`POST /api/clips/<id>/transition`, corpo `{preset, dur, params?}`,
  `<id>` é o clip B que entra). `preset` é o nome de um preset de transição (`dissolver`, `cortina`, `empurrar`,
  `zoom`, `iris`) ou `null` para remover; `dur` (> 0, segundos) é a sobreposição e `params` os parâmetros do
  preset (`dir`...; sem `dur` nem `at`, §7b.10). A escrita é uma só e atômica sobre o clip B: `data-transition`
  recebe `<preset> [chave=valor ...]` e `data-start` recebe `<id de A> - <dur>`. A é o clip da raiz que termina
  exatamente onde B começa (tolerância de 1 µs) ou, se B já tem transição, o que o `data-start` de B
  referencia. Se A não tem `data-clip-id`, ele ganha um id explícito (`clip-N`) no mesmo patch, porque o id
  automático (`div#1`) não é referenciável. `preset: null` volta a `data-start="<id de A>"` (B adjacente a A, na
  duração original de A) e tira `data-transition`; sem transição para remover, nada muda e nada entra no
  histórico. Mudar só o `dur` só desloca B: o resto da timeline que referencia o fim de B anda junto, e clips
  com início absoluto não se movem. Falhas: B sem nenhum clip terminando onde ele começa (inclusive o
  primeiro clip, ou B dentro de sub-composição) é `E_TRANSITION_GAP`; `preset` que não é de transição, `dur` ≤ 0
  e parâmetros ilegíveis são `E_ATTRIBUTE_INVALID` (corpo sem `preset` string ou `null`: `E_BODY_INVALID`); o que o
  contrato recusa depois da escrita (sobreposição maior que A ou B, `dir` inválido) é `E_CONTRACT_INVALID` com os
  diagnósticos. Todas respondem 400 e deixam o arquivo intacto; o sucesso entra no histórico (Ctrl+Z desfaz).
  O inspetor mostra a seção "Transição" só quando B já tem transição ou há um clip da raiz encostado nele, e a
  timeline desenha uma faixa hachurada de largura `dur` no começo da barra de B; clicar nela seleciona B e leva
  à seção.

- **Keyframes** (`POST /api/clips/<id>/keyframes`, corpo `{op, time, ...}`). Edita o `data-keyframes` (§7b)
  do próprio clip, nunca o de filhos. `time` é local ao clip (0 = início do clip), em segundos, arredondado
  a milissegundos; dois pontos a menos de 0,0005 s são o mesmo ponto. Operações:
  - `add` `{time, prop, value?, curve?}`: cria o ponto (ou acrescenta a propriedade a um ponto que já existe
    naquele tempo). Sem `value`, o valor é o que a animação já produz naquele instante
    (`sampleTracks`; volume: interpolação linear dos pontos de volume, senão o `data-volume` do clip, senão 1;
    propriedade sem animação: o valor neutro, como `opacity` 1 e `x` 0). Propriedade já presente no tempo é
    `E_KEYFRAME_EXISTS`.
  - `move` `{time, to}`: leva o ponto inteiro (todas as propriedades) para `to`. `to` ocupado é
    `E_KEYFRAME_EXISTS`; `to` igual a `time` não muda nada.
  - `remove` `{time, prop?}`: sem `prop` apaga o ponto; com `prop` tira só essa propriedade (e a `curve`
    quando não sobra propriedade visual). Ponto vazio some; lista vazia remove o atributo.
  - `edit` `{time, prop?, value?, curve?}`: troca o `value` de `prop` e/ou a `curve` (`null` remove a curva).
    Precisa de `value` ou `curve`, senão `E_ATTRIBUTE_INVALID`.
  Falhas: ponto ou propriedade que não existe é `E_KEYFRAME_NOT_FOUND`; `prop` fora de
  `opacity x y scale scaleX scaleY rotate blur clip volume zoom focusX focusY` é `E_KEYFRAME_PROP`; `time`
  fora de `[0, duração]` é `E_KEYFRAME_OUT_OF_RANGE`; `data-keyframes` ilegível é `E_ATTRIBUTE_INVALID`; corpo
  malformado é `E_BODY_INVALID`; o que o contrato recusa depois da escrita (valor fora da faixa, curva
  desconhecida, sobreposição com `data-enter`/`data-exit`, `E_MOTION_OVERLAP`) é `E_CONTRACT_INVALID` com os
  diagnósticos. Todas respondem 400 e deixam o arquivo intacto; sucesso devolve `{ok, duration, diagnostics,
  history}` e entra no histórico com o rótulo `keyframe <id>` (Ctrl+Z desfaz, um passo por operação). Sem
  mudança de conteúdo, nada entra no histórico.
  O atributo é regravado em JSON canônico com aspas simples (`data-keyframes='[...]'`), um ponto por tempo e
  chaves na ordem `time, volume, opacity, x, y, scale, scaleX, scaleY, rotate, blur, clip, zoom, focusX, focusY,
  curve`; `scale` vale como `scaleX` + `scaleY`. Em `GET /api/composition`, `keyframes` é essa lista unificada
  (`[{time, ...props, curve?}]`, com os pontos de volume e os visuais do próprio clip fundidos por tempo) e
  `descendantKeyframeTimes` traz os tempos locais dos keyframes de elementos internos, só leitura.
  `hasKeyframes` segue sendo "tem `data-keyframes` com volume" (compatibilidade). Valores entre dois pontos
  com unidades diferentes (`clip`, `x` em `%` e `px`) ficam no valor inicial até o fim do segmento.
  O inspetor tem a seção "Keyframes" (seletor de propriedade, "Adicionar no playhead", lista de pontos, campos
  de valor e curva, "Remover keyframe"); a timeline desenha um losango por tempo no `lane` do clip (cinza e só
  leitura para os de elementos internos). Atalhos: `K` adiciona no playhead (arredondado ao frame) a
  propriedade escolhida; arrastar um losango é `op: "move"` ao soltar (arredondado ao frame); Delete/Backspace
  com um losango selecionado é `op: "remove"` e nunca apaga o clip. A seleção é descartada ao trocar de clip e
  após desfazer/refazer se o ponto deixou de existir.

- **Excluir** (`POST /api/clips/<id>/delete`, corpo `{}`; atalho Delete/Backspace e botão "Excluir"). Remove o
  clip e o que estiver dentro dele. Clips que começavam no fim dele (`data-start="<id>"` ou `"<id> + x"`)
  ganham `data-start` absoluto igual ao instante em que já começavam: nada mais se move. Se um desses clips
  era a segunda ponta de uma transição com o excluído (`data-transition`, §7b.10), a transição sai junto com o
  parceiro (`data-transition` é removido) e o clip mantém o mesmo início. Exige `data-clip-id` explícito e clip
  de topo deste arquivo (`E_DELETE_UNSUPPORTED`, com a dica "edite o arquivo da sub-composição" ou "dê
  data-clip-id a <id>"). Também é `E_DELETE_UNSUPPORTED` quando o início de quem o referencia teria de ser
  calculado atravessando escopos: a referência resolve por id no arquivo todo, mas o número que sai é do
  escopo de quem referencia (referenciador dentro de sub-composição, ou referência a um filho do clip
  excluído). Id inexistente ou sem `data-clip-id` é `E_CLIP_NOT_FOUND`. Excluir o único clip de uma raiz sem
  `data-duration` deixa a duração indefinida e responde `400 E_CONTRACT_INVALID` com o arquivo intacto. A linha
  do clip some inteira, sem deixar vazio. Sucesso devolve `{ok, id, duration, history}` e entra no histórico
  como `excluir <id>` (Ctrl+Z restaura o arquivo byte a byte). Delete/Backspace só exclui o clip quando
  nenhum keyframe está selecionado; com um keyframe selecionado apaga só o keyframe. O botão fica desabilitado
  sem seleção ou com clip não editável, e após excluir a seleção é limpa.

- **Aparar o início** (`POST /api/clips/<id>/trim`, corpo `{start}` em segundos da timeline da raiz; arrastar a
  borda esquerda da barra, `.resize-handle-start`). Move só a borda esquerda: o fim do clip fica parado.
  Com `delta = start - início atual`, grava `data-duration = fim - start`; `data-start` vira `seconds(start)`
  (início absoluto) ou `"<ref>"` + o deslocamento antigo somado a `delta` (início por referência); em
  `<video>`/`<audio>`, `data-offset` avança `delta × data-playback-rate` (o quadro que estava sob o novo início
  continua sob ele; `data-fade-in` não muda). Como o fim não muda, quem começa no fim do clip
  (`data-start="<id>"`) não se move. O movimento próprio do clip (`data-enter`/`data-exit`) é local ao clip e
  passa a tocar a partir do novo início. Erros (400, arquivo intacto): `E_TRIM_OUT_OF_RANGE` quando `start < 0`,
  `start > fim - 1/60 s` ou o `data-offset` resultante ficaria negativo (a mídia não tem material antes do
  começo da fonte; a mensagem diz o início mais cedo possível); `E_TRIM_UNSUPPORTED` para clip dentro de
  sub-composição, clip que contém outros clips, clip com `data-keyframes`, clip com `data-transition` (dica
  "remova a transição antes de aparar": aparar mudaria a sobreposição) e clip sem início e fim resolvidos (dica
  "declare data-duration"). Sucesso devolve `{ok, id, duration, history}` e entra no histórico como
  `aparar <id>` (Ctrl+Z restaura o arquivo byte a byte). Na timeline a alça só aparece em clip editável sem
  filhos, keyframes nem transição; durante o arrasto a barra para em 0, na borda da fonte (mídia) e a 0,1 s do
  fim, e o início é arredondado ao frame. O `data-offset` é calculado pelo servidor e a Studio recarrega a
  composição ao soltar.

- **Copiar/colar/duplicar** (`POST /api/clips/<id>/duplicate`, corpo `{}`, e `POST /api/clips/<id>/paste`, corpo
  `{at}` em segundos; atalhos Ctrl+C, Ctrl+V no playhead e Ctrl+D logo depois do original, só com o foco fora de
  campos de edição e um clip editável selecionado, no caso de copiar e duplicar). Copia o elemento inteiro, com
  os filhos, para logo depois do original no arquivo (mesmo pai, mesma indentação). A cópia ganha
  `data-clip-id` novo (`clip-N` livre, escolhido pelo servidor) e `data-start` absoluto: `duplicate` usa o fim
  do original, `paste` usa `at`. Todo descendente com `data-clip-id` passa a `<novo>-<antigo>`, e os
  `data-start` de dentro da cópia que apontavam para um clip renomeado seguem o novo id (com o mesmo
  deslocamento); referência para um clip fora da cópia fica como está. Como o id exato vale sobre a leitura
  `id - n` (EDT-75), `data-start="clip-9-g1"` resolve para o fim de `clip-9-g1`. `data-enter`, `data-exit`,
  `data-keyframes`, `data-volume` e os demais atributos locais ao clip vêm junto. Nenhum outro clip se move
  nem muda. Avisos (`warnings`, a cópia é feita mesmo assim): `id HTML duplicado: <x>` para cada atributo HTML
  `id` copiado (o arquivo fica com dois elementos com o mesmo `id`; seletores CSS por `[data-clip-id="x"]` ou
  por `id` do autor também não alcançam a cópia, e o autor decide o que fazer) e `transição não copiada` quando
  a raiz tinha `data-transition`: a cópia começa em instante absoluto e deixaria de encostar no parceiro
  (`E_TRANSITION_PARTNER`), então o atributo não é copiado; uma transição entre dois filhos da cópia continua
  válida, porque as referências internas foram renomeadas. Erros (400, arquivo intacto): `E_COPY_UNSUPPORTED` para
  clip aninhado em sub-composição (só clip de topo; um host de sub-composição por `data-composition-src` pode
  ser copiado e a cópia aponta para o mesmo arquivo, que não é duplicado), `E_COPY_OUT_OF_RANGE` para `at < 0`
  ou não finito, `E_AMBIGUOUS_CLIP` quando algum id novo já existe, `E_CLIP_NOT_FOUND` para id inexistente ou sem
  `data-clip-id` explícito (em `paste`, a mensagem é "o clip copiado não existe mais"). Sucesso devolve
  `{ok, id, duration, warnings, history}` e entra no histórico como `duplicar <id>` ou `colar <id>` (Ctrl+Z
  restaura o arquivo byte a byte). Copiar guarda só a referência (`state.clipboard = <id>`), não o conteúdo:
  se o original for excluído ou editado antes de colar, vale o que existir na hora de colar. Depois de colar ou
  duplicar a cópia fica selecionada e os avisos aparecem no painel de ferramentas.

- **Zoom da timeline** (EDT-45; só cliente, nada é gravado no arquivo). A timeline é desenhada em px:
  `px = segundos × state.pxPerSecond`. O zoom mínimo é "ajustar" (a composição inteira na largura visível,
  sem rolagem horizontal) e acompanha o redimensionamento da janela; o máximo é `fps × 48` px/s, isto é,
  1 frame = 48 px. Controles: botões `−`, `+` e "Ajustar" (`#zoomOut`, `#zoomIn`, `#zoomFit`), indicador
  `#zoomLevel` ("N px/s" ou, no nível de frame, "1 frame = N px"), teclas `=`/`+` e `-` (só com o foco fora de
  campos de edição) e Ctrl+roda, que dá passos de ×1,15 e mantém parado o instante sob o ponteiro. A régua
  (cabeçalho fixo no topo) mostra só os tiques da janela visível e escolhe o passo pelo zoom: de 1 s ou mais
  até frames; no nível de frame (≥ 8 px por frame) os rótulos são `s:ff`. Mover e redimensionar clips
  alinham ao frame (ver "Faixas"); o diamante de keyframe sempre alinha ao frame.
  O playhead é desenhado em px e, com ele em movimento (tocando ou arrastado no player), a timeline rola
  para mantê-lo visível.
- **Faixas** (EDT-44). A timeline agrupa os clips em linhas por (tipo, `data-track`): vídeo/imagem (`V`), texto
  (`T`) e áudio (`A`); `data-track` ausente vale 0. O bloco visual vem primeiro, da faixa maior (por cima) para
  a menor, e em empate o texto fica acima do vídeo; o bloco de áudio vem abaixo, em ordem crescente. Rótulos
  `V2`, `T3`, `A0`. Clips que se sobrepõem na mesma linha ocupam sub-raias (só visual, nada é gravado). As
  zonas "+ nova faixa" (acima do bloco visual e abaixo do de áudio) criam `maxVisual + 1` / `maxAudio + 1`.
  Arrastar um clip para outra linha grava `data-track`, e o tempo da mesma soltura (`data-start`) vai no mesmo
  patch, então Ctrl+Z desfaz os dois de uma vez. Clip visual só solta em linha visual (ou na zona nova de
  cima) e áudio só em linha de áudio; destino inválido deixa a faixa como estava. Ao mover, redimensionar a
  borda direita e aparar a borda esquerda, as bordas grudam (ímã) no playhead, em 0, no fim da composição e nas
  bordas dos outros clips quando a distância é de até 8 px na tela (`8 / state.pxPerSecond` segundos, então
  vale em qualquer zoom); uma linha vertical (`.snap-guide`) marca o alvo. Alt desliga o ímã. Sem ímã o tempo é
  arredondado ao frame (`roundToFrame`) em qualquer zoom. Colar e duplicar (EDT-43) clonam o clip original, então
  a cópia fica na mesma faixa dele; só um clip novo (bloco de título/legenda) nasce em `maxVisual + 1`, com
  `position:absolute` no `style`.
- **Camada sem efeito**: depois de carregar o preview, o Studio lê `getComputedStyle(el).position` dos clips com
  `data-track` no iframe; se o elemento está `static` (e o pai não é flex/grid) a barra mostra ⚠ com o título
  "camada sem efeito: elemento não posicionado". É aviso de UI, nada bloqueia nem é gravado.
- **Waveform** (`GET /api/waveform/<id>`, EDT-45). Para clip `editable` de vídeo/áudio com som devolve
  `{digest, peaksPerSecond: 100, duration, peaks}`: `digest` é o sha256 do arquivo de mídia, `duration` os
  segundos de áudio decodificados e `peaks` um inteiro 0–255 por centésimo de segundo (máximo do módulo da
  amostra; áudio mono a 8 kHz extraído pelo FFmpeg). O cache fica em `cache/waveform/<digest>.v1.json` sob o
  `FRANKFRAMES_HOME` (ou `vendor/`); é gravado de forma atômica (arquivo temporário + rename) e um JSON
  corrompido ou de formato inesperado falha alto com `E_WAVEFORM_FAILED` e a dica de apagar o arquivo, nunca
  vira cache vazio. Erros: `404 E_CLIP_NOT_FOUND`, `400 E_WAVEFORM_UNSUPPORTED` (clip sem mídia de
  vídeo/áudio), `422 E_WAVEFORM_NO_AUDIO` (arquivo sem faixa de áudio) e `500 E_WAVEFORM_FAILED`. No cliente,
  uma busca por fonte de mídia (`state.waveforms`) alimenta um `<canvas>` por clip com som, que cobre só a
  parte visível da barra e é redesenhado em `requestAnimationFrame` ao rolar ou dar zoom; a forma de onda
  acompanha `data-offset` e `data-playback-rate`, então aparar o início a desloca junto com o clip. Falha vira
  uma faixa hachurada na barra com o código no `title`.

- **Exportar** (EDT-46; `GET /api/export` → `{job, defaults}`, `POST /api/export {preset, codec, output,
  overwrite}`; botão Exportar). Renderiza o arquivo **salvo** com o mesmo pipeline e as mesmas guardas de licença do
  `frankframes render` (`render-guard.ts`: build LGPL, H.264 só com `FRANKFRAMES_ALLOW_H264=1`). `preset` é `draft`,
  `standard` ou `high`; `codec` é `av1` (padrão), `vp9` ou `h264`; `output` é relativo à pasta da entrada ou
  absoluto e termina em `.mp4` (av1/h264) ou `.webm` (vp9), senão `400 E_EXPORT_OUTPUT_INVALID`; o padrão
  (`defaults.output`) é `out/<nome>.mp4` do diretório atual. Contrato inválido bloqueia com `400 E_CONTRACT_INVALID`
  e os diagnósticos, sem criar job; erro da guarda de licença sai com o código dela (`400`). Destino existente sem
  `overwrite: true` é `409 E_EXPORT_EXISTS`. Um export por vez: outro pedido é `409 E_EXPORT_BUSY`. A resposta é
  `202 {id, output}`; o estado (`running|done|failed|canceled`, `stage`, `percent`, `message`, `output`, `warnings`,
  `error` com o payload de `render --json`, `result`) chega por `/api/events` como `event: export` e em
  `GET /api/export`. **Cancelar** (`POST /api/export/cancel`) interrompe FFmpeg e captura, apaga temporários e a saída
  parcial e responde só depois da limpeza (`409 E_EXPORT_IDLE` se não há export rodando); o job termina `canceled`.
  **Abrir pasta** (`POST /api/export/reveal`) mostra o arquivo no gerenciador do sistema (`explorer.exe /select,` no
  Windows, cujo código de saída 1 não é erro; `open -R` no macOS; `xdg-open` da pasta no Linux) e só vale com o job
  `done` (`409 E_EXPORT_NOT_DONE`; falha ao abrir é `500 E_REVEAL_FAILED`). As rotas de export não entram na fila
  de escrita (não tocam o arquivo da composição); fechar o Studio cancela o export em andamento. No cliente o botão
  fica desabilitado com edição pendente ou inspetor sujo ("aplique as alterações antes de exportar"); com export
  rodando mostra o percentual e reabre o progresso. Substituir um arquivo pede confirmação no diálogo.

As escritas são serializadas: duas edições nunca intercalam leitura e gravação do mesmo arquivo.

## 9e. Linha de comando: ajuda

`--help` e `-h` em **qualquer posição** da linha de comando de **qualquer** subcomando (`lint`, `render`, `frames`,
`generate`, `preview`, `studio`, `transcribe`, `captions`, `models`, `blocks`, `gallery`, `init`, `doctor`, `setup`,
`upgrade`, `skill`, `browser`, inclusive com ação, como `blocks add --help`) mostram a ajuda geral no stdout e saem
com 0 **antes de qualquer efeito**: nenhum arquivo é criado ou alterado, nenhum servidor sobe, nenhuma rede é
usada. A lista de subcomandos fica em `packages/cli/src/help.ts` (`COMMANDS`) e é a mesma que o despacho usa para
reconhecer o comando; um teste varre essa lista e roda cada um com `--help` e `-h` num diretório vazio.

## 10. Compatibilidade

Composições escritas para outro framework entram por um **importador separado** (`compat-*`), que traduz
nomes no parsing. O núcleo não ganha um segundo nome para o mesmo conceito, nem modo "congela em t=0".

Composições sem atributos de motion (§7b) compilam exatamente como antes: o compilador não grava
`data-ff-motion` e o runtime de motion não cria animação. Pontos de `data-keyframes` só com `volume`
continuam idênticos: mesmo `RawClip.keyframes`, mesma mixagem, nenhum alvo de motion.

## 11. Variáveis

Uma composição pode ser um **modelo**: os pontos que mudam de uma versão para outra são marcados no HTML e
recebem valor na hora do render (`render --batch`, `RenderOptions.vars`; ver `docs/batch.md`). Sem `vars`, nada
muda: o valor autoral fica e os atributos abaixo são inertes.

1. **Marcar texto.** `data-var="titulo"` troca o texto do elemento pelo valor de `titulo`, com escape de `&`, `<`
   e `>` (o valor é sempre texto, nunca HTML). O elemento só pode conter texto (ou nada): filho elemento ou
   comentário é `E_VAR_INVALID`, e também elemento void/sem fechamento (`<img>`), `<script>` e `<style>`.
2. **Marcar atributo.** `data-var-attr="src:foto; data-duration:tempo"` troca (ou cria) os atributos listados,
   pares `atributo:variável` separados por `;`. O valor é escapado para aspas duplas (`&`, `"`). Os próprios
   `data-var` e `data-var-attr` não podem ser alvo, e o mesmo atributo duas vezes no mesmo elemento é
   `E_VAR_INVALID`.
3. **Nome da variável.** `^[A-Za-z_][A-Za-z0-9_-]*$`. Forma inválida (na marcação ou nas `vars`) é
   `E_VAR_INVALID`.
4. **Conferência nos dois sentidos.** Chave usada no HTML e ausente das `vars` é `E_VAR_MISSING` (a mensagem lista
   todas as que faltam); chave das `vars` que nenhum elemento usa é `E_VAR_UNKNOWN` (erro de digitação não passa
   calado). Os valores das `vars` são texto; qualquer outro tipo é `E_VAR_INVALID`.
5. **Ordem.** As variáveis entram **depois** de as sub-composições (§5) serem unidas e **antes** do contrato (§3, §7):
   um `data-duration`, `data-start` ou `data-fps` trocado por variável é o valor que o contrato resolve, e
   `data-var` dentro de uma sub-composição vale como no arquivo principal. Todo o resto do arquivo (comentários,
   indentação, ordem dos atributos) fica como o autor escreveu.
6. **Erros.** `E_VAR_MISSING`, `E_VAR_UNKNOWN` e `E_VAR_INVALID` são códigos de render com `stage: "compile"`, saem em
   `render --json` e bloqueiam o render antes de abrir o Chrome. `E_BATCH_INVALID` (arquivo de lote malformado) é do
   lote, não de uma composição.
7. **Lint.** O lint não valida `data-var`/`data-var-attr`: as variáveis só existem na hora do render, quando há `vars`
   para conferir.
