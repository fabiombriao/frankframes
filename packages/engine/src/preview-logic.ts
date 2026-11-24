// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Lógica pura da barra do preview (EDT-85). Sem DOM: o Node testa estas funções e `preview-ui.ts` as injeta na
 * página pelo `toString()`. Por isso cada uma é autocontida (nada de import, constante de módulo ou helper externo).
 */

/**
 * Frame sob o ponteiro. `left` e `width` são a caixa da barra, na mesma unidade de `clientX`. As pontas valem
 * `max(12, 1% da largura)` px: dentro da esquerda é sempre o frame 0, dentro da direita sempre o último
 * (`total - 1`); entre elas o mapa é linear e arredondado ao frame mais próximo.
 */
export function frameFromPointer(clientX: number, left: number, width: number, total: number): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !(width > 0) || !Number.isInteger(total) || total < 1) {
    throw new TypeError("frameFromPointer: ponteiro, caixa ou total de frames inválidos: " + [clientX, left, width, total].join(", "));
  }
  const last = total - 1;
  const zone = Math.min(Math.max(12, width * 0.01), width / 4);
  const x = clientX - left;
  if (x <= zone) return 0;
  if (x >= width - zone) return last;
  return Math.round(((x - zone) / (width - 2 * zone)) * last);
}

/** Estado de transporte ao abrir a página do preview. */
export interface TransportEntry {
  /** Instante salvo na sessão (ms), ou `null` se não há. */
  savedMs: number | null;
  /** Estado de play salvo (`true` tocando, `false` parado), ou `null` se não há. */
  savedPlaying: boolean | null;
  /** A página foi aberta por recarga (`location.reload()`/F5), e não por navegação nova. */
  isReload: boolean;
  /** `false` (Studio): a abertura fica pausada no 0; só a recarga restaura o estado salvo. */
  autoplay: boolean;
}

/**
 * Tocando ou parado, e em que instante, quando a página abre. Com `autoplay` (preview avulso) toca sempre, a não ser
 * que o estado salvo diga "parado". Sem `autoplay` (Studio) a abertura é pausada em 0, e a recarga restaura o que foi salvo.
 */
export function initialTransport(entry: TransportEntry): { playing: boolean; ms: number } {
  const ms = entry.savedMs === null ? 0 : entry.savedMs;
  if (entry.autoplay) {
    if (entry.savedMs !== null && entry.savedPlaying === false) return { playing: false, ms };
    return { playing: true, ms };
  }
  if (!entry.isReload) return { playing: false, ms: 0 };
  return { playing: entry.savedPlaying === true, ms };
}
