// FrankFrames — proprietário. Ver LICENSE na raiz.
// Tipos de composition.js (ESM puro servido ao navegador e importado pelo Node nos testes).
export const PAST_END_CODE: "W_CLIP_PAST_END";
export type CompositionData = {
  durationKind?: "authored" | "derived" | "unresolved";
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | { num: number; den: number };
};
export type CompositionFields = { duration: string; derived: boolean; width: string; height: string; fps: string };
export type CompositionBody = { duration?: number | null; width?: number; height?: number; fps?: string };
export function fpsText(fps: CompositionData["fps"]): string;
export function compositionFields(data: CompositionData): CompositionFields;
export function compositionPatch(data: CompositionData, fields: CompositionFields): { body: CompositionBody | null; error: string | null };
export type PastEndNotice = { count: number; ids: string[]; message: string; hint: string };
export function pastEndNotice(diagnostics: unknown): PastEndNotice | null;
