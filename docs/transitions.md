# Transições entre cenas

Duas cenas encadeadas são **dois hosts de sub-composição** na raiz. Cada host é um clip com janela
própria e tempo local; veja [`examples/cena-dupla/index.html`](../examples/cena-dupla/index.html).

## 1. Encadear

```html
<div data-composition-id="peca" data-root="true"
     data-width="1920" data-height="1080" data-fps="30" data-duration="8">

  <div class="cena-a" data-composition-id="cena-a" data-start="0" data-duration="4">
    <!-- blocos com data-start LOCAL: 0, 0.15, 0.85… -->
  </div>

  <div class="cena-b" data-composition-id="cena-b" data-start="4" data-duration="4">
    <!-- o mesmo bloco copiado, com ids de clip únicos em toda a árvore -->
  </div>
</div>
```

Um host de sub-composição é uma fronteira de escopo (`docs/contract.md` §5): os `data-start` internos
contam do início da cena, não da raiz. Os `data-clip-id` continuam únicos na árvore inteira — é por
eles que a anotação de tempo liga o DOM ao contrato.

## 2. Por que `animation-delay` precisa ser absoluto

O engine não "toca" animações: ele pausa todas e escreve `animation.currentTime = agora - início do
escopo` (`packages/engine/src/clock.ts`). O `animation-delay` do CSS é lido nessa mesma linha do tempo.
Logo, o atraso é **uma posição na timeline do escopo**, nunca "tempo desde que o clip apareceu":

- na raiz, o atraso é o `data-start` absoluto da faixa (ex.: `3.7s`);
- dentro de um host, o atraso é o `data-start` local (ex.: `0.2s` vira 4,2 s absolutos porque o host
  começa em 4 s).
Não calcule atraso em JavaScript nem use `animation-play-state`. `data-start`/`data-duration` já
escondem o elemento fora da janela; a animação continua avançando por baixo e chega no frame certo em
qualquer ordem de seek.

## 3. Faixa atravessando o quadro

Um clip de 0,6 s cavalgando o corte, com `clip-path` animado e o atraso igual ao `data-start`:
```html
<div class="faixa" data-clip-id="faixa" data-start="3.7" data-duration="0.6"></div>
```
```css
.faixa {
  position: absolute; inset: 0; z-index: 20;
  background: #d8452e;
  animation: faixa-sweep 0.6s cubic-bezier(0.65, 0, 0.35, 1) 3.7s both;
}
@keyframes faixa-sweep {
  from { clip-path: polygon(-280% 0%, 0% 0%, 10% 100%, -270% 100%); }
  to   { clip-path: polygon(100% 0%, 380% 0%, 390% 100%, 110% 100%); }
}
```

A faixa é mais larga que o quadro: no meio da animação (4,0 s, exatamente o corte) ela cobre 0–100%
em todas as linhas. `both` aplica o primeiro keyframe durante o atraso e segura o último no fim, então
não há "piscada" antes de 3,7 s nem depois de 4,3 s. Para o corte ficar escondido, o instante de troca
das cenas tem que cair no meio da faixa.

## 4. Íris

Mesmo padrão, trocando só a geometria: `clip-path: circle(0% at 50% 50%)` → `circle(75% at 50% 50%)`,
com o clip de transição centralizado no ponto de interesse e o mesmo atraso absoluto. `inset()` também
funciona para uma cortina; anime `clip-path` (não `opacity`) para revelar a cena de baixo.

## 5. Recortar a janela de cada cena

`data-start` e `data-duration` do host são a tesoura: fora de `[start, start + duration)` o host fica
`visibility: hidden`, e um clip interno que ultrapasse a duração é cortado pelo host.

- cena A `0` + `4` → janela `[0, 4)`;
- cena B `4` + `4` → janela `[4, 8)`;
- faixa `3.7` + `0.6` → janela `[3.7, 4.3)`, sobreposta às duas.

Se a raiz não tiver `data-duration`, a duração é derivada do maior fim — aqui, 8 s. Sobrepor as cenas
encurta o total: B em `3.4` com 4 s terminaria em 7,4 s; nesse caso declare a duração da raiz e feche
o vídeo com um clip de cauda, em vez de deixar a conta decidir por você. Rode
`frankframes lint arquivo.html` para conferir janelas e duração antes do render.
