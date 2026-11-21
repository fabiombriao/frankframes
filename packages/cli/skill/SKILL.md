---
name: frankframes
description: Produzir ou revisar um vídeo no FrankFrames a partir de HTML. Use quando o pedido for criar uma composição, ajustar tempo/duração, animar com CSS, escolher fontes do catálogo ou renderizar com `frankframes lint` e `frankframes render`.
---

# FrankFrames

FrankFrames transforma um arquivo HTML em vídeo frame a frame. O motor não "toca" a página: ele
posiciona o relógio em um instante, fotografa o resultado e passa ao próximo frame. Todo trabalho é
declarativo e determinístico — o mesmo frame precisa sair igual em qualquer worker, em qualquer ordem.

## Anatomia de uma composição

Uma composição é um HTML com uma raiz marcada. O exemplo mínimo:

```html
<div data-composition-id="peca" data-root="true"
     data-width="1920" data-height="1080" data-fps="30"
     data-duration="4">
  <div data-clip-id="titulo" data-start="0" data-duration="3.2">Olá</div>
</div>
```

| Atributo | Regra |
|---|---|
| `data-composition-id` | obrigatório na raiz; identifica a composição |
| `data-root="true"` | desempata quando há mais de uma composição no arquivo |
| `data-width` / `data-height` | pixels inteiros > 0 |
| `data-fps` | inteiro (`30`) ou racional (`30000/1001`); `29.97` é inválido |
| `data-duration` | segundos > 0; na raiz, vence qualquer duração derivada |
| `data-start` na raiz | ignorado — a raiz sempre começa em 0 |

Um **clip** é uma linha de timeline: elemento com `data-start`, ou com `data-track` e
`data-duration`, ou uma mídia (`video`, `audio`, `img`). Elementos sem tempo são atravessados como
meros wrappers. Dê `data-clip-id` a todo clip que outro clip possa referenciar.

## Tempo

`data-start` aceita exatamente quatro formas:

| Forma | Significado |
|---|---|
| ausente | `0` |
| `2.5` | absoluto, em segundos |
| `intro` | no instante em que o clip `intro` **termina** |
| `intro + 1` / `intro-0.5` | fim do alvo, deslocado |

Referência aponta sempre para o fim, nunca para o início. Id desconhecido ou forma estranha é erro de
contrato; não existe fallback. Use referências para encadear blocos sem recalcular números.

`data-duration` é segundos ≥ 0. O fim de um clip é sempre `start + duration`; `data-end` não existe.
A duração da composição vem de `data-duration` na raiz ou do maior fim entre os clips. Para a segunda
opção, **todo** clip precisa de duração declarada.

Mídia local (`<video>`, `<audio>`, `<img>` com `src` relativo) precisa de `data-duration` ou de uma
duração medida pelo probe. Sem uma das duas, a composição fica `unresolved` e o render não começa.

## Animação

Para entrada, saída e ênfase, use primeiro os atributos de motion (§7b do contrato) e só depois CSS:
`data-enter`, `data-exit`, `data-emphasis` e, para valores por tempo, `data-keyframes`. Eles são
determinísticos, têm tempo local ao clip e são validados antes do render. A lista completa, com chaves e
miniaturas, está em `docs/motion.md`. O formato é `preset chave=valor ...`; toda chave é opcional.

```html
<h1 data-clip-id="titulo" data-start="0" data-duration="4"
    data-enter="subir distance=24 at=0.2" data-emphasis="pulsar" data-exit="apagar">Olá</h1>
<div data-clip-id="selo" data-start="0" data-duration="3" data-enter="saltar amount=0.4 dur=0.9">Novo</div>
<img data-clip-id="foto" data-start="0" data-duration="5" src="foto.png" data-enter="abrir dir=up">
```

Presets de entrada (12): `surgir`, `subir`, `descer`, `chegar-esquerda`, `chegar-direita`, `crescer`,
`assentar`, `focar`, `girar`, `abrir`, `erguer`, `saltar`. De saída (8): `apagar`, `partir-cima`,
`partir-baixo`, `partir-esquerda`, `partir-direita`, `recuar`, `desfocar`, `fechar`. De ênfase (6):
`pulsar`, `balancar`, `tremer`, `respirar`, `piscar`, `quicar`.

Câmera em foto ou vídeo (só `<img>` e `<video>`): `data-camera="<preset> [amount=] [fx=] [fy=] [at=] [dur=]"`
com `aproximar`, `afastar`, `panoramica-esquerda`, `panoramica-direita` e `deriva`. Sem `dur`, o movimento vai do
`at` até o fim do clip. Exemplo: `<img data-clip-id="foto" data-start="0" data-duration="5" src="foto.jpg"
data-camera="panoramica-direita">`. `zoom` (1 a 4) e `focusX`/`focusY` (0 a 1) também valem em `data-keyframes`,
só em `<img>`/`<video>`. Num `<video>` o movimento age na `<img>` que o substitui no render, que herda o
`object-fit` do vídeo; motion num ancestral do `<video>` não o move.

Transição entre dois clips do mesmo escopo: `data-transition="<preset> [dir=] [fx=] [fy=] [curve=]"` no clip que
entra (B), com `data-start="<id do clip anterior> - <d>"`; a sobreposição `d` é a duração (não existe `dur`) e o
vídeo encurta `d`. Presets: `dissolver`, `cortina`, `empurrar`, `zoom`, `iris`. Exemplo: `<div data-clip-id="b"
data-start="a - 0.5" data-duration="4" data-transition="empurrar dir=left">`. Parceiro inexistente ou
posterior dá `E_TRANSITION_PARTNER`.

Tipografia cinética: `data-split="word"` (ou `letter`, com `stagger=<s>` e `order=forward|reverse|center`)
no elemento com texto, mais `data-enter`/`data-exit`/`data-emphasis` no mesmo elemento, anima cada palavra
(ou letra) em sequência. Exemplo: `<h1 data-clip-id="t" data-start="0" data-duration="4"
data-split="word stagger=0.08" data-enter="subir">Coração e emoção</h1>`. Não ponha motion em elemento
interno do texto. `letter` não serve para árabe (perde a ligação entre letras): use `word`.

Chaves comuns: `dur` (segundos), `at` (instante: `0.5`, `50%`, `end`, `end-0.3`) e `curve` (`suave`,
`freio`, `arranque`, `vaivem`, `mola`, `cubic-bezier(...)`). Cada preset acrescenta `distance`
(`32`, `32px` ou `10%`), `amount`, `dir` (`left|right|up|down`) ou `repeat`. `mola` só assenta com `dur` longo
o bastante (`saltar dur=0.3` dá `E_CURVE_INVALID`).

CSS `@keyframes` continua valendo para o que motion não cobre (cor, stroke, largura). Nesse caso, e em
qualquer animação própria, use apenas CSS (`@keyframes`, `transform`, `opacity`, `clip-path`) ou WAAPI
declarativa: animações devem ser função do tempo da linha do tempo, não de interação (nada de `:hover`,
clique, scroll ou evento). Não use JavaScript, `<script>` nem bibliotecas de animação. Não declare no
`style` do mesmo elemento uma propriedade que o motion controla (`scale`, `rotate`, `translate`,
`filter`, `clip-path`): para posição ou rotação fixas use `transform`.

Evite depender de estado acumulado entre frames. Se a composição precisa parecer "já animada" em um
instante arbitrário, prefira `animation-fill-mode: both` e curvas fechadas.

## Fontes

Só existem as famílias embarcadas no catálogo. Fora delas, o texto cai para a fonte padrão e o design
quebra.

- Sans: Inter, Poppins, Montserrat, Roboto, Assistant, DM Sans, Manrope, Nunito, Raleway, Space Grotesk
- Display: Oswald, Bebas Neue, Anton, Alfa Slab One, Bangers, Righteous, Permanent Marker
- Serif: Playfair Display, Lora, Merriweather
- Script: Great Vibes, Dancing Script, Caveat, Lobster
- Mono: JetBrains Mono

Pesos disponíveis: 400 e 700 (Poppins também 600; Bebas Neue, Anton, Alfa Slab One, Bangers,
Righteous, Permanent Marker, Great Vibes e Lobster só têm 400). Escreva o nome exato, entre aspas
quando tiver espaço: `font-family: "Space Grotesk", sans-serif`.

## Fluxo de produção

1. **Validar antes de renderizar.** O lint lê o contrato e lista clips, início, fim e diagnósticos.
   ```sh
   frankframes lint entrada.html
   frankframes lint entrada.html --json
   ```
   Saída com código 1 significa erro de contrato. Corrija antes de seguir.
2. **Conferir o tempo.** O lint mostra `start`/`end` de cada clip e a duração resolvida. Se aparecer
   `não resolvida` ou `duration-unresolved`, falta `data-duration` na raiz ou em algum clip/mídia.
3. **Pré-visualizar com o servidor local**, quando quiser inspecionar no navegador.
   ```sh
   frankframes preview entrada.html --open
   ```
4. **Renderizar.** O padrão é AV1 em MP4; VP9 gera WebM.
   ```sh
   frankframes render entrada.html -o out/peca.mp4
   frankframes render entrada.html -o out/peca.mp4 --codec av1 --preset high
   frankframes render entrada.html -o out/peca.webm --codec vp9 --preset draft
   ```
   `--preset` aceita `draft`, `standard` e `high`. `--workers N` paraleliza frames. Render falha
   alto: contrato inválido ou duração pendente não produzem arquivo "quase certo".

## Proibições concretas

1. **Não use GSAP** nem outra biblioteca de animação. O runtime é WAAPI/CSS.
2. **Não referencie CDN**: nada de `http://`, `https://`, `googleapis`, `cdn`, `unpkg` ou fonte
   remota. Todo recurso é local ou desenhado em CSS.
3. **Não use `data-media-start`.** O nome do deslocamento dentro da mídia é `data-offset`.
4. **Não confie em `data-track` para lógica.** Ele é só arrumação visual de UI; o render ignora.
5. **Não deixe mídia sem `data-duration` nem duração medida.** Se o probe não puder medir, declare o
   tempo no elemento.

## Legendas e áudio

- `frankframes captions <audio> -o legendas.html` gera a composição de legendas. Se o provedor devolver
  tempos por palavra, a saída é **karaokê**: cada palavra acende quando é falada
  (`animation-delay` absoluto) e as anteriores ficam na cor de destaque. Com `--motion "<preset de
  entrada>"` (ex.: `--motion "subir"`), cada palavra também entra com esse preset, na hora em que é falada.
- Papel no mix: `data-audio-role="voice"` faz a música com `data-audio-role="music"` abaixar 9 dB.
- Entrega sai normalizada a −14 LUFS; use `--no-loudness` só para pós-produção externa.
- Animações CSS começam no tempo 0 da composição. Para a entrada acontecer quando o clip aparece,
  use `animation-delay` igual ao `data-start` do clip — não confie no aparecimento para disparar.

## Checklist de entrega

- [ ] Raiz com `data-composition-id`, `data-root="true"`, largura, altura, fps e duração > 0.
- [ ] Todo clip visível tem `data-clip-id`, `data-start` e `data-duration`.
- [ ] Referências de `data-start` apontam para ids existentes e sem ciclo.
- [ ] Só fontes do catálogo, com o nome exato e o peso disponível.
- [ ] Nenhum `<script>`, nenhuma URL externa, nenhum `data-media-start`.
- [ ] `frankframes lint` retorna 0 e `frankframes render` conclui no preset pedido.
