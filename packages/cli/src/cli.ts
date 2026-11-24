#!/usr/bin/env node
// FrankFrames — proprietário. Ver LICENSE na raiz.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadComposition } from "@frankframes/contract";
import { PINNED_BROWSER, assetPath, checkPinnedBrowser, startServer } from "@frankframes/engine";
import type { Preset, VideoCodec } from "@frankframes/encode";
import {
  PreviewAudioError,
  RenderError,
  buildCaptionComposition,
  prepare,
  renderComposition,
  renderPreviewAudio,
  resolveFfmpeg,
  toErrorPayload,
} from "@frankframes/producer";
import type { PreviewAudioConfig } from "@frankframes/engine";
import { installLocalModel, resolveProvider } from "@frankframes/transcribe";
import { installBlockFromUrl, listBlocks, readBlock } from "@frankframes/catalog";
import { runBatchCommand } from "./batch-command.ts";
import { buildCatalogIndex, publishCatalog, serveCatalog } from "./catalog-server.ts";
import { runFramesCommand } from "./frames-command.ts";
import { runGenerateCommand } from "./generate-command.ts";
import { startGallery } from "./gallery.ts";
import { openBrowser } from "./open-browser.ts";
import { lintReport } from "./lint-report.ts";
import { runDoctor, runInit, runSkillInstall } from "./onboarding.ts";
import { defaultOutput, guardEncoder } from "./render-guard.ts";
import { runSetup } from "./setup.ts";
import { runUpgrade } from "./upgrade.ts";
import { startStudio } from "./studio-server.ts";
import type { RenderStage } from "@frankframes/producer";
import type { CliCode } from "./cli-errors.ts";

const HELP = `frankframes — vídeo determinístico a partir de HTML

uso:
  frankframes --version | -v
  frankframes lint <arquivo.html> [--json]
  frankframes render <arquivo.html> [-o saida.mp4] [--codec av1|vp9|h264] [--preset draft|standard|high]
                                    [--workers N] [--gpu auto|software|hardware] [--no-loudness]
                                    [--keep] [--json]
                                    (--keep guarda a pasta de trabalho e grava os frames em frames/*.png;
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
  frankframes studio <arquivo.html> [--port N]
  frankframes transcribe <audio> [--provider local|groq|openai-compatible] [--language pt] [--json]
  frankframes captions <audio> [-o legenda.html] [--size 1920x1080] [--language pt] [--motion "<preset de entrada>"]
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

interface Cli {
  command: string;
  file?: string;
  /** Todos os argumentos posicionais depois do comando (`render a.html b.html`). */
  files: string[];
  json: boolean;
  out?: string;
  codec: VideoCodec;
  preset: Preset;
  workers?: number;
  /** `render --batch <arquivo>`: lote descrito em JSON (docs/batch.md). */
  batch?: string;
  /** `render` em lote: jobs ao mesmo tempo. */
  concurrency?: number;
  /** Opções de render escritas na linha de comando (o lote em arquivo não as aceita). */
  given: string[];
  keep: boolean;
  provider?: string;
  language?: string;
  /** `captions --motion`: preset de entrada por palavra (§7b.8). */
  motion?: string;
  port?: number;
  root?: string;
  gpu?: "auto" | "software" | "hardware";
  /** Flags booleanas reconhecidas por comando (`--open`, `--check`, `--cursor`…). */
  flags: string[];
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = { command: "help", files: [], given: [], json: false, codec: "av1", preset: "standard", keep: false, flags: [] };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") cli.json = true;
    else if (arg === "--keep") cli.keep = true;
    else if (arg === "--help" || arg === "-h") cli.command = "help";
    else if (arg === "-o" || arg === "--out") {
      cli.out = argv[++i];
      cli.given.push("-o");
    }
    else if (arg === "--codec") {
      cli.codec = (argv[++i] ?? "av1") as VideoCodec;
      cli.given.push("--codec");
    }
    else if (arg === "--preset") {
      cli.preset = (argv[++i] ?? "standard") as Preset;
      cli.given.push("--preset");
    }
    else if (arg === "--batch") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) throw new Error("--batch precisa do arquivo do lote, por exemplo --batch lote.json");
      cli.batch = value;
    }
    else if (arg === "--concurrency") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error("--concurrency precisa de um inteiro maior ou igual a 1");
      cli.concurrency = value;
    }
    else if (arg === "--workers") cli.workers = Number(argv[++i]);
    else if (arg === "--provider") cli.provider = argv[++i];
    else if (arg === "--language") cli.language = argv[++i];
    else if (arg === "--motion") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) throw new Error('--motion precisa de um preset de entrada, por exemplo --motion "subir"');
      cli.motion = value;
    }
    else if (arg === "--port") cli.port = Number(argv[++i]);
    else if (arg === "--root") cli.root = argv[++i];
    else if (arg === "--gpu") {
      cli.gpu = (argv[++i] ?? "auto") as "auto" | "software" | "hardware";
      cli.given.push("--gpu");
    }
    else if (arg.startsWith("-")) {
      const known = ["--open", "--check", "--fonts-only", "--cursor", "--apply", "--size", "--no-loudness"];
      if (!known.includes(arg)) throw new Error(`opção desconhecida: ${arg}`);
      cli.flags.push(arg);
    }
    else positional.push(arg);
  }
  if (positional.length > 0) cli.command = positional[0]!;
  if (positional.length > 1) cli.file = positional[1]!;
  cli.files = positional.slice(1);
  return cli;
}

// Devolve o código de saída; quem chama grava em `process.exitCode` e deixa o loop drenar
// (`process.exit()` logo após I/O de processo filho pode abortar com UV_HANDLE_CLOSING no Node 24/Windows).
async function browserCommand(action: string): Promise<number> {
  if (action === "check") {
    const pin = await checkPinnedBrowser();
    if (!pin.present) {
      process.stderr.write("shell pinado ausente: rode `frankframes browser install`\n");
      return 1;
    }
    if (!pin.matches) {
      process.stderr.write(`digest não confere em ${pin.path}\nesperado ${PINNED_BROWSER.sha256}\nobtido   ${pin.digest}\n`);
      return 1;
    }
    process.stdout.write(`ok ${PINNED_BROWSER.version} · ${pin.path}\n`);
    return 0;
  }

  if (action !== "install") {
    process.stderr.write(`ação desconhecida: ${action}\n\n${HELP}\n`);
    return 2;
  }

  const vendor = assetPath("browsers");
  const child = spawn(
    process.platform === "win32" ? "cmd" : "npx",
    process.platform === "win32"
      ? ["/c", "npx", "--yes", "@puppeteer/browsers", "install", `chrome-headless-shell@${PINNED_BROWSER.version}`, "--path", vendor]
      : ["--yes", "@puppeteer/browsers", "install", `chrome-headless-shell@${PINNED_BROWSER.version}`, "--path", vendor],
    { stdio: "inherit" },
  );
  const exited = Promise.withResolvers<number>();
  child.on("error", (error) => {
    process.stderr.write(`falha ao executar npx: ${error.message}\n`);
    exited.resolve(1);
  });
  child.on("exit", (value) => exited.resolve(value ?? 1));
  const code = await exited.promise;
  if (code !== 0) return code;
  const pin = await checkPinnedBrowser();
  if (!pin.matches) {
    process.stderr.write(`download concluído, mas o digest não confere: ${pin.digest}\n`);
    return 1;
  }
  process.stdout.write(`ok ${PINNED_BROWSER.version} · ${pin.path}\n`);
  return 0;
}

const CLI_VERSION_ERROR: CliCode = "E_VERSION_UNREADABLE";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // `--version` antes de tudo: lê o `package.json` do pacote cli (no tarball do release ele fica ao lado de `src/`).
  if (argv[0] === "--version" || argv[0] === "-v") {
    try {
      const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
      if (typeof manifest.version !== "string") throw new Error("package.json sem campo version");
      process.stdout.write(`${manifest.version}\n`);
    } catch (error) {
      process.stderr.write(`${CLI_VERSION_ERROR}: ${(error as Error).message}\n  dica: reinstale o pacote (npm i -g @frankframes/cli) ou rode a partir de um clone completo\n`);
      process.exitCode = 1;
    }
    return;
  }
  // `frames` tem parser próprio (`--at`): não passa por `parseCli`.
  if (argv[0] === "frames") {
    process.exitCode = await runFramesCommand(argv.slice(1));
    return;
  }
  // `generate` também: pedido em texto e flags próprias (`--format`, `--attempts`…).
  if (argv[0] === "generate") {
    process.exitCode = await runGenerateCommand(argv.slice(1));
    return;
  }
  let cli: Cli;
  try {
    cli = parseCli(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}\n`);
    process.exit(2);
  }

  if (cli.command === "help" || cli.command === "") {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }

  if (cli.command === "browser") {
    process.exitCode = await browserCommand(cli.file ?? "check");
    return;
  }

  if (cli.command === "setup") {
    // `process.exit()` logo após fetch pode abortar com UV_HANDLE_CLOSING no Node 24/Windows.
    process.exitCode = await runSetup({ check: cli.flags.includes("--check"), fontsOnly: cli.flags.includes("--fonts-only") });
    return;
  }

  if (cli.command === "upgrade") {
    try {
      process.exitCode = await runUpgrade({ apply: cli.flags.includes("--apply") });
      return;
    } catch (error) {
      process.stderr.write(`erro ao verificar atualização: ${(error as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  if (cli.command === "doctor") {
    process.exitCode = await runDoctor();
    return;
  }

  if (cli.command === "init") {
    await runInit(cli.file ?? ".");
    process.exit(0);
  }

  if (cli.command === "skill") {
    if (cli.file !== "install") {
      process.stderr.write("uso: frankframes skill install [--cursor] [diretório]\n");
      process.exit(2);
    }
    const cursor = cli.flags.includes("--cursor");
    const destination = process.argv.filter((arg) => !arg.startsWith("-"))[3] ?? ".";
    await runSkillInstall(cursor ? "cursor" : "claude", destination);
    process.exit(0);
  }

  if (cli.command === "gallery") {
    const port = cli.port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      process.stderr.write(`porta inválida: ${cli.port}\n`);
      process.exit(2);
    }
    const server = await startGallery({ ...(cli.root !== undefined ? { root: resolve(cli.root) } : {}), port });
    process.stdout.write(`galeria ${server.url}/\nCtrl+C encerra\n`);
    const stopped = Promise.withResolvers<void>();
    const stop = (): void => {
      server.close().then(stopped.resolve, stopped.reject);
    };
    process.once("SIGINT", stop);
    try {
      await stopped.promise;
    } finally {
      process.off("SIGINT", stop);
    }
    process.exitCode = 0;
    return;
  }

  if (cli.command === "render" && (cli.batch !== undefined || cli.files.length > 1)) {
    const conflict = cli.batch !== undefined
      ? [...cli.files.map(() => "um HTML"), ...cli.given, ...(cli.flags.includes("--no-loudness") ? ["--no-loudness"] : []), ...(cli.keep ? ["--keep"] : [])]
      : cli.keep ? ["--keep"] : [];
    if (conflict.length > 0) {
      process.stderr.write(
        cli.batch !== undefined
          ? `--batch já traz entradas e opções no arquivo do lote; remova: ${[...new Set(conflict)].join(", ")}\n`
          : "--keep não vale em lote (cada job apaga a própria pasta de trabalho)\n",
      );
      process.exit(2);
    }
    process.exitCode = await runBatchCommand({
      files: cli.files,
      ...(cli.batch !== undefined ? { batchFile: cli.batch } : {}),
      ...(cli.out !== undefined ? { out: cli.out } : {}),
      codec: cli.codec,
      preset: cli.preset,
      ...(cli.gpu !== undefined ? { gpu: cli.gpu } : {}),
      ...(cli.workers !== undefined ? { workers: cli.workers } : {}),
      ...(cli.concurrency !== undefined ? { concurrency: cli.concurrency } : {}),
      noLoudness: cli.flags.includes("--no-loudness"),
      json: cli.json,
    });
    return;
  }
  if (cli.concurrency !== undefined) {
    process.stderr.write("--concurrency só vale em lote (várias entradas ou --batch)\n");
    process.exit(2);
  }

  const entry = cli.file;
  if (entry === undefined) {
    process.stderr.write(`arquivo ausente\n\n${HELP}\n`);
    process.exit(2);
  }

  if (cli.command === "lint") {
    const html = readFileSync(entry, "utf8");
    const composition = loadComposition(html);
    if (cli.json) {
      process.stdout.write(`${JSON.stringify(lintReport(html, entry), null, 2)}\n`);
    } else {
      const { duration } = composition;
      const seconds = duration.kind === "unresolved" ? "não resolvida" : `${duration.seconds.toFixed(3)}s`;
      process.stdout.write(`${entry}: ${composition.id || "(sem id)"} · ${composition.fps.num}/${composition.fps.den} fps · ${seconds}\n`);
      for (const clip of composition.clips) {
        process.stdout.write(`  ${clip.id.padEnd(20)} start=${clip.start ?? "?"} end=${clip.end ?? "?"}\n`);
      }
      for (const d of composition.diagnostics) {
        process.stdout.write(`${d.severity === "error" ? "erro" : "aviso"} ${d.code}${d.clipId ? ` [${d.clipId}]` : ""}: ${d.message}\n`);
        if (d.hint) process.stdout.write(`  → ${d.hint}\n`);
      }
    }
    process.exit(composition.ok ? 0 : 1);
  }

  if (cli.command === "transcribe") {
    try {
      const transcriber = await resolveProvider({
        provider: cli.provider as "local" | "groq" | "openai-compatible" | undefined,
        language: cli.language,
      });
      const result = await transcriber.transcribe(entry, { language: cli.language });
      if (cli.json) {
        process.stdout.write(`${JSON.stringify({ provider: result.provider, text: result.text, segments: result.segments, words: result.words }, null, 2)}\n`);
      } else {
        process.stdout.write(`${result.provider}: ${result.segments.length} segmento(s)\n${result.text}\n`);
      }
      process.exitCode = 0;
      return;
    } catch (error) {
      const err = error as { code?: string; message: string };
      process.stderr.write(`erro ${err.code ?? "E_TRANSCRIBE"}: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  if (cli.command === "captions") {
    const outIndex = process.argv.indexOf("-o");
    const outPath = resolve(outIndex > 0 ? (process.argv[outIndex + 1] ?? "legenda.html") : "legenda.html");
    const sizeIndex = process.argv.indexOf("--size");
    const [width, height] = (sizeIndex > 0 ? (process.argv[sizeIndex + 1] ?? "1920x1080") : "1920x1080").split("x").map(Number);
    try {
      const transcriber = await resolveProvider({ language: cli.language });
      const result = await transcriber.transcribe(entry, { language: cli.language });
      const segments = result.segments.map((segment) => ({
        ...segment,
        words: (result.words ?? []).filter((word) => word.start >= segment.start - 0.01 && word.start < segment.end),
      }));
      const html = buildCaptionComposition(segments, {
        ...(Number.isFinite(width) ? { width } : {}),
        ...(Number.isFinite(height) ? { height } : {}),
        ...(cli.motion !== undefined ? { motion: { enter: cli.motion } } : {}),
      });
      await writeFile(outPath, html, "utf8");
      process.stdout.write(`${outPath} · ${result.segments.length} segmento(s) · ${result.provider}\n`);
      process.exitCode = 0;
      return;
    } catch (error) {
      const err = error as { code?: string; message: string };
      process.stderr.write(`erro ${err.code ?? "E_CAPTIONS"}: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  if (cli.command === "models") {
    if (cli.file !== "install") {
      process.stderr.write(`uso: frankframes models install whisper-large-v3-turbo\n`);
      process.exit(2);
    }
    const dest = resolve("vendor", "models", "ggml-large-v3-turbo.bin");
    process.stderr.write("baixando ggml-large-v3-turbo (~1.5 GB) — só acontece por este comando\n");
    const installed = await installLocalModel({
      modelUrl: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
      destPath: dest,
    });
    process.stdout.write(`${installed.path} · ${(installed.bytes / 1e9).toFixed(2)} GB\n`);
    process.exitCode = 0;
    return;
  }

  if (cli.command === "blocks") {
    const action = entry;
    if (action === "list") {
      for (const block of listBlocks()) {
        process.stdout.write(`${block.slug.padEnd(16)} ${block.durationSeconds}s  ${block.name} — ${block.summary}\n`);
      }
      process.exit(0);
    }
    if (action === "index") {
      const index = await buildCatalogIndex();
      if (cli.json) {
        process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
      } else {
        for (const block of index) {
          process.stdout.write(
            `${block.slug.padEnd(20)} ${block.durationSeconds}s  ${block.width}x${block.height}  ${(block.sizeBytes / 1024).toFixed(1)} KiB  ${block.sha256.slice(0, 12)}…  ${block.name}\n`,
          );
        }
        const bytes = index.reduce((total, block) => total + block.sizeBytes, 0);
        process.stdout.write(`${index.length} bloco(s) · ${(bytes / 1024 / 1024).toFixed(2)} MiB de HTML\n`);
      }
      process.exit(0);
    }
    if (action === "publish") {
      const destination = process.argv[4];
      if (destination === undefined || destination.startsWith("-")) {
        process.stderr.write("uso: frankframes blocks publish <destino>\n");
        process.exit(2);
      }
      const published = await publishCatalog(destination);
      process.stdout.write(
        `${resolve(destination)} · ${published.files} arquivo(s) · ${(published.bytes / 1024 / 1024).toFixed(2)} MiB (${published.bytes} bytes)\n`,
      );
      process.exit(0);
    }
    if (action === "serve") {
      const root = process.argv[4] === undefined || process.argv[4]!.startsWith("-") ? resolve("out", "catalog") : process.argv[4]!;
      const port = cli.port ?? 0;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write(`porta inválida: ${cli.port}\n`);
        process.exit(2);
      }
      const server = await serveCatalog(root, port);
      process.stdout.write(`servindo ${resolve(root)} em ${server.url}\nCtrl+C encerra\n`);
      const stopped = Promise.withResolvers<void>();
      const stop = (): void => {
        server.close().then(stopped.resolve, stopped.reject);
      };
      process.once("SIGINT", stop);
      try {
        await stopped.promise;
      } finally {
        process.off("SIGINT", stop);
      }
      process.exitCode = 0;
      return;
    }
    if (action === "add") {
      const slug = process.argv[4];
      if (slug === undefined) {
        process.stderr.write("uso: frankframes blocks add <slug> [destino]\n");
        process.exit(2);
      }
      const target = resolve(process.argv[5] ?? "bloco");
      if (/^https?:\/\//.test(slug)) {
        try {
          const installed = await installBlockFromUrl(slug, target);
          process.stdout.write(`${installed.destination} · ${installed.bytes} bytes · sha256 ${installed.sha256.slice(0, 12)}…\n`);
          // `process.exit()` logo após fetch aborta no Node 24/Windows.
          process.exitCode = 0;
          return;
        } catch (error) {
          process.stderr.write(`falha ao instalar: ${(error as Error).message}\n`);
          process.exitCode = 1;
          return;
        }
      }
      const block = listBlocks().find((candidate) => candidate.slug === slug);
      if (!block) {
        process.stderr.write(`bloco desconhecido: ${slug} (passe um slug local ou uma URL)\n`);
        process.exit(2);
      }
      await cp(block.dir, target, { recursive: true });
      process.stdout.write(`${target} (${readBlock(slug).length} bytes de HTML)\n`);
      process.exit(0);
    }
    process.stderr.write("uso: frankframes blocks list|add|index|publish|serve\n");
    process.exit(2);
  }

  if (cli.command === "preview") {
    const pair = await resolveFfmpeg();
    let prepared = await prepare({ entry, ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe });

    // Mix do preview = mesmo grafo do render. Falha vira aviso na barra, nunca derruba o vídeo.
    const audioDir = resolve(assetPath("cache", "preview-audio"));
    const mixPreviewAudio = async (source: typeof prepared): Promise<PreviewAudioConfig | undefined> => {
      const mixStarted = Date.now();
      try {
        const result = await renderPreviewAudio({ prepared: source, ffmpeg: pair.ffmpeg, cacheDir: audioDir });
        if (result === null) return undefined;
        if ("disabled" in result) return { disabled: result.disabled };
        process.stdout.write(`áudio do preview ${result.cached ? "do cache" : "mixado"} em ${Date.now() - mixStarted} ms\n`);
        for (const warning of result.warnings) process.stderr.write(`áudio: ${warning}\n`);
        return { src: `/__ff_audio/${result.key}.wav` };
      } catch (error) {
        const text =
          error instanceof PreviewAudioError
            ? `${error.code}: ${error.message} (${error.hint})`
            : `E_PREVIEW_AUDIO: ${(error as Error).message}`;
        process.stderr.write(`${text}\n`);
        return { error: text };
      }
    };
    const firstAudio = await mixPreviewAudio(prepared);

    // O servidor lê `page`/`manifest` a cada request: mutar o objeto já recarrega.
    const page = { path: basename(entry), html: prepared.compiledHtml };
    const serverOptions: Parameters<typeof startServer>[1] = {
      page,
      live: true,
      preview: { fps: prepared.fps, frames: prepared.totalFrames, id: prepared.composition.id },
      audioDir,
      ...(firstAudio !== undefined ? { audio: firstAudio } : {}),
      ...(prepared.manifest !== undefined ? { manifest: prepared.manifest } : {}),
      ...(prepared.mediaDir !== undefined ? { mediaRoot: prepared.mediaDir } : {}),
    };
    const server = await startServer(prepared.entryDir, serverOptions);

    const url = `${server.url}${basename(entry)}`;
    process.stdout.write(`preview ${url}\n${prepared.totalFrames} frames · ${prepared.seconds.toFixed(3)}s · Ctrl+C encerra\n`);
    if (cli.flags.includes("--open")) {
      openBrowser(url);
    }

    let recompiling = false;
    let pending = false;
    const recompile = async (): Promise<void> => {
      if (recompiling) {
        pending = true;
        return;
      }
      recompiling = true;
      const started = Date.now();
      try {
        const next = await prepare({ entry, ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe });
        page.html = next.compiledHtml;
        serverOptions.manifest = next.manifest;
        serverOptions.preview = { fps: next.fps, frames: next.totalFrames, id: next.composition.id };
        const nextAudio = await mixPreviewAudio(next);
        if (nextAudio !== undefined) serverOptions.audio = nextAudio;
        else delete serverOptions.audio;
        prepared = next;
        server.notify();
        process.stdout.write(`recompilado em ${Date.now() - started} ms · ${next.totalFrames} frames\n`);
      } catch (error) {
        process.stderr.write(`erro ao recompilar: ${(error as Error).message}\n`);
      } finally {
        recompiling = false;
        if (pending) {
          pending = false;
          void recompile();
        }
      }
    };

    const timer: { handle?: NodeJS.Timeout } = {};
    const watcher = watch(prepared.entryDir, { recursive: true }, (_event, file) => {
      if (typeof file === "string" && /(^|[\\/])(node_modules|\.git|out)([\\/]|$)/.test(file)) return;
      if (timer.handle) clearTimeout(timer.handle);
      timer.handle = setTimeout(() => void recompile(), 120);
    });
    watcher.on("error", (error) => process.stderr.write(`watcher: ${error.message}\n`));

    // Encerramento sem `process.exit()`: fecha watcher, timer e servidor e deixa o loop drenar.
    const stop = Promise.withResolvers<number>();
    let closing = false;
    const shutdown = (code: number): void => {
      if (closing) return;
      closing = true;
      watcher.close();
      if (timer.handle) clearTimeout(timer.handle);
      void server
        .close()
        .catch(() => {})
        .finally(() => stop.resolve(code));
    };
    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    process.exitCode = await stop.promise;
    return;
  }

  if (cli.command === "studio") {
    if (cli.file === undefined) {
      process.stderr.write("uso: frankframes studio <arquivo.html> [--port N]\n");
      process.exit(2);
    }
    const server = await startStudio({ entry: resolve(cli.file), ...(cli.port !== undefined ? { port: cli.port } : {}) });
    process.stdout.write(`studio ${server.url}\n`);
    const stopped = Promise.withResolvers<void>();
    const stop = (): void => {
      server.close().then(stopped.resolve, stopped.reject);
    };
    process.once("SIGINT", stop);
    try {
      await stopped.promise;
    } finally {
      process.off("SIGINT", stop);
    }
    process.exitCode = 0;
    return;
  }

  if (cli.command !== "render") {
    process.stderr.write(`comando desconhecido: ${cli.command}\n\n${HELP}\n`);
    process.exit(2);
  }

  const pair = await resolveFfmpeg();
  for (const warning of pair.warnings) process.stderr.write(`aviso: ${warning}\n`);
  const ffmpeg = pair.ffmpeg;
  const ffprobe = pair.ffprobe;
  const outPath = cli.out !== undefined ? resolve(cli.out) : defaultOutput(entry, cli.codec);

  try {
    await guardEncoder({
      pair,
      codec: cli.codec,
      onWarning: (warning) => process.stderr.write(`aviso licença: ${warning}\n`),
    });

    const result = await renderComposition({
      entry,
      outPath,
      ffmpeg,
      ffprobe,
      codec: cli.codec,
      preset: cli.preset,
      ...(cli.workers !== undefined ? { workers: cli.workers } : {}),
      keepWorkDir: cli.keep,
      ...(cli.gpu !== undefined ? { gpu: cli.gpu } : {}),
      ...(cli.flags.includes("--no-loudness") ? { loudness: false } : {}),
      onProgress: (stage: RenderStage, percent: number, message?: string) => {
        if (cli.json) return;
        process.stderr.write(`[${stage}] ${percent}%${message ? ` ${message}` : ""}\n`);
      },
    });

    if (cli.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            outPath: result.outPath,
            frames: result.frames,
            durationSeconds: result.durationSeconds,
            codec: result.codec,
            preset: result.preset,
            hasAudio: result.hasAudio,
            warnings: result.warnings,
            frameHashes: result.hashes.size,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(`${result.outPath} · ${result.frames} frames · ${result.durationSeconds.toFixed(3)}s · ${result.codec}/${result.preset}\n`);
    }
    process.exitCode = 0;
  } catch (error) {
    process.exitCode = 1;
    if (cli.json) {
      process.stdout.write(`${JSON.stringify(toErrorPayload(error), null, 2)}\n`);
      return;
    }
    if (error instanceof RenderError) {
      process.stderr.write(`erro ${error.code} no estágio ${error.stage}: ${error.message}\n`);
      for (const d of error.diagnostics.filter((x) => x.severity === "error")) {
        process.stderr.write(`  ${d.code}${d.clipId ? ` [${d.clipId}]` : ""}: ${d.message}\n`);
        if (d.hint) process.stderr.write(`  → ${d.hint}\n`);
      }
    } else {
      process.stderr.write(`erro: ${(error as Error).message}\n`);
    }
  }
}

await main();
