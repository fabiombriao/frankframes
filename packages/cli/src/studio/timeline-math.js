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

/**
 * Faixa `[start, start + length)` na escala da timeline, em % da largura (0–100), cortada nas bordas.
 * Serve à barra do clip e à faixa de transição, que usam a mesma régua.
 */
export function percentSpan(start, length, total) {
  if (!(total > 0)) return { left: 0, width: 0 };
  const left = Math.min(100, Math.max(0, (start / total) * 100));
  const right = Math.min(100, Math.max(0, ((start + length) / total) * 100));
  return { left, width: right - left };
}
