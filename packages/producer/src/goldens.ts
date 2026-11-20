// FrankFrames — proprietário. Ver LICENSE na raiz.
import { basename } from "node:path";
import { openSession, resolveChrome, startServer } from "@frankframes/engine";
import type { GpuMode } from "@frankframes/engine";
import { prepare } from "./render.ts";

export interface GoldenFrame {
  frame: number;
  sha256: string;
}

export interface GoldenBlock {
  name: string;
  durationSeconds: number;
  frames: GoldenFrame[];
}

export interface GoldenManifest {
  engine: { browser: string; gpu: GpuMode; viewport: string };
  blocks: GoldenBlock[];
}

/** Frames amostrados: começo, meio e fim, sem depender do último frame parcial. */
export function sampleFrames(totalFrames: number): number[] {
  return [0.1, 0.3, 0.5, 0.7, 0.9].map((ratio) => Math.min(totalFrames - 1, Math.round(ratio * (totalFrames - 1))));
}

export async function captureGolden(
  entry: string,
  options: { gpu?: GpuMode; ratios?: number[] } = {},
): Promise<GoldenBlock> {
  const prepared = await prepare({ entry });
  const server = await startServer(prepared.entryDir, {
    ...(prepared.mediaDir !== undefined ? { mediaRoot: prepared.mediaDir } : {}),
    ...(prepared.manifest !== undefined ? { manifest: prepared.manifest } : {}),
    page: { path: basename(prepared.entry), html: prepared.compiledHtml },
  });
  const session = await openSession({
    url: `${server.url}${basename(prepared.entry)}`,
    viewport: prepared.viewport,
    gpu: options.gpu ?? "software",
  });

  try {
    const frames: GoldenFrame[] = [];
    for (const frame of sampleFrames(prepared.totalFrames)) {
      await session.seekFrame(frame, prepared.fps);
      const { sha256 } = await session.capture();
      frames.push({ frame, sha256 });
    }
    const errors = session.pageErrors();
    if (errors.length > 0) throw new Error(`erros na página em ${entry}: ${errors[0]}`);
    return { name: basename(prepared.entryDir), durationSeconds: prepared.seconds, frames };
  } finally {
    await session.close();
    await server.close();
  }
}

export async function engineSignature(gpu: GpuMode = "software"): Promise<GoldenManifest["engine"]> {
  const chrome = await resolveChrome();
  return { browser: chrome.version, gpu, viewport: "nativo" };
}
