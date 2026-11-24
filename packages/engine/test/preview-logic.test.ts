// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { frameFromPointer, initialTransport } from "../src/preview-logic.ts";

// Barra de 1000 px começando em x=100, 90 frames (0..89): zona de borda = max(12, 1%) = 12 px.
const LEFT = 100;
const WIDTH = 1000;
const TOTAL = 90;

test("EDT-85: clique na borda esquerda da barra dá o frame 0, não o 1", () => {
  assert.equal(frameFromPointer(LEFT, LEFT, WIDTH, TOTAL), 0, "no pixel da ponta");
  assert.equal(frameFromPointer(LEFT + 6, LEFT, WIDTH, TOTAL), 0, "no meio da zona de borda");
  assert.equal(frameFromPointer(LEFT + 12, LEFT, WIDTH, TOTAL), 0, "no limite da zona de borda");
  assert.equal(frameFromPointer(LEFT - 20, LEFT, WIDTH, TOTAL), 0, "arrastar para fora, à esquerda, trava no 0");
});

test("EDT-85: clique na borda direita da barra dá o último frame", () => {
  const right = LEFT + WIDTH;
  assert.equal(frameFromPointer(right, LEFT, WIDTH, TOTAL), TOTAL - 1, "no pixel da ponta");
  assert.equal(frameFromPointer(right - 6, LEFT, WIDTH, TOTAL), TOTAL - 1, "no meio da zona de borda");
  assert.equal(frameFromPointer(right - 12, LEFT, WIDTH, TOTAL), TOTAL - 1, "no limite da zona de borda");
  assert.equal(frameFromPointer(right + 40, LEFT, WIDTH, TOTAL), TOTAL - 1, "arrastar para fora, à direita, trava no último");
});

test("EDT-85: entre as bordas o mapa é linear e arredondado ao frame mais próximo", () => {
  assert.equal(frameFromPointer(LEFT + WIDTH / 2, LEFT, WIDTH, TOTAL), Math.round((TOTAL - 1) / 2));
  // Logo depois da zona esquerda ainda é o frame 0; logo antes da direita já é o último.
  assert.equal(frameFromPointer(LEFT + 13, LEFT, WIDTH, TOTAL), 0);
  assert.equal(frameFromPointer(LEFT + WIDTH - 13, LEFT, WIDTH, TOTAL), TOTAL - 1);
  // Monotônico: andar para a direita nunca volta frame.
  let previous = 0;
  for (let x = LEFT; x <= LEFT + WIDTH; x += 1) {
    const frame = frameFromPointer(x, LEFT, WIDTH, TOTAL);
    assert.ok(frame >= previous, `frame voltou em x=${x}: ${previous} -> ${frame}`);
    previous = frame;
  }
});

test("EDT-85: barra estreita usa no máximo um quarto da largura como zona de borda", () => {
  // 40 px de largura: a zona seria 12 px; o teto de 1/4 (10 px) deixa meio-termo para o clique do meio.
  assert.equal(frameFromPointer(0, 0, 40, 31), 0);
  assert.equal(frameFromPointer(40, 0, 40, 31), 30);
  assert.equal(frameFromPointer(20, 0, 40, 31), 15);
});

test("EDT-85: um único frame é sempre o frame 0", () => {
  assert.equal(frameFromPointer(LEFT, LEFT, WIDTH, 1), 0);
  assert.equal(frameFromPointer(LEFT + WIDTH, LEFT, WIDTH, 1), 0);
});

test("EDT-85: entrada inválida lança em vez de devolver um frame qualquer", () => {
  assert.throws(() => frameFromPointer(Number.NaN, LEFT, WIDTH, TOTAL), TypeError);
  assert.throws(() => frameFromPointer(LEFT, Number.NaN, WIDTH, TOTAL), TypeError);
  assert.throws(() => frameFromPointer(LEFT, LEFT, 0, TOTAL), TypeError);
  assert.throws(() => frameFromPointer(LEFT, LEFT, -5, TOTAL), TypeError);
  assert.throws(() => frameFromPointer(LEFT, LEFT, Number.NaN, TOTAL), TypeError);
  assert.throws(() => frameFromPointer(LEFT, LEFT, WIDTH, 0), TypeError);
  assert.throws(() => frameFromPointer(LEFT, LEFT, WIDTH, 2.5), TypeError);
});

test("EDT-85: a função sobrevive ao toString() que a injeta na página", () => {
  // preview-ui.ts embute a função como texto; o texto precisa continuar autocontido e dar o mesmo resultado.
  const injected = new Function(`return (${frameFromPointer.toString()})`)() as typeof frameFromPointer;
  for (const x of [LEFT - 5, LEFT, LEFT + 12, LEFT + 500, LEFT + WIDTH - 12, LEFT + WIDTH, LEFT + WIDTH + 5]) {
    assert.equal(injected(x, LEFT, WIDTH, TOTAL), frameFromPointer(x, LEFT, WIDTH, TOTAL));
  }
});

test("EDT-85: o Studio abre pausado em 0, mesmo com play e instante salvos de outra visita", () => {
  assert.deepEqual(initialTransport({ savedMs: null, savedPlaying: null, isReload: false, autoplay: false }), { playing: false, ms: 0 });
  assert.deepEqual(initialTransport({ savedMs: 1500, savedPlaying: true, isReload: false, autoplay: false }), { playing: false, ms: 0 });
  assert.deepEqual(initialTransport({ savedMs: 1500, savedPlaying: false, isReload: false, autoplay: false }), { playing: false, ms: 0 });
});

test("EDT-85: recarga no Studio (edição, F5) restaura o instante e o estado de play salvos", () => {
  assert.deepEqual(initialTransport({ savedMs: 1500, savedPlaying: true, isReload: true, autoplay: false }), { playing: true, ms: 1500 });
  assert.deepEqual(initialTransport({ savedMs: 1500, savedPlaying: false, isReload: true, autoplay: false }), { playing: false, ms: 1500 });
  // Recarga sem nada salvo continua pausada em 0.
  assert.deepEqual(initialTransport({ savedMs: null, savedPlaying: null, isReload: true, autoplay: false }), { playing: false, ms: 0 });
  // Instante salvo sem estado de play: pausado (nunca religa sem registro).
  assert.deepEqual(initialTransport({ savedMs: 800, savedPlaying: null, isReload: true, autoplay: false }), { playing: false, ms: 800 });
});

test("EDT-85: o preview avulso continua abrindo tocando, salvo estado salvo de parado", () => {
  assert.deepEqual(initialTransport({ savedMs: null, savedPlaying: null, isReload: false, autoplay: true }), { playing: true, ms: 0 });
  assert.deepEqual(initialTransport({ savedMs: 400, savedPlaying: true, isReload: true, autoplay: true }), { playing: true, ms: 400 });
  assert.deepEqual(initialTransport({ savedMs: 400, savedPlaying: false, isReload: true, autoplay: true }), { playing: false, ms: 400 });
});
