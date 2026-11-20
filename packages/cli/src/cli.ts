#!/usr/bin/env node
// FrankFrames — proprietário. Ver LICENSE na raiz.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { loadComposition } from "@frankframes/contract";
import { PINNED_BROWSER, checkPinnedBrowser, startServer } from "@frankframes/engine";
import { assertCodecAllowed, assertFfmpegAllowed, containerFor, detectFfmpeg } from "@frankframes/encode";
import type { Preset, VideoCodec } from "@frankframes/encode";
import { RenderError, renderComposition } from "@frankframes/producer";
import type { RenderStage } from "@frankframes/producer";

const HELP = `frankframes — vídeo determinístico a partir de HTML

uso:
  frankframes lint <arquivo.html> [--json]
  frankframes render <arquivo.html> [-o saida.mp4] [--codec av1|vp9|h264] [--preset draft|standard|high]
                                    [--workers N] [--keep] [--json]
  frankframes preview <arquivo.html> [--open]
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
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = { command: "help", json: false, codec: "av1", preset: "standard", keep: false };
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
    else if (arg.startsWith("-")) throw new Error(`opção desconhecida: ${arg}`);
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

  const vendor = resolve("vendor", "browsers");
  const child = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["--yes", "@puppeteer/browsers", "install", `chrome-headless-shell@${PINNED_BROWSER.version}`, "--path", vendor],
    { stdio: "inherit" },
  );
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

  if (cli.command === "preview") {
    const server = await startServer(dirname(resolve(entry)));
    const url = `${server.url}${basename(entry)}`;
    process.stdout.write(`preview ${url}\nCtrl+C encerra.\n`);
    if (process.argv.includes("--open")) {
      const { exec } = await import("node:child_process");
      exec(`${process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open"} "${url}"`);
    }
    const stop = Promise.withResolvers<never>();
    process.on("SIGINT", () => {
      server.close().finally(() => stop.resolve(process.exit(0) as never));
    });
    await stop.promise;
    return;
  }

  if (cli.command !== "render") {
    process.stderr.write(`comando desconhecido: ${cli.command}\n\n${HELP}\n`);
    process.exit(2);
  }

  const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
  const mode = process.env.FRANKFRAMES_FFMPEG_MODE === "distribution" ? "distribution" : "user-provided";
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
