// FrankFrames — proprietário. Ver LICENSE na raiz.
export interface CaptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface CaptionOptions {
  width?: number;
  height?: number;
  fps?: number;
  font?: string;
  fontSize?: number;
  /** Safra: margem inferior em pixels. */
  bottom?: number;
  /** Caracteres por linha; padrão derivado da largura útil e do tamanho da fonte. */
  maxCharsPerLine?: number;
  /** Acima disso, a fonte encolhe em degraus. Padrão: 3. */
  maxLines?: number;
}

/**
 * Quebra o texto em linhas equilibradas: menos linhas, sem palavra órfã.
 * Não parte palavra — se uma palavra sozinha estoura, ela fica na linha.
 */
export function wrapLines(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length <= maxChars || current === "") current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** Fonte que cabe em até `maxLines` linhas sem passar da largura útil. */
export function fitFontSize(lines: string[], base: number, maxChars: number, maxLines = 3): number {
  const ratios = lines.map((line) => Math.min(1, maxChars / Math.max(1, line.length)));
  const widthPressure = ratios.length === 0 ? 1 : Math.min(...ratios);
  const heightPressure = lines.length <= maxLines ? 1 : maxLines / lines.length;
  return Math.round(base * Math.max(0.55, widthPressure * heightPressure));
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/**
 * Transforma segmentos de transcrição numa composição de legendas: um clip por
 * segmento, com `data-start`/`data-duration` exatos e texto escapado.
 */
export function buildCaptionComposition(segments: CaptionSegment[], options: CaptionOptions = {}): string {
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const fps = options.fps ?? 30;
  const font = options.font ?? "Inter";
  const baseFontSize = options.fontSize ?? Math.round(height * 0.055);
  const maxChars = options.maxCharsPerLine ?? Math.max(12, Math.round((width * 0.84) / (baseFontSize * 0.55)));
  const fontSize = baseFontSize;
  const bottom = options.bottom ?? Math.round(height * 0.08);

  const usable = segments
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .sort((a, b) => a.start - b.start);

  if (usable.length === 0) throw new Error("nenhum segmento válido para gerar legendas");

  const duration = Math.max(...usable.map((segment) => segment.end));
  const clips = usable
    .map((segment, index) => {
      const start = segment.start.toFixed(3);
      const length = (segment.end - segment.start).toFixed(3);
      const lines = wrapLines(segment.text, maxChars);
      const size = fitFontSize(lines, baseFontSize, maxChars, options.maxLines ?? 3);
      const body = lines.map((line) => escapeHtml(line)).join("<br>");
      return `    <div class="caption" data-clip-id="cap-${index}" data-start="${start}" data-duration="${length}" style="font-size:${size}px">${body}</div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>legendas</title>
  <style>
    html, body { margin: 0; background: transparent; }
    #stage {
      position: relative;
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      font-family: "${font}", sans-serif;
    }
    .caption {
      position: absolute;
      left: 50%;
      bottom: ${bottom}px;
      transform: translateX(-50%);
      max-width: ${Math.round(width * 0.84)}px;
      padding: ${Math.round(baseFontSize * 0.28)}px ${Math.round(baseFontSize * 0.5)}px;
      background: rgba(0, 0, 0, 0.62);
      color: #ffffff;
      font-size: ${baseFontSize}px;
      font-weight: 600;
      white-space: normal;
      line-height: 1.18;
      text-align: center;
      border-radius: ${Math.round(baseFontSize * 0.16)}px;
    }
  </style>
</head>
<body>
  <div id="stage" data-composition-id="legendas" data-root="true"
       data-width="${width}" data-height="${height}" data-fps="${fps}" data-duration="${duration.toFixed(3)}">
${clips}
  </div>
</body>
</html>
`;
}
