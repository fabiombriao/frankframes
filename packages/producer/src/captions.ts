// FrankFrames — proprietário. Ver LICENSE na raiz.
import { DEFAULT_STAGGER, loadComposition, parseMotionValue, presetsOf, splitText } from "@frankframes/contract";

export interface CaptionWord {
  start: number;
  end: number;
  word: string;
}

export interface CaptionSegment {
  start: number;
  end: number;
  text: string;
  /** Palavras com tempo: liga o modo karaokê. */
  words?: CaptionWord[];
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
  /** Cor da palavra já falada no karaokê. Padrão: #ffd400. */
  highlight?: string;
  /** Entrada (e saída) por palavra, via `data-split` (docs/contract.md §7b.8). */
  motion?: CaptionMotion;
}

/** Presets de motion das legendas: `"<preset> [chave=valor ...]"`, como em `data-enter`/`data-exit`. */
export interface CaptionMotion {
  enter: string;
  exit?: string;
}

interface CaptionPreset {
  name: string;
  params: Record<string, string>;
  /** Duração pedida pelo autor, ou a padrão do preset. */
  dur: number;
}

/** Lê `"<preset> [chave=valor ...]"` e falha alto se o preset não existir para aquele atributo. */
function captionPreset(kind: "enter" | "exit", raw: string): CaptionPreset {
  const parsed = parseMotionValue(raw);
  if (!parsed.ok) throw new Error(`legendas: motion ${kind} inválido (${parsed.message})`);
  const def = presetsOf(kind).find((preset) => preset.name === parsed.preset);
  if (def === undefined) {
    throw new Error(`legendas: preset ${JSON.stringify(parsed.preset)} não existe em data-${kind}; use um de: ${presetsOf(kind).map((preset) => preset.name).join(", ")}`);
  }
  const dur = parsed.params["dur"] === undefined ? def.dur : Number(parsed.params["dur"]);
  if (!Number.isFinite(dur) || dur <= 0) throw new Error(`legendas: dur inválido em motion ${kind}: ${JSON.stringify(parsed.params["dur"])}`);
  return { name: parsed.preset, params: parsed.params, dur };
}

/** Trunca em 3 casas (nunca arredonda para cima: o movimento não pode passar do fim da fala). */
const floor3 = (value: number): number => Math.floor(value * 1000 + 1e-9) / 1000;

/** `preset chave=valor` com `dur` trocado. */
function presetText(preset: CaptionPreset, dur: number): string {
  const params = { ...preset.params, dur: String(dur) };
  return [preset.name, ...Object.entries(params).map(([key, value]) => `${key}=${value}`)].join(" ");
}

interface FittedMotion {
  split: string;
  enter: string;
  exit?: string;
  /** Início da entrada de cada palavra com tempo, em segundos do clip (modo explícito). */
  anchors: number[];
}

/**
 * Ajusta o motion à fala: a duração nunca passa da fala, as palavras com tempo entram no instante em
 * que são ditas (stagger 0 e `data-unit`) e, sem palavras, o stagger encolhe até a última entrada
 * terminar em D. O que ainda não couber (mola curta demais, saída sem espaço) o contrato recusa.
 */
function fitMotion(motion: CaptionMotion, duration: number, wordStarts: number[], unitCount: number, label: string): FittedMotion {
  const enter = captionPreset("enter", motion.enter);
  const exit = motion.exit === undefined ? undefined : captionPreset("exit", motion.exit);
  const enterDur = floor3(Math.min(enter.dur, duration));
  if (enterDur <= 0) throw new Error(`legendas: ${label} dura ${duration}s, curto demais para animar`);

  let anchors: number[] = [];
  let stagger = 0;
  let enterEnd: number;
  if (wordStarts.length > 0) {
    const latest = floor3(duration - enterDur);
    anchors = wordStarts.map((start) => floor3(Math.min(Math.max(0, start), latest)));
    enterEnd = Math.max(...anchors) + enterDur;
  } else {
    stagger = unitCount > 1 ? floor3(Math.min(DEFAULT_STAGGER.word, (duration - enterDur) / (unitCount - 1))) : 0;
    enterEnd = Math.max(0, unitCount - 1) * stagger + enterDur;
  }

  let exitText: string | undefined;
  if (exit !== undefined) {
    const exitDur = floor3(Math.min(exit.dur, duration - enterEnd));
    if (exitDur <= 0) throw new Error(`legendas: ${label} não tem espaço para a saída; use uma entrada mais curta ou tire o exit`);
    exitText = presetText(exit, exitDur);
  }
  return { split: `word stagger=${stagger}`, enter: presetText(enter, enterDur), ...(exitText !== undefined ? { exit: exitText } : {}), anchors };
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
  // Proporcional à altura (16:9) e à largura (vertical): 1920×1080 → 59 px, 1080×1920 → 70 px.
  const baseFontSize = options.fontSize ?? Math.round(Math.min(height * 0.055, width * 0.065));
  const maxChars = options.maxCharsPerLine ?? Math.max(12, Math.round((width * 0.84) / (baseFontSize * 0.55)));
  const fontSize = baseFontSize;
  const bottom = options.bottom ?? Math.round(height * 0.08);

  const usable = segments
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .sort((a, b) => a.start - b.start);

  if (usable.length === 0) throw new Error("nenhum segmento válido para gerar legendas");

  const duration = Math.max(...usable.map((segment) => segment.end));
  const highlight = options.highlight ?? "#ffd400";
  const clips = usable
    .map((segment, index) => {
      const start = segment.start.toFixed(3);
      const length = (segment.end - segment.start).toFixed(3);
      const lines = wrapLines(segment.text, maxChars);
      const size = fitFontSize(lines, baseFontSize, maxChars, options.maxLines ?? 3);

      // Karaokê: cada palavra acende no seu instante. Como a animação CSS roda no
      // tempo do documento, o atraso é o `word.start` absoluto — o clip só fica
      // visível a partir do `data-start` do segmento.
      const words = (segment.words ?? []).filter((word) => Number.isFinite(word.start) && word.word.trim() !== "");
      const fitted =
        options.motion === undefined
          ? undefined
          : fitMotion(
              options.motion,
              Number(length),
              words.map((word) => word.start - segment.start),
              lines.reduce((sum, line) => sum + splitText(line, "word").filter((piece) => piece.unit).length, 0),
              `legenda ${index}`,
            );
      const body =
        words.length > 0
          ? words
              .map((word, i) => {
                const unit = fitted === undefined ? "" : ` data-unit="${fitted.anchors[i]!.toFixed(3)}"`;
                return `<span class="w"${unit} style="animation-delay:${Math.max(0, word.start).toFixed(3)}s">${escapeHtml(word.word.trim())}</span>`;
              })
              .join(" ")
          : lines.map((line) => escapeHtml(line)).join("<br>");
      const motionAttrs =
        fitted === undefined
          ? ""
          : ` data-split="${fitted.split}" data-enter="${escapeHtml(fitted.enter)}"${fitted.exit === undefined ? "" : ` data-exit="${escapeHtml(fitted.exit)}"`}`;

      return `    <div class="caption" data-clip-id="cap-${index}" data-start="${start}" data-duration="${length}"${motionAttrs} style="font-size:${size}px">${body}</div>`;
    })
    .join("\n");

  const html = `<!doctype html>
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
      /* Centraliza sem transform e sem left:50% (que limitaria a caixa a 50% do quadro) nem
         encolher: left/right 0 dão a largura disponível toda, e a caixa cresce até o max-width. */
      left: 0;
      right: 0;
      margin-inline: auto;
      bottom: ${bottom}px;
      box-sizing: border-box;
      width: fit-content;
      max-width: 84%;
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
    .w {
      color: rgba(255, 255, 255, 0.62);
      animation: k 1ms linear both;
      white-space: pre;
    }
    @keyframes k {
      to { color: ${highlight}; }
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

  // Com motion, o contrato confere o que foi gerado: legenda que não passa no lint não sai daqui.
  if (options.motion !== undefined) {
    const errors = loadComposition(html).diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) {
      throw new Error(`legendas com motion inválidas: ${errors.map((e) => `${e.code}: ${e.message}${e.hint === undefined ? "" : ` (${e.hint})`}`).join("; ")}`);
    }
  }
  return html;
}
