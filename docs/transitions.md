# Transições entre cenas

Uma transição é o que acontece quando um clip sai e o seguinte entra, os dois ao mesmo tempo. O FrankFrames
tem uma forma declarativa para isso, `data-transition` (spec em [`contract.md`](contract.md) §7b.10), e deixa
a forma manual com `@keyframes` para o que nenhum preset cobre.

## 1. Transição declarativa

O clip que **entra** (B) leva o preset e começa um pouco antes de o clip que **sai** (A) terminar. A
sobreposição é a duração da transição:

```html
<div data-composition-id="peca" data-root="true" data-width="1920" data-height="1080" data-fps="30">
  <div data-clip-id="a" data-start="0" data-duration="4" class="cena">…</div>
  <div data-clip-id="b" data-start="a - 0.5" data-duration="4" class="cena"
       data-transition="empurrar dir=left">…</div>
</div>
```

- `data-start="a - 0.5"` é a regra: B começa 0.5 s antes do fim de A, então a transição dura 0.5 s. Não existe
  `dur` em `data-transition`; mude o número em `data-start`.
- A precisa ser **irmão** de B (mesmo escopo) e **vir antes** dele no documento; senão o contrato dá
  `E_TRANSITION_PARTNER`. B fica por cima de A pela ordem do documento.
- A transição encurta o vídeo em `d`: a duração derivada da composição passa a ser `4 + 4 − 0.5 = 7.5` s.
  Quem referencia B (`data-start="b + 1"`) anda os mesmos `d` para trás.
- O preset e a curva: `curve=` vale como em qualquer movimento (`data-transition="cortina curve=suave"`).
  Os cinco presets, com miniatura, estão em [`motion.md`](motion.md#transição): `dissolver`, `cortina`,
  `empurrar`, `zoom` e `iris`.

A transição fica **dentro** do clip: mexe só em B (e em A, no `empurrar`), então cada cena continua com o
próprio `data-start` e as próprias animações.

### Cenas encadeadas (hosts de sub-composição)

Duas cenas encadeadas são **dois hosts de sub-composição** na raiz; cada host é um clip com janela própria e
tempo local (veja [`examples/cena-dupla/index.html`](../examples/cena-dupla/index.html)). `data-transition`
vale neles do mesmo jeito:

```html
<div data-composition-id="cena-a" data-start="0" data-duration="4">…</div>
<div data-composition-id="cena-b" data-start="cena-a - 0.5" data-duration="4"
     data-transition="dissolver">…</div>
```

Um host é uma fronteira de escopo (`contract.md` §5): os `data-start` internos contam do início da cena, não
da raiz, e os `data-clip-id` continuam únicos na árvore inteira.

## 2. Por que `animation-delay` precisa ser absoluto

Vale só para o que você escreve à mão em CSS. O engine não "toca" animações: ele pausa todas e escreve
`animation.currentTime = agora - início do escopo` (`packages/engine/src/clock.ts`). O `animation-delay` do
CSS é lido nessa mesma linha do tempo. Logo, o atraso é **uma posição na timeline do escopo**, nunca "tempo
desde que o clip apareceu":

- na raiz, o atraso é o `data-start` absoluto da faixa (ex.: `3.7s`);
- dentro de um host, o atraso é o `data-start` local (ex.: `0.2s` vira 4,2 s absolutos porque o host
  começa em 4 s).

Não calcule atraso em JavaScript nem use `animation-play-state`. `data-start`/`data-duration` já
escondem o elemento fora da janela; a animação continua avançando por baixo e chega no frame certo em
qualquer ordem de seek. Os atributos de motion (inclusive `data-transition`) já fazem essa conta pelo
compilador.

## 3. Faixa atravessando o quadro (CSS à mão)

Nenhum preset faz uma faixa de cor cruzando o corte. Para isso, um clip de 0,6 s cavalgando a emenda, com
`clip-path` animado e o atraso igual ao `data-start`:

```html
<div class="faixa" data-clip-id="faixa" data-start="3.7" data-duration="0.6"></div>
```
```css
.faixa {
  position: absolute; inset: 0; z-index: 20;
  background: #d8452e;
  animation: faixa-sweep 0.6s cubic-bezier(0.58, 0.04, 0.3, 0.97) 3.7s both;
}
@keyframes faixa-sweep {
  from { clip-path: polygon(-280% 0%, 0% 0%, 10% 100%, -270% 100%); }
  to   { clip-path: polygon(100% 0%, 380% 0%, 390% 100%, 110% 100%); }
}
```

A curva é a `vaivem` do contrato (§7b.11). A faixa é mais larga que o quadro: no meio da animação (4,0 s,
exatamente o corte) ela cobre 0–100% em todas as linhas. `both` aplica o primeiro keyframe durante o atraso e
segura o último no fim, então não há "piscada" antes de 3,7 s nem depois de 4,3 s. Para o corte ficar
escondido, o instante de troca das cenas tem que cair no meio da faixa.

Para revelar a cena de baixo com uma íris ou cortina à mão, anime `clip-path` (não `opacity`) do clip de cima;
os presets `iris` e `cortina` fazem isso por você.

## 4. Recortar a janela de cada cena

`data-start` e `data-duration` do host são a tesoura: fora de `[start, start + duration)` o host fica
`visibility: hidden`, e um clip interno que ultrapasse a duração é cortado pelo host.

- cena A `0` + `4` → janela `[0, 4)`;
- cena B `4` + `4` → janela `[4, 8)` (sem transição) ou `3.5` + `4` → `[3.5, 7.5)` com `data-start="cena-a - 0.5"`;
- faixa `3.7` + `0.6` → janela `[3.7, 4.3)`, sobreposta às duas.

Se a raiz não tiver `data-duration`, a duração é derivada do maior fim: 8 s sem transição, 7,5 s com ela.
Para fechar o vídeo numa duração fixa, declare a duração da raiz e termine com um clip de cauda, em vez de
deixar a conta decidir por você. Rode `frankframes lint arquivo.html` para conferir janelas e duração antes do
render.
