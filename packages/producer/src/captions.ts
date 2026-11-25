// FrankFrames — proprietário. Ver LICENSE na raiz.
import { DEFAULT_STAGGER, loadComposition, parseMotionValue, presetsOf, splitText, springMinSeconds } from "@frankframes/contract";
import type { PresetDef } from "@frankframes/contract";

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
  /** Cor da palavra que está sendo falada no karaokê. Padrão: #ffd400. */
  highlight?: string;
  /** Karaokê: palavras por legenda, no máximo. Padrão: 4. A duração mínima da legenda vence: juntar pode passar disso. */
  maxWords?: number;
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
  def: PresetDef;
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
  return { name: parsed.preset, def, params: parsed.params, dur };
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

/** Segmentos que viram clip: tempos finitos e duração positiva. */
const usableSegments = (segments: CaptionSegment[]): CaptionSegment[] =>
  segments.filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start);

/** Palavras que ligam o karaokê num segmento; sem nenhuma, ele sai por frase. */
const karaokeWords = (segment: CaptionSegment): CaptionWord[] =>
  (segment.words ?? []).filter((word) => Number.isFinite(word.start) && word.word.trim() !== "");

/** Quantas palavras a composição acende em karaokê; 0 = legenda inteira por frase. */
export function countKaraokeWords(segments: CaptionSegment[]): number {
  return usableSegments(segments).reduce((sum, segment) => sum + karaokeWords(segment).length, 0);
}

const DEFAULT_MAX_WORDS = 4;
/** Pausa entre duas palavras que, quando passada, abre legenda nova (segundos). */
const PAUSE_BREAK = 0.35;
const PUNCTUATION_BREAK = /[.,?!;:]$/;
/** Menos que isto na tela não dá para ler (segundos). */
const MIN_CUE = 0.4;

/** Duração mínima de uma legenda: a de leitura ou, se maior, o que as molas da entrada e da saída precisam. */
function minCueSeconds(motion: CaptionMotion | undefined): number {
  if (motion === undefined) return MIN_CUE;
  const need = (kind: "enter" | "exit", raw: string): number => {
    const preset = captionPreset(kind, raw);
    return springMinSeconds(preset.def, preset.params["curve"]);
  };
  const exit = motion.exit === undefined ? 0 : need("exit", motion.exit);
  return Math.max(MIN_CUE, need("enter", motion.enter) + exit);
}

const toMs = (seconds: number): number => Math.round(seconds * 1000);

/** Uma legenda na tela, que vira um clip. Sem `words`, é o segmento inteiro, por frase. */
interface Cue {
  start: number;
  end: number;
  text: string;
  words: CaptionWord[];
}

/**
 * Divide um segmento com palavras em legendas curtas, encadeadas: cada uma acaba onde a seguinte começa, na
 * primeira palavra dela; palavras no mesmo instante ficam juntas. Depois, legenda abaixo de `minSeconds` é
 * juntada à seguinte (a última, à anterior), mesmo passando de `maxWords`; isso também desfaz as que ficariam sem
 * duração (palavra que começa fora do segmento).
 */
function segmentCues(segment: CaptionSegment, maxWords: number, minSeconds: number): Cue[] {
  const words = karaokeWords(segment).sort((a, b) => a.start - b.start);
  if (words.length === 0) return [{ start: segment.start, end: segment.end, text: segment.text, words }];

  // Bordas em milissegundos inteiros: `data-start + data-duration` fecha exato no início da legenda seguinte.
  const endMs = toMs(segment.end);
  const groups = [{ startMs: toMs(segment.start), words: [words[0]!] }];
  for (let i = 1; i < words.length; i++) {
    const previous = words[i - 1]!;
    const word = words[i]!;
    const group = groups[groups.length - 1]!;
    const wanted =
      group.words.length >= maxWords ||
      PUNCTUATION_BREAK.test(previous.word.trim()) ||
      word.start - previous.end > PAUSE_BREAK + 1e-9;
    const cutMs = toMs(word.start);
    if (wanted && cutMs > group.startMs) groups.push({ startMs: cutMs, words: [word] });
    else group.words.push(word);
  }
  // Segmento inteiro abaixo do mínimo acaba como uma legenda só; o motion que não couber, o contrato recusa.
  const minMs = Math.ceil(minSeconds * 1000 - 1e-6);
  for (let i = 0; i < groups.length && groups.length > 1; ) {
    if ((groups[i + 1]?.startMs ?? endMs) - groups[i]!.startMs >= minMs) {
      i++;
      continue;
    }
    if (i === groups.length - 1) i--;
    groups[i]!.words.push(...groups[i + 1]!.words);
    groups.splice(i + 1, 1);
  }
  return groups.map((group, i) => ({
    start: group.startMs / 1000,
    end: (groups[i + 1]?.startMs ?? endMs) / 1000,
    text: group.words.map((word) => word.word.trim()).join(" "),
    words: group.words,
  }));
}

/**
 * Transforma segmentos de transcrição numa composição de legendas com `data-start`/`data-duration` exatos
 * e texto escapado: um clip por segmento ou, com tempo por palavra, legendas curtas (`segmentCues`).
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

  const maxWords = options.maxWords ?? DEFAULT_MAX_WORDS;
  if (!Number.isInteger(maxWords) || maxWords < 1) {
    throw new Error(`legendas: maxWords precisa ser um inteiro maior ou igual a 1 (veio ${maxWords})`);
  }

  const usable = usableSegments(segments).sort((a, b) => a.start - b.start);

  if (usable.length === 0) throw new Error("nenhum segmento válido para gerar legendas");

  const duration = Math.max(...usable.map((segment) => segment.end));
  const highlight = options.highlight ?? "#ffd400";
  const minSeconds = minCueSeconds(options.motion);
  const clips = usable
    .flatMap((segment) => segmentCues(segment, maxWords, minSeconds))
    .map((cue, index) => {
      const start = cue.start.toFixed(3);
      const length = (cue.end - cue.start).toFixed(3);
      const lines = wrapLines(cue.text, maxChars);
      const size = fitFontSize(lines, baseFontSize, maxChars, options.maxLines ?? 3);

      // Karaokê: cada palavra fica acesa do seu início até o da palavra seguinte (a última, até o fim
      // da legenda). Como a animação CSS roda no tempo do documento, o atraso é o `word.start` absoluto.
      const words = cue.words;
      const fitted =
        options.motion === undefined
          ? undefined
          : fitMotion(
              options.motion,
              Number(length),
              words.map((word) => word.start - cue.start),
              lines.reduce((sum, line) => sum + splitText(line, "word").filter((piece) => piece.unit).length, 0),
              `legenda ${index}`,
            );
      const body =
        words.length > 0
          ? words
              .map((word, i) => {
                const unit = fitted === undefined ? "" : ` data-unit="${fitted.anchors[i]!.toFixed(3)}"`;
                const fromMs = toMs(Math.max(0, word.start));
                const untilMs = toMs(words[i + 1]?.start ?? cue.end);
                const timing = `animation-delay:${(fromMs / 1000).toFixed(3)}s;animation-duration:${(Math.max(0, untilMs - fromMs) / 1000).toFixed(3)}s`;
                return `<span class="w"${unit} style="${timing}">${escapeHtml(word.word.trim())}</span>`;
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
    /* Destaque só durante a fala: branca antes (sem fill para trás), destaque no intervalo e branca de novo
       pelo fill forwards. Não troque por fill none: a animação terminada sai de document.getAnimations(), o
       relógio deixa de movê-la e um seek para trás não reacende a palavra. */
    .w {
      color: #fff;
      animation-name: hl;
      animation-timing-function: step-end;
      animation-fill-mode: forwards;
      white-space: pre;
    }
    @keyframes hl {
      from { color: ${highlight}; }
      to { color: #fff; }
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
