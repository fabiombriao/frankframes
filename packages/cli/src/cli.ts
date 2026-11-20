#!/usr/bin/env node
// FrankFrames — proprietário. Ver LICENSE na raiz.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { loadComposition } from "@frankframes/contract";
import { PINNED_BROWSER, assetPath, checkPinnedBrowser, startServer } from "@frankframes/engine";
import { assertCodecAllowed, assertFfmpegAllowed, containerFor, detectFfmpeg } from "@frankframes/encode";
import type { Preset, VideoCodec } from "@frankframes/encode";
import { RenderError, prepare, renderComposition, resolveFfmpeg, toErrorPayload } from "@frankframes/producer";
import { installLocalModel, resolveProvider } from "@frankframes/transcribe";
import { listBlocks, readBlock } from "@frankframes/catalog";
import { runDoctor, runInit, runSkillInstall } from "./onboarding.ts";
import { runSetup } from "./setup.ts";
import type { RenderStage } from "@frankframes/producer";

const HELP = `frankframes — vídeo determinístico a partir de HTML

uso:
  frankframes lint <arquivo.html> [--json]
  frankframes render <arquivo.html> [-o saida.mp4] [--codec av1|vp9|h264] [--preset draft|standard|high]
                                    [--workers N] [--keep] [--json]
  frankframes preview <arquivo.html> [--open]
  frankframes transcribe <audio> [--provider local|groq|openai-compatible] [--language pt] [--json]
  frankframes models install whisper-large-v3-turbo
  frankframes blocks list
  frankframes blocks add <slug> [destino]
  frankframes init [diretório]
  frankframes doctor
  frankframes setup [--check] [--fonts-only]
  frankframes skill install [--cursor] [diretório]
  frankframes browser check
  frankframes browser install

ambiente:
  FFMPEG_PATH / FFPROBE_PATH     binários usados no render
  FRANKFRAMES_FFMPEG_MODE        "distribution" bloqueia binário GPL; padrão "user-provided" (avisa)
  FRANKFRAMES_ALLOW_H264=1       libera H.264 via libopenh264

lint e render saem com código 1 em erro.`;

interface Cli {
  command: string;
  file?: string;
  json: boolean;
  out?: string;
  codec: VideoCodec;
  preset: Preset;
  workers?: number;
  keep: boolean;
  provider?: string;
  language?: string;
  /** Flags booleanas reconhecidas por comando (`--open`, `--check`, `--cursor`…). */
  flags: string[];
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = { command: "help", json: false, codec: "av1", preset: "standard", keep: false, flags: [] };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") cli.json = true;
    else if (arg === "--keep") cli.keep = true;
    else if (arg === "--help" || arg === "-h") cli.command = "help";
    else if (arg === "-o" || arg === "--out") cli.out = argv[++i];
    else if (arg === "--codec") cli.codec = (argv[++i] ?? "av1") as VideoCodec;
    else if (arg === "--preset") cli.preset = (argv[++i] ?? "standard") as Preset;
    else if (arg === "--workers") cli.workers = Number(argv[++i]);
    else if (arg === "--provider") cli.provider = argv[++i];
    else if (arg === "--language") cli.language = argv[++i];
    else if (arg.startsWith("-")) {
      const known = ["--open", "--check", "--fonts-only", "--cursor"];
      if (!known.includes(arg)) throw new Error(`opção desconhecida: ${arg}`);
      cli.flags.push(arg);
    }
    else positional.push(arg);
  }
  if (positional.length > 0) cli.command = positional[0]!;
  if (positional.length > 1) cli.file = positional[1]!;
  return cli;
}

function defaultOutput(entry: string, codec: VideoCodec): string {
  return resolve("out", `${basename(entry, extname(entry))}.${containerFor(codec)}`);
}

async function browserCommand(action: string): Promise<never> {
  if (action === "check") {
    const pin = await checkPinnedBrowser();
    if (!pin.present) {
      process.stderr.write("shell pinado ausente: rode `frankframes browser install`\n");
      process.exit(1);
    }
    if (!pin.matches) {
      process.stderr.write(`digest não confere em ${pin.path}\nesperado ${PINNED_BROWSER.sha256}\nobtido   ${pin.digest}\n`);
      process.exit(1);
    }
    process.stdout.write(`ok ${PINNED_BROWSER.version} · ${pin.path}\n`);
    process.exit(0);
  }

  if (action !== "install") {
    process.stderr.write(`ação desconhecida: ${action}\n\n${HELP}\n`);
    process.exit(2);
  }

  const vendor = assetPath("browsers");
  const child = spawn(
    process.platform === "win32" ? "cmd" : "npx",
    process.platform === "win32"
      ? ["/c", "npx", "--yes", "@puppeteer/browsers", "install", `chrome-headless-shell@${PINNED_BROWSER.version}`, "--path", vendor]
      : ["--yes", "@puppeteer/browsers", "install", `chrome-headless-shell@${PINNED_BROWSER.version}`, "--path", vendor],
    { stdio: "inherit" },
  );
  child.on("error", (error) => {
    process.stderr.write(`falha ao executar npx: ${error.message}\n`);
    process.exit(1);
  });
  const exited = Promise.withResolvers<number>();
  child.on("exit", (value) => exited.resolve(value ?? 1));
  const code = await exited.promise;
  if (code !== 0) process.exit(code);
  const pin = await checkPinnedBrowser();
  if (!pin.matches) {
    process.stderr.write(`download concluído, mas o digest não confere: ${pin.digest}\n`);
    process.exit(1);
  }
  process.stdout.write(`ok ${PINNED_BROWSER.version} · ${pin.path}\n`);
  process.exit(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
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
    await browserCommand(cli.file ?? "check");
    return;
  }

  if (cli.command === "setup") {
    process.exit(await runSetup({ check: cli.flags.includes("--check"), fontsOnly: cli.flags.includes("--fonts-only") }));
  }

  if (cli.command === "doctor") {
    process.exit(await runDoctor());
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

  const entry = cli.file;
  if (entry === undefined) {
    process.stderr.write(`arquivo ausente\n\n${HELP}\n`);
    process.exit(2);
  }

  if (cli.command === "lint") {
    const composition = loadComposition(readFileSync(entry, "utf8"));
    if (cli.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            file: entry,
            ok: composition.ok,
            id: composition.id,
            fps: composition.fps,
            duration: composition.duration,
            clips: composition.clips.map((c) => ({ id: c.id, start: c.start, end: c.end, media: c.isMedia, sub: c.isSubComposition })),
            diagnostics: composition.diagnostics,
          },
          null,
          2,
        )}\n`,
      );
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
      process.exit(0);
    } catch (error) {
      const err = error as { code?: string; message: string };
      process.stderr.write(`erro ${err.code ?? "E_TRANSCRIBE"}: ${err.message}\n`);
      process.exit(1);
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
    process.exit(0);
  }

  if (cli.command === "blocks") {
    const action = entry;
    if (action === "list") {
      for (const block of listBlocks()) {
        process.stdout.write(`${block.slug.padEnd(16)} ${block.durationSeconds}s  ${block.name} — ${block.summary}\n`);
      }
      process.exit(0);
    }
    if (action === "add") {
      const slug = process.argv[4];
      if (slug === undefined) {
        process.stderr.write("uso: frankframes blocks add <slug> [destino]\n");
        process.exit(2);
      }
      const block = listBlocks().find((candidate) => candidate.slug === slug);
      if (!block) {
        process.stderr.write(`bloco desconhecido: ${slug}\n`);
        process.exit(2);
      }
      const target = resolve(process.argv[5] ?? slug);
      await cp(block.dir, target, { recursive: true });
      process.stdout.write(`${target} (${readBlock(slug).length} bytes de HTML)\n`);
      process.exit(0);
    }
    process.stderr.write("uso: frankframes blocks list|add\n");
    process.exit(2);
  }

  if (cli.command === "preview") {
    const pair = await resolveFfmpeg();
    const workDir = await mkdtemp(join(tmpdir(), "ff-preview-"));
    let prepared = await prepare({ entry, ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe, workDir });

    // O servidor lê `page`/`manifest` a cada request: mutar o objeto já recarrega.
    const page = { path: basename(entry), html: prepared.compiledHtml };
    const serverOptions: Parameters<typeof startServer>[1] = {
      page,
      live: true,
      preview: { fps: prepared.fps, frames: prepared.totalFrames },
      ...(prepared.manifest !== undefined ? { manifest: prepared.manifest } : {}),
      ...(prepared.mediaDir !== undefined ? { mediaRoot: prepared.mediaDir } : {}),
    };
    const server = await startServer(prepared.entryDir, serverOptions);

    const url = `${server.url}${basename(entry)}`;
    process.stdout.write(`preview ${url}\n${prepared.totalFrames} frames · ${prepared.seconds.toFixed(3)}s · Ctrl+C encerra\n`);
    if (cli.flags.includes("--open")) {
      const { exec } = await import("node:child_process");
      exec(`${process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open"} "${url}"`);
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
        const next = await prepare({ entry, ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe, workDir });
        page.html = next.compiledHtml;
        serverOptions.manifest = next.manifest;
        serverOptions.preview = { fps: next.fps, frames: next.totalFrames };
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

    const stop = Promise.withResolvers<never>();
    let closing = false;
    const shutdown = (code: number): void => {
      if (closing) return;
      closing = true;
      watcher.close();
      if (timer.handle) clearTimeout(timer.handle);
      void rm(workDir, { recursive: true, force: true }).catch(() => {});
      void server
        .close()
        .catch(() => {})
        .finally(() => stop.resolve(process.exit(code) as never));
    };
    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    try {
      await stop.promise;
    } finally {
      if (!closing) shutdown(0);
    }
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
  const mode =
    process.env.FRANKFRAMES_FFMPEG_MODE === "distribution" || process.env.FRANKFRAMES_FFMPEG_MODE === "user-provided"
      ? (process.env.FRANKFRAMES_FFMPEG_MODE as "distribution" | "user-provided")
      : pair.source === "vendor"
        ? "distribution"
        : "user-provided";
  const outPath = cli.out !== undefined ? resolve(cli.out) : defaultOutput(entry, cli.codec);

  try {
    const facts = await detectFfmpeg(ffmpeg);
    for (const warning of assertFfmpegAllowed(facts, mode)) process.stderr.write(`aviso licença: ${warning}\n`);
    assertCodecAllowed(facts, { codec: cli.codec, allowH264: process.env.FRANKFRAMES_ALLOW_H264 === "1" });

    const result = await renderComposition({
      entry,
      outPath,
      ffmpeg,
      ffprobe,
      codec: cli.codec,
      preset: cli.preset,
      ...(cli.workers !== undefined ? { workers: cli.workers } : {}),
      keepWorkDir: cli.keep,
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
    process.exit(0);
  } catch (error) {
    if (cli.json) {
      process.stdout.write(`${JSON.stringify(toErrorPayload(error), null, 2)}\n`);
      process.exit(1);
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
    process.exit(1);
  }
}

await main();
