// FrankFrames — proprietário. Ver LICENSE na raiz.
// Encaixe do player do Studio (EDT-87): lógica pura, sem DOM. ESM servido ao navegador e importado pelo Node nos testes.

/** Viewport do render quando a raiz não declara `data-width`/`data-height` (docs/contract.md §3). */
export const DEFAULT_PLAYER_WIDTH = 1920;
export const DEFAULT_PLAYER_HEIGHT = 1080;

/** Tamanho do viewport do preview: o que a raiz declara; o que falta cai no padrão do render. */
export function playerViewport(composition) {
  const valid = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
  return {
    width: composition && valid(composition.width) ? composition.width : DEFAULT_PLAYER_WIDTH,
    height: composition && valid(composition.height) ? composition.height : DEFAULT_PLAYER_HEIGHT,
  };
}

/**
 * Caixa do player dentro do espaço livre do painel: escala única (`min` das duas razões), sem cortar e sem esticar,
 * centrada. `scale` serve ao `transform` do iframe; `frameWidth`/`frameHeight` ao quadro que o recorta.
 */
export function fitPlayerBox(available, viewport) {
  if (!(available.width > 0) || !(available.height > 0)) throw new Error("espaço do player inválido: " + available.width + "x" + available.height);
  if (!(viewport.width > 0) || !(viewport.height > 0)) throw new Error("viewport do player inválido: " + viewport.width + "x" + viewport.height);
  const scale = Math.min(available.width / viewport.width, available.height / viewport.height);
  const frameWidth = viewport.width * scale;
  const frameHeight = viewport.height * scale;
  return {
    scale,
    frameWidth,
    frameHeight,
    left: (available.width - frameWidth) / 2,
    top: (available.height - frameHeight) / 2,
  };
}
