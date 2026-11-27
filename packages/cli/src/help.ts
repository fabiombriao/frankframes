// FrankFrames — proprietário. Ver LICENSE na raiz.
// Ajuda da CLI e registro dos subcomandos (EDT-85). Sem efeito colateral: importável pelos testes sem rodar o `cli.ts`.

/** Subcomandos que o despacho do `cli.ts` reconhece. O texto de `HELP` lista os mesmos (um teste confere). */
export const COMMANDS = [
  "lint",
  "render",
  "frames",
  "reframe",
  "generate",
  "preview",
  "studio",
  "transcribe",
  "captions",
  "models",
  "blocks",
  "gallery",
  "init",
  "doctor",
  "setup",
  "upgrade",
  "skill",
  "browser",
] as const;

export type CommandName = (typeof COMMANDS)[number];

export function isCommand(name: string): name is CommandName {
  return (COMMANDS as readonly string[]).includes(name);
}

/** `--help`/`-h` em qualquer posição: a ajuda vence qualquer subcomando e roda antes de qualquer efeito (§9e). */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--help" || arg === "-h");
}

export const HELP = `frankframes — vídeo determinístico a partir de HTML

uso:
  frankframes --version | -v
  frankframes lint <arquivo.html> [--json]
  frankframes render <arquivo.html> [-o saida.mp4] [--codec av1|vp9|h264] [--preset draft|standard|high]
                                    [--workers N] [--gpu auto|software|hardware] [--no-loudness] [--layered] [--vram]
                                    [--keep] [--json]
                                    (--keep guarda a pasta de trabalho e grava frames/*.png ou layers/ no modo por camadas;
                                     sem ele os frames vão direto ao FFmpeg, sem PNG em disco)
  frankframes render a.html b.html [c.html…] -o <pasta>/ [--concurrency N] [opções de render]
  frankframes render --batch lote.json [--concurrency N] [--json]
  frankframes frames <video.mp4|.webm> [--at 10%,50%,90%|1.5,3] [-o pasta] [--json]
                                    (extrai PNGs de instantes-chave e marca frames chapados: confira o render)
  frankframes generate "<pedido>" [-o pasta] [--format 16:9|9:16|1:1] [--duration S] [--attempts N]
                                    [--model M] [--timeout S] [--project pasta] [--no-render] [--no-studio]
                                    [--force] [--keep-context] [--json]
                                    (gera o vídeo a partir de texto com o Codex CLI; exige \`codex login\` com conta ChatGPT)
  frankframes preview <arquivo.html> [--open]
  frankframes reframe <vídeo> -o <pasta> [--start S] [--duration S] [--swap]
  frankframes studio <arquivo.html> [--port N]
  frankframes transcribe <audio> [--provider local|groq|openai-compatible] [--language pt] [--json]
  frankframes captions <audio> [-o legenda.html] [--size 1920x1080] [--language pt] [--motion "<preset de entrada>"]
                                    [--max-words N]  (karaokê: até N palavras por legenda, padrão 4; juntar para
                                                      dar o tempo mínimo na tela, 0,4 s ou o da mola, pode passar de N)
  frankframes models install whisper-large-v3-turbo
  frankframes blocks list
  frankframes blocks add <slug> [destino]
  frankframes blocks index [--json]
  frankframes blocks publish <destino>
  frankframes blocks serve [raiz] [--port N]
  frankframes gallery [--port N] [--root <dir>]
  frankframes init [diretório]
  frankframes doctor
  frankframes setup [--check] [--fonts-only]
  frankframes upgrade [--apply]
  frankframes skill install [--cursor] [diretório]
  frankframes browser check
  frankframes browser install

ambiente:
  FFMPEG_PATH / FFPROBE_PATH     binários usados no render
  FRANKFRAMES_FFMPEG_MODE        "distribution" bloqueia binário GPL; padrão "user-provided" (avisa)
  FRANKFRAMES_ALLOW_H264=1       libera H.264 via libopenh264
  FRANKFRAMES_CODEX              caminho do Codex CLI para o \`generate\` (padrão: \`codex\` no PATH)

lint e render saem com código 1 em erro. Em lote, saem com 1 se algum job falhar; o relatório fica em batch-report.json.`;
