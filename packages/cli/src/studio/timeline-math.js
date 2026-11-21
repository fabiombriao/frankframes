// FrankFrames — proprietário. Ver LICENSE na raiz.
// Matemática pura da timeline do Studio: sem DOM, importável pelo navegador e pelo Node.

/** Quantidade de frames da composição (o frame parcial do fim conta); nunca menos de 1. */
export function frameCount(total, fps) {
  return Math.max(1, Math.ceil(total * fps - 1e-9));
}

/** Início do último frame, em segundos: o relógio do preview termina aqui, não em `total`. */
export function lastFrameTime(total, fps) {
  return (frameCount(total, fps) - 1) / fps;
}

/** Alinha um instante ao frame mais próximo. */
export function roundToFrame(time, fps) {
  return Math.round(time * fps) / fps;
}
