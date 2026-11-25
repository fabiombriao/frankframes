// FrankFrames — proprietário. Ver LICENSE na raiz.
// Tipos de inspector.js (ESM puro servido ao navegador e importado pelo Node nos testes).
export function displayNumber(value: number | null | undefined): string;
export function captionFrame(seconds: number, fps: { num: number; den: number }): number;
export function activeCueIndex(cues: ReadonlyArray<{ start: number; end: number }>, local: number): number;
export type NumericEntry = { key: string; shown: string; text: string; original: number | null };
export function numericChanges(entries: NumericEntry[]): { attributes: Record<string, string | null>; errors: string[] };
