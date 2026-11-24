// FrankFrames — proprietário. Ver LICENSE na raiz.
// Tipos de player-fit.js (ESM puro servido ao navegador e importado pelo Node nos testes).
export const DEFAULT_PLAYER_WIDTH: 1920;
export const DEFAULT_PLAYER_HEIGHT: 1080;
export type PlayerViewport = { width: number; height: number };
export function playerViewport(composition: { width?: number | null; height?: number | null } | null | undefined): PlayerViewport;
export type PlayerBox = { scale: number; frameWidth: number; frameHeight: number; left: number; top: number };
export function fitPlayerBox(available: PlayerViewport, viewport: PlayerViewport): PlayerBox;
