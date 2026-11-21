// FrankFrames — proprietário. Ver LICENSE na raiz.
// Tipos de timeline-math.js (ESM puro servido ao navegador e importado pelo Node nos testes).
export function frameCount(total: number, fps: number): number;
export function lastFrameTime(total: number, fps: number): number;
export function roundToFrame(time: number, fps: number): number;
export function percentSpan(start: number, length: number, total: number): { left: number; width: number };
