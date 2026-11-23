// FrankFrames — proprietário. Ver LICENSE na raiz.
// Tipos de timeline-math.js (ESM puro servido ao navegador e importado pelo Node nos testes).
export function frameCount(total: number, fps: number): number;
export function lastFrameTime(total: number, fps: number): number;
export function roundToFrame(time: number, fps: number): number;
export function pxSpan(start: number, length: number, total: number, pps: number): { left: number; width: number };
export const MAX_PX_PER_FRAME: number;
export function clampZoom(pps: number, limits: { fitPps: number; fps: number }): number;
export function zoomAround(pps: number, factor: number, anchorTime: number, pointerX: number): { pps: number; scrollLeft: number };
export function isFrameLevel(pps: number, fps: number): boolean;
export function chooseStep(pps: number, fps: number): { major: number; minor: number };
export function tickLabel(time: number, fps: number, frameLevel: boolean): string;
export function peakSlice(waveform: { peaksPerSecond: number; peaks: number[] }, offset: number, duration: number, rate: number): number[];
