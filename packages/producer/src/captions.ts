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
  const fontSize = options.fontSize ?? Math.round(height * 0.055);
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
      return `    <div class="caption" data-clip-id="cap-${index}" data-start="${start}" data-duration="${length}">${escapeHtml(segment.text.trim())}</div>`;
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
      padding: ${Math.round(fontSize * 0.28)}px ${Math.round(fontSize * 0.5)}px;
      background: rgba(0, 0, 0, 0.62);
      color: #ffffff;
      font-size: ${fontSize}px;
      font-weight: 600;
      line-height: 1.18;
      text-align: center;
      border-radius: ${Math.round(fontSize * 0.16)}px;
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
