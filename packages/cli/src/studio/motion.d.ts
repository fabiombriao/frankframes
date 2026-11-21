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

export const DEFAULT_TRANSITION_DUR: number;

export interface TransitionEntry extends MotionEntry {
  /** Sobreposição com o clip anterior, em segundos (`null` se `data-start` não for referência negativa). */
  dur: number | null;
  /** Id do clip A referenciado em `data-start`, ou `null`. */
  partner: string | null;
}

export interface TransitionChange {
  preset: string | null;
  dur?: number;
  params?: Record<string, string>;
}

export interface TransitionClip {
  id: string;
  tag: string;
  start: number | null;
  end: number | null;
  parentId: string | null;
  editable?: boolean;
  motion?: Record<string, MotionEntry | TransitionEntry>;
}

export function transitionPartner(clips: TransitionClip[], clip: TransitionClip): TransitionClip | null;
export function transitionParams(preset: string, params: Record<string, string>, presets: PresetItem[]): Record<string, string>;
export function renderTransitionSection(
  container: HTMLElement,
  clip: TransitionClip,
  clips: TransitionClip[],
  presets: MotionPresets,
  onChange: (change: TransitionChange) => void,
): void;

export interface KeyframePointData {
  time: number;
  curve?: string;
  [prop: string]: number | string | undefined;
}

export interface KeyframeClip {
  id: string;
  tag: string;
  start: number | null;
  duration: number | null;
  hasAudio?: boolean;
  editable?: boolean;
  keyframes?: KeyframePointData[] | null;
  descendantKeyframeTimes?: number[];
}

export interface KeyframeMark {
  time: number;
  x: number;
  props: string[];
  curve: string | null;
  readOnly: boolean;
}

export interface KeyframeChange {
  time: number;
  prop?: string;
  value?: number | string;
  curve?: string | null;
}

export const KEYFRAME_PROPS: Array<{ prop: string; label: string; camera?: true }>;
export const KEYFRAME_CURVES: string[];
export function keyframePropsFor(clip: Pick<KeyframeClip, "tag" | "hasAudio">): Array<{ prop: string; label: string }>;
export function parseKeyframeValue(prop: string, text: string): number | string | null;
export function keyframeMarks(
  clip: Pick<KeyframeClip, "keyframes" | "descendantKeyframeTimes">,
  timeToX: (time: number) => number,
): KeyframeMark[];
export function renderKeyframeSection(
  container: HTMLElement,
  clip: KeyframeClip,
  options: {
    playhead: number;
    selected: number | null;
    prop: string;
    onProp: (prop: string) => void;
    onAdd: (prop: string) => void;
    onSelect: (time: number | null) => void;
    onEdit: (change: KeyframeChange) => void;
    onRemove: (time: number) => void;
  },
): void;
