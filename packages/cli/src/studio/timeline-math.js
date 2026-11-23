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
 * Faixa `[start, start + length)` na escala da timeline, em px (`pps` pixels por segundo), cortada em `[0, total]`.
 * Serve à barra do clip, à faixa de transição e aos losangos, que usam a mesma régua.
 */
export function pxSpan(start, length, total, pps) {
  if (!(total > 0) || !(pps > 0)) return { left: 0, width: 0 };
  const left = Math.min(total, Math.max(0, start)) * pps;
  const right = Math.min(total, Math.max(0, start + length)) * pps;
  return { left, width: right - left };
}

/** Zoom máximo: 1 frame = 48 px. */
export const MAX_PX_PER_FRAME = 48;

/** Limites do zoom: de "ajustar" (`fitPps`) até 1 frame = 48 px. Nunca inverte se a composição for curta. */
export function clampZoom(pps, { fitPps, fps }) {
  const max = fps * MAX_PX_PER_FRAME;
  const min = Math.min(Math.max(fitPps, 0), max);
  return Math.min(max, Math.max(min, pps));
}

/**
 * Zoom ancorado: devolve o pps novo (`pps * factor`) e o `scrollLeft` que deixa `anchorTime` sob o ponteiro
 * (`pointerX` = px do ponteiro a partir da borda esquerda da área rolável), isto é,
 * `anchorTime * novoPps - scrollLeft` fica igual a `pointerX`.
 */
export function zoomAround(pps, factor, anchorTime, pointerX) {
  const next = pps * factor;
  return { pps: next, scrollLeft: Math.max(0, anchorTime * next - pointerX) };
}

/** Candidatos de passo em frames (nível de frame) e em segundos (nível de segundo): [maior, menor]. */
const FRAME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
const SECOND_STEPS = [
  [0.2, 0.1],
  [0.5, 0.1],
  [1, 0.2],
  [2, 0.5],
  [5, 1],
  [10, 2],
  [15, 5],
  [30, 5],
  [60, 10],
  [120, 30],
  [300, 60],
  [600, 120],
  [1800, 300],
  [3600, 600],
];
const MIN_MAJOR_PX = 80;
const MIN_MINOR_PX = 8;

/** Com `pps/fps >= 8` a régua marca frames (rótulo `ss:ff`). */
export function isFrameLevel(pps, fps) {
  return pps / fps >= MIN_MINOR_PX;
}

/**
 * Passos da régua, em segundos: `major` leva rótulo, `minor` só o traço. No nível de frame (`pps/fps >= 8`)
 * os dois são múltiplos de `1/fps`.
 */
export function chooseStep(pps, fps) {
  if (isFrameLevel(pps, fps)) {
    const framePx = pps / fps;
    const minor = FRAME_STEPS.find((frames) => frames * framePx >= MIN_MINOR_PX) ?? 1;
    const major = FRAME_STEPS.find((frames) => frames * framePx >= MIN_MAJOR_PX && frames % minor === 0) ?? FRAME_STEPS.at(-1);
    return { major: major / fps, minor: minor / fps };
  }
  const pair = SECOND_STEPS.find(([major]) => major * pps >= MIN_MAJOR_PX) ?? SECOND_STEPS.at(-1);
  const [major, minor] = pair;
  return { major, minor: minor * pps >= 6 ? minor : major };
}

/** Rótulo do tique: `ss:ff` no nível de frame, senão segundos (`1,5s`). */
export function tickLabel(time, fps, frameLevel) {
  if (!frameLevel) return String(Math.round(time * 100) / 100).replace(".", ",") + "s";
  const rate = Math.max(1, Math.round(fps));
  const frame = Math.round(time * fps);
  return Math.floor(frame / rate) + ":" + String(frame % rate).padStart(2, "0");
}

/** Recorte dos picos da fonte para um clip: de `offset` a `offset + duration * rate`, índice `floor(t * 100)`. */
export function peakSlice(waveform, offset, duration, rate) {
  const perSecond = waveform.peaksPerSecond;
  const from = Math.max(0, Math.floor(offset * perSecond));
  const to = Math.min(waveform.peaks.length, Math.floor((offset + duration * rate) * perSecond));
  return to > from ? waveform.peaks.slice(from, to) : [];
}
