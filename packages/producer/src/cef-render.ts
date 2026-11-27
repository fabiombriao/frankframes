// FrankFrames — proprietário. Ver LICENSE na raiz.
import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import type { Fps } from "@frankframes/contract";
import type { Preset } from "@frankframes/encode";
import { assetPath, startServer } from "@frankframes/engine";
import type { LayeredMediaManifest, Viewport } from "@frankframes/engine";
import { inspectFrame, LayeredError } from "./layered-capture.ts";
import type { PageFrame } from "./layered-capture.ts";
import { writeCefRenderPlan } from "./layered-encode.ts";
import type { LayeredSource } from "./layered-encode.ts";

const run = promisify(execFile);
export const CEF_FRAME_LIMIT = 16_384;
const wrapperName = "__ff_cef_render.html";

export async function resolveCefExecutable(): Promise<string | undefined> {
  if (process.platform !== "win32" || process.arch !== "x64") return undefined;
  const fromEnv = process.env.FRANKFRAMES_CEF_EXE;
  const path = fromEnv ? resolve(fromEnv) : assetPath("cef", "win64", "ff-cef-probe.exe");
  try {
    if ((await stat(path)).isFile()) return path;
    if (!fromEnv) return undefined;
    throw new Error("o executável CEF indicado não é um arquivo");
  } catch (error) {
    if (!fromEnv && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

interface CefOptions {
  executable: string;
  entry: string;
  entryDir: string;
  html: string;
  sparse: boolean;
  manifest: LayeredMediaManifest;
  sources: LayeredSource[];
  viewport: Viewport;
  fps: Fps;
  total: number;
  directory: string;
  outPath: string;
  preset: Preset;
  warnings: string[];
  signal?: AbortSignal;
  onEncode?: () => void;
  onSummary?: (message: string) => void;
}

export interface CefStatistics {
  frames: number;
  textures: number;
  software: number;
  seconds: number;
}

export function cefStatistics(output: string, expected: number): CefStatistics {
  const status = /^frames=(\d+) texturas=(\d+) software=(\d+) segundos=(\d+(?:\.\d+)?)\r?$/m.exec(output);
  if (!status) throw new Error("CEF terminou sem resumo de captura");
  const [, count, textures, software, seconds] = status;
  const result = { frames: Number(count), textures: Number(textures), software: Number(software), seconds: Number(seconds) };
  if (result.frames !== expected || result.software !== 0 || !output.includes(`MP4 Vulkan frames=${expected}\n`)) {
    throw new Error(`CEF não entregou o MP4 integral em Vulkan: ${status[0]}`);
  }
  return result;
}

function readMetadata(output: string, expected: number): PageFrame[] {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith("meta "));
  if (lines.length !== expected) throw new Error(`CEF inspecionou ${lines.length} de ${expected} frames`);
  return lines.map((line, index) => {
    const marker = `meta ${index} `;
    if (!line.startsWith(marker)) throw new Error(`CEF entregou metadados fora de ordem no frame ${index}`);
    const state = JSON.parse(line.slice(marker.length)) as PageFrame;
    if (!state.video?.clipId || !Array.isArray(state.glass)) throw new Error(`CEF entregou uma cena inválida no frame ${index}`);
    return state;
  });
}

export async function renderCefLayers(options: CefOptions): Promise<CefStatistics> {
  if (options.total > CEF_FRAME_LIMIT) throw new LayeredError(`CEF suporta até ${CEF_FRAME_LIMIT} frames por composição`);
  if (options.sources.some(({ timing }) => timing.orientation.mirrored)) throw new LayeredError("CEF não suporta fontes espelhadas");
  const { viewport, fps, total, signal } = options;
  const entryName = basename(options.entry);
  const inspect = `<script>window.__ffCefProbeInspect = () => (${inspectFrame.toString()})(${options.sparse});</script>`;
  const html = options.html.replace("</head>", () => inspect + "</head>");
  const virtualPath = resolve(options.entryDir, wrapperName);
  let background: string | undefined;
  const server = await startServer(options.entryDir, {
    page: { path: entryName, html },
    manifest: options.manifest,
    readFile: (path) => {
      if (path !== virtualPath) return readFile(path);
      const style = background?.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
      return Promise.resolve(Buffer.from(`<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;overflow:hidden;background:transparent}iframe{display:block;border:0}</style>
${style === undefined ? "" : `<div id="ff-cef-background" style="position:fixed;left:0;top:0;width:${viewport.width}px;height:${viewport.height}px;${style}"></div>`}
<iframe id="composition" src="/${encodeURIComponent(entryName)}" width="${viewport.width}" height="${viewport.height}"${style === undefined ? "" : ' style="visibility:hidden"'}></iframe>`));
    },
  });
  const execute = async (mode: string, name: string): Promise<string> => {
    const url = new URL(wrapperName, server.url);
    const args = [url.href, viewport.width, viewport.height, total, fps.num, fps.den, mode].map(String);
    try {
      const { stdout, stderr } = await run(options.executable, args, {
        cwd: options.directory, windowsHide: true, maxBuffer: 64 << 20,
        timeout: Math.max(60_000, total * 300), ...(signal === undefined ? {} : { signal }),
      });
      if (process.env.FRANKFRAMES_CEF_TRACE) await writeFile(resolve(options.directory, `cef-${mode.replace(/^--/, "")}.log`), stdout + "\n" + stderr);
      return stdout.replaceAll("\r\n", "\n");
    } catch (cause) {
      signal?.throwIfAborted();
      const error = cause as Error & { stderr?: string; stdout?: string; code?: number; signal?: string };
      const tail = [error.stdout?.trim().split(/\r?\n/).at(-1), error.stderr?.trim().split(/\r?\n/).slice(-10).join("\n")]
        .filter(Boolean).join("\n");
      throw new Error(`CEF ${name} encerrou com ${error.signal ?? error.code ?? error.message}${tail === "" ? "" : `\n${tail}`}`, { cause });
    }
  };
  try {
    const frames = readMetadata(await execute("--scan", "na inspeção da cena"), total);
    background = frames[0]?.background;
    if (frames.some((frame) => frame.background !== background)) throw new LayeredError("o gradiente de fundo precisa ser estático");
    await writeCefRenderPlan({
      capture: { frames, hashes: new Map(), rgbFrames: new Set(), background: background !== undefined },
      sources: options.sources, viewport, fps, directory: options.directory, outPath: options.outPath,
      codec: "av1", preset: options.preset, warnings: options.warnings, ...(signal === undefined ? {} : { signal }),
    });
    options.onEncode?.();
    const output = await execute("cef.plan", "na composição e encode Vulkan");
    const status = cefStatistics(output, total);
    if (background !== undefined && !output.includes("fundo HTML Vulkan=1\n")) throw new Error("CEF não entregou o gradiente em Vulkan");
    options.onSummary?.(`CEF em VRAM: ${status.frames} frames, ${status.textures} texturas, ${status.software} software, ${status.seconds.toFixed(3)} s`);
    return status;
  } finally {
    await server.close();
  }
}
