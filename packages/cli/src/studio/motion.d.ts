// FrankFrames — proprietário. Ver LICENSE na raiz.
// Tipos de motion.js (ESM puro servido ao navegador e importado pelo Node nos testes).
export interface PresetKey {
  type: "seconds" | "anchor" | "curve" | "number" | "int" | "distance" | "dir";
  default: number | string | null;
  min?: number;
  max?: number;
  values?: string[];
  doc: string;
}

/** Item de `GET /api/motion/presets`. */
export interface PresetItem {
  name: string;
  label: string;
  kind: string;
  dur: number;
  curve: string;
  fillsClip: boolean;
  keys: Record<string, PresetKey>;
}

export type MotionPresets = Record<string, PresetItem[]>;

export interface MotionEntry {
  raw: string;
  preset: string | null;
  params: Record<string, string>;
}

export interface MotionChange {
  attribute: string;
  value: string | null;
}

export function formatMotionAttr(preset: string, params: Record<string, string>, presets: PresetItem[]): string;
export function swapPreset(current: string | null | undefined, nextPreset: string | null, presets: PresetItem[]): string | null;
export function createPresetPicker(
  kind: string,
  presets: PresetItem[],
  value: string | null,
  onPick: (name: string | null) => void,
  options?: { disabled?: boolean; label?: string },
): HTMLElement;
export function renderMotionSection(
  container: HTMLElement,
  clip: { id: string; tag: string; editable?: boolean; motion?: Record<string, MotionEntry> },
  presets: MotionPresets,
  onChange: (change: MotionChange) => void,
): void;
