// FrankFrames — proprietário. Ver LICENSE na raiz.
import { parse } from "parse5";
import { DEFAULT_STAGGER, loadComposition, parseMotionValue, presetsOf, splitText, springMinSeconds } from "@frankframes/contract";
import type { PresetDef } from "@frankframes/contract";
import { EditError } from "./edit.ts";

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

/** Nome da `<meta>` que guarda as opções de layout de um arquivo de legendas (docs/contract.md §7b.8). */
const CAPTIONS_META = "frankframes:captions";

/** Opções de layout já resolvidas: com elas uma legenda é redesenhada igual à da geração. */
export interface CaptionLayout {
  v: 1;
  width: number;
  height: number;
  /** Fonte base, antes do encolhimento por legenda. */
  fontSize: number;
  maxChars: number;
  maxLines: number;
  bottom: number;
  highlight: string;
  maxWords: number;
  motion?: CaptionMotion;
}

/** Uma palavra do karaokê já com os tempos que vão para o arquivo. */
export interface TimedWord {
  word: string;
  /** Instante da fala a partir do início da legenda (s): âncora do motion. */
  at: number;
  /** Início e duração do destaque, em ms inteiros; o arquivo guarda o início e o fim, como dois `animation-delay`. */
  fromMs: number;
  forMs: number;
}

/** Uma legenda pronta para desenhar; `start` e `duration` são os textos de `data-start`/`data-duration`. */
export interface CueSource {
  id: string;
  start: string;
  duration: string;
  text: string;
  /** Vazio = legenda por frase. */
  words: TimedWord[];
}

const cssSeconds = (ms: number): string => `${(ms / 1000).toFixed(3)}s`;

/** O elemento de uma legenda, sem recuo. Geração e edição passam por aqui. */
export function renderCue(cue: CueSource, layout: Pick<CaptionLayout, "fontSize" | "maxChars" | "maxLines" | "motion">): string {
  const lines = wrapLines(cue.text, layout.maxChars);
  const size = fitFontSize(lines, layout.fontSize, layout.maxChars, layout.maxLines);
  const { words } = cue;
  const fitted =
    layout.motion === undefined
      ? undefined
      : fitMotion(
          layout.motion,
          Number(cue.duration),
          words.map((word) => word.at),
          lines.reduce((sum, line) => sum + splitText(line, "word").filter((piece) => piece.unit).length, 0),
          `legenda ${cue.id}`,
        );
  const body =
    words.length > 0
      ? words
          .map((word, i) => {
            const unit = fitted === undefined ? "" : ` data-unit="${fitted.anchors[i]!.toFixed(3)}"`;
            // Início e fim (§7b.8): em palavras encadeadas, o fim de uma é o mesmo texto do início da seguinte.
            const timing = `animation-delay:${cssSeconds(word.fromMs)},${cssSeconds(word.fromMs + word.forMs)}`;
            return `<span class="w"${unit} style="${timing}">${escapeHtml(word.word)}</span>`;
          })
          .join(" ")
      : lines.map((line) => escapeHtml(line)).join("<br>");
  const motionAttrs =
    fitted === undefined
      ? ""
      : ` data-split="${fitted.split}" data-enter="${escapeHtml(fitted.enter)}"${fitted.exit === undefined ? "" : ` data-exit="${escapeHtml(fitted.exit)}"`}`;
  return `<div class="caption" data-clip-id="${escapeHtml(cue.id)}" data-start="${cue.start}" data-duration="${cue.duration}"${motionAttrs} style="font-size:${size}px">${body}</div>`;
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
  const layout: CaptionLayout = {
    v: 1,
    width,
    height,
    fontSize: baseFontSize,
    maxChars,
    maxLines: options.maxLines ?? 3,
    bottom,
    highlight,
    maxWords,
    ...(options.motion === undefined ? {} : { motion: options.motion }),
  };
  const clips = usable
    .flatMap((segment) => segmentCues(segment, maxWords, minSeconds))
    .map((cue, index) => {
      // Karaokê: cada palavra fica acesa do seu início até o da palavra seguinte (a última, até o fim
      // da legenda). Como a animação CSS roda no tempo do documento, o atraso é o `word.start` absoluto.
      const words = cue.words.map((word, i): TimedWord => {
        const fromMs = toMs(Math.max(0, word.start));
        const untilMs = toMs(cue.words[i + 1]?.start ?? cue.end);
        return { word: word.word.trim(), at: word.start - cue.start, fromMs, forMs: Math.max(0, untilMs - fromMs) };
      });
      const source = { id: `cap-${index}`, start: cue.start.toFixed(3), duration: (cue.end - cue.start).toFixed(3), text: cue.text, words };
      return `    ${renderCue(source, layout)}`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="${CAPTIONS_META}" content='${escapeHtml(JSON.stringify(layout))}'>
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
    /* Destaque só durante a fala, em dois instantes sem duração: hl-on acende no 1º animation-delay do span e
       hl-off apaga no 2º (a última da lista vence); antes do 1º não há fill, e a palavra é branca. O fim de uma
       palavra é o mesmo texto do início da seguinte: o Chrome faz a mesma comparação e as duas trocam juntas.
       Não volte a animation-duration: a conta do progresso parava em 0,999… no instante da troca e acendia duas.
       Não troque forwards por none: a animação terminada sai de document.getAnimations(), o relógio deixa de
       movê-la e um seek para trás não reacende a palavra. */
    .w {
      color: #fff;
      animation-name: hl-on, hl-off;
      animation-duration: 0s;
      animation-fill-mode: forwards;
      white-space: pre;
    }
    @keyframes hl-on {
      to { color: ${highlight}; }
    }
    @keyframes hl-off {
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

interface HtmlNode {
  nodeName: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  sourceCodeLocation?: { startOffset: number; endOffset: number; endTag?: unknown } | null;
}

const attributeOf = (node: HtmlNode, name: string): string | undefined => node.attrs?.find((item) => item.name === name)?.value;

function* elementsOf(node: HtmlNode): Generator<HtmlNode> {
  for (const child of node.childNodes ?? []) {
    yield child;
    yield* elementsOf(child);
  }
  if (node.content !== undefined) yield* elementsOf(node.content);
}

const textOf = (node: HtmlNode): string => (node.nodeName === "#text" ? (node.value ?? "") : (node.childNodes ?? []).map(textOf).join(""));

const unreadable = (message: string): EditError => new EditError("E_CAPTIONS_LEGACY", message, "gere de novo com frankframes captions");

const captionsMetaOf = (document: HtmlNode): HtmlNode | undefined => {
  for (const node of elementsOf(document)) if (node.nodeName === "meta" && attributeOf(node, "name") === CAPTIONS_META) return node;
  return undefined;
};

/** Diz se o HTML é um arquivo de legendas (tem a meta), sem conferir o conteúdo. */
export function hasCaptionMeta(html: string): boolean {
  return captionsMetaOf(parse(html) as unknown as HtmlNode) !== undefined;
}

function readLayout(raw: string): CaptionLayout {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw unreadable(`a meta ${CAPTIONS_META} não é um JSON válido: ${(error as Error).message}`);
  }
  const layout = (typeof value === "object" && value !== null ? value : {}) as Partial<CaptionLayout>;
  const positive = (item: unknown): boolean => typeof item === "number" && Number.isFinite(item) && item > 0;
  const motion = layout.motion as Partial<CaptionMotion> | undefined;
  if (
    layout.v !== 1 ||
    ![layout.width, layout.height, layout.fontSize, layout.maxChars, layout.maxLines, layout.maxWords].every(positive) ||
    !Number.isFinite(layout.bottom) ||
    typeof layout.highlight !== "string" ||
    (motion !== undefined && (typeof motion?.enter !== "string" || (motion.exit !== undefined && typeof motion.exit !== "string")))
  ) {
    throw unreadable(`a meta ${CAPTIONS_META} não está no formato v: 1`);
  }
  return layout as CaptionLayout;
}

/** Palavra como está no arquivo; `unit` é o `data-unit` gravado (com motion). */
type StoredWord = Omit<TimedWord, "at"> & { unit?: number };

interface StoredCue {
  id: string;
  start: string;
  duration: string;
  text: string;
  /** `null` = legenda por frase. */
  words: StoredWord[] | null;
  /** Posição do elemento inteiro no arquivo. */
  startOffset: number;
  endOffset: number;
}

const SECONDS = /^\d+(\.\d+)?$/;

/** `animation-delay:<início>s,<fim>s`. O formato antigo (um delay mais `animation-duration`) não é lido. */
const WORD_TIMING = /(?:^|;)\s*animation-delay:\s*(\d+(?:\.\d+)?)s\s*,\s*(\d+(?:\.\d+)?)s\s*(?:;|$)/;

function readTiming(style: string, id: string): { fromMs: number; forMs: number } {
  const found = WORD_TIMING.exec(style);
  if (found === null) throw unreadable(`legenda ${id}: palavra sem o início e o fim em animation-delay (formato antigo ou mexido)`);
  const fromMs = toMs(Number(found[1]));
  const forMs = toMs(Number(found[2])) - fromMs;
  if (forMs < 0) throw unreadable(`legenda ${id}: o fim de uma palavra vem antes do início dela`);
  return { fromMs, forMs };
}

function readCue(node: HtmlNode, id: string): StoredCue {
  const start = attributeOf(node, "data-start") ?? "";
  const duration = attributeOf(node, "data-duration") ?? "";
  if (!SECONDS.test(start) || !SECONDS.test(duration)) throw unreadable(`legenda ${id}: data-start e data-duration precisam ser números`);
  const location = node.sourceCodeLocation;
  if (!location || !location.endTag) throw unreadable(`legenda ${id}: elemento sem tag de fechamento`);
  const spans: HtmlNode[] = [];
  let text = "";
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === "#text") text += child.value ?? "";
    else if (child.nodeName === "br") text += " ";
    else if (child.nodeName === "span" && attributeOf(child, "class") === "w") {
      spans.push(child);
      text += textOf(child);
    } else throw unreadable(`legenda ${id}: elemento <${child.nodeName}> fora do formato gerado`);
  }
  const words =
    spans.length === 0
      ? null
      : spans.map((span) => {
          const style = attributeOf(span, "style") ?? "";
          const unit = attributeOf(span, "data-unit");
          if (unit !== undefined && !SECONDS.test(unit)) throw unreadable(`legenda ${id}: data-unit precisa ser um número`);
          return {
            word: textOf(span),
            ...readTiming(style, id),
            ...(unit === undefined ? {} : { unit: Number(unit) }),
          };
        });
  return {
    id,
    start,
    duration,
    text: (words === null ? text : words.map((word) => word.word).join(" ")).replace(/\s+/g, " ").trim(),
    words,
    startOffset: location.startOffset,
    endOffset: location.endOffset,
  };
}

function parseCaptions(html: string): { options: CaptionLayout; cues: StoredCue[] } {
  const document = parse(html, { sourceCodeLocationInfo: true }) as unknown as HtmlNode;
  const meta = captionsMetaOf(document);
  if (meta === undefined) throw unreadable(`arquivo sem a meta ${CAPTIONS_META}: não são legendas editáveis (versão antiga ou outro arquivo)`);
  const options = readLayout(attributeOf(meta, "content") ?? "");
  const cues: StoredCue[] = [];
  const seen = new Set<string>();
  for (const node of elementsOf(document)) {
    if (node.nodeName !== "div" || !(attributeOf(node, "class") ?? "").split(/\s+/).includes("caption")) continue;
    const id = attributeOf(node, "data-clip-id");
    if (id === undefined || seen.has(id)) throw unreadable(id === undefined ? "legenda sem data-clip-id" : `data-clip-id repetido nas legendas: ${id}`);
    seen.add(id);
    cues.push(readCue(node, id));
  }
  return { options, cues };
}

/** Legenda lida de um arquivo; tempos em segundos da própria sub-composição. */
export interface CaptionCue {
  id: string;
  start: number;
  end: number;
  text: string;
  /** `null` = legenda por frase. */
  words: CaptionWord[] | null;
}

export function readCaptionFile(html: string): { options: CaptionLayout; cues: CaptionCue[] } {
  const { options, cues } = parseCaptions(html);
  return {
    options,
    cues: cues.map((cue) => ({
      id: cue.id,
      start: Number(cue.start),
      end: (toMs(Number(cue.start)) + toMs(Number(cue.duration))) / 1000,
      text: cue.text,
      words: cue.words?.map((word) => ({ start: word.fromMs / 1000, end: (word.fromMs + word.forMs) / 1000, word: word.word })) ?? null,
    })),
  };
}

/**
 * Reparte `[fromMs, endMs]` entre as palavras pelo número de caracteres: milissegundos inteiros, encadeados,
 * cada palavra com pelo menos 1 ms.
 */
function spreadWords(tokens: string[], fromMs: number, endMs: number): StoredWord[] {
  const total = endMs - fromMs;
  if (total < tokens.length) {
    throw new EditError("E_ATTRIBUTE_INVALID", `o trecho trocado não tem tempo para ${tokens.length} palavras (${Math.max(0, total)} ms)`, "use menos palavras no trecho trocado");
  }
  const sizes = tokens.map((token) => [...token].length);
  const characters = sizes.reduce((sum, size) => sum + size, 0);
  const edges = [fromMs];
  let before = 0;
  for (let i = 1; i < tokens.length; i++) {
    before += sizes[i - 1]!;
    const wanted = fromMs + Math.round((total * before) / characters);
    edges.push(Math.min(Math.max(wanted, edges[i - 1]! + 1), endMs - (tokens.length - i)));
  }
  edges.push(endMs);
  return tokens.map((word, i) => ({ word, fromMs: edges[i]!, forMs: edges[i + 1]! - edges[i]! }));
}

/**
 * Tempos do texto novo. Mesma quantidade de palavras: cada uma fica com os seus. Outra quantidade: as iguais no
 * começo e no fim mantêm os tempos e o miolo novo reparte o intervalo do miolo antigo. Com um dos miolos vazio
 * (só inserção ou só remoção), a vizinha anterior entra nos dois; sem anterior, a seguinte.
 */
function retimeWords(old: StoredWord[], tokens: string[]): StoredWord[] {
  if (tokens.length === old.length) return old.map((word, i) => ({ ...word, word: tokens[i]! }));
  const shorter = Math.min(old.length, tokens.length);
  let head = 0;
  while (head < shorter && old[head]!.word === tokens[head]) head++;
  let tail = 0;
  while (tail < shorter - head && old[old.length - 1 - tail]!.word === tokens[tokens.length - 1 - tail]) tail++;
  if (head + tail === shorter) {
    if (head > 0) head--;
    else tail--;
  }
  const replaced = old.slice(head, old.length - tail);
  const first = replaced[0]!;
  const last = replaced.at(-1)!;
  const spread = spreadWords(tokens.slice(head, tokens.length - tail), first.fromMs, last.fromMs + last.forMs).map(
    // A âncora gravada continua valendo para o instante que não mudou: o início do trecho.
    (word, i): StoredWord => (i === 0 && first.unit !== undefined ? { ...word, unit: first.unit } : word),
  );
  return [...old.slice(0, head), ...spread, ...old.slice(old.length - tail)];
}

/**
 * Troca o texto de uma legenda e devolve o arquivo com só aquele elemento redesenhado (por posição; o resto fica
 * byte a byte). Os tempos das palavras são os de `retimeWords`.
 */
export function editCaptionText(html: string, cueId: string, text: string): string {
  const { options, cues } = parseCaptions(html);
  const cue = cues.find((item) => item.id === cueId);
  if (cue === undefined) {
    throw new EditError("E_CAPTIONS_CUE_NOT_FOUND", `legenda não encontrada: ${cueId}`, "recarregue a lista de legendas: o arquivo pode ter sido gerado de novo");
  }
  const tokens = text.trim().split(/\s+/).filter((token) => token !== "");
  if (tokens.length === 0) throw new EditError("E_ATTRIBUTE_INVALID", `a legenda ${cueId} não pode ficar vazia`, "escreva o texto da legenda");
  // A âncora gravada vale: a geração a calculou com a fala sem arredondar, e refazê-la dos ms erraria por 1 ms.
  const words: TimedWord[] =
    cue.words === null
      ? []
      : retimeWords(cue.words, tokens).map(({ word, fromMs, forMs, unit }) => ({ word, fromMs, forMs, at: unit ?? fromMs / 1000 - Number(cue.start) }));
  const source: CueSource = { id: cue.id, start: cue.start, duration: cue.duration, text: tokens.join(" "), words };
  let element: string;
  try {
    element = renderCue(source, options);
  } catch (error) {
    // O que `renderCue` recusa é motion que não cabe na legenda com este texto.
    throw new EditError("E_ATTRIBUTE_INVALID", (error as Error).message, "use um texto que caiba no tempo da legenda ou gere de novo com outro motion");
  }
  return html.slice(0, cue.startOffset) + element + html.slice(cue.endOffset);
}
