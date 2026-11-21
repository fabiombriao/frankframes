// FrankFrames — proprietário. Ver LICENSE na raiz.
import { basename } from "node:path";
import { openSession, resolveChrome, startServer } from "@frankframes/engine";
import type { GpuMode } from "@frankframes/engine";
import { prepare } from "./render.ts";

export interface GoldenFrame {
  frame: number;
  sha256: string;
  /** PNG do frame, para comparação tolerante quando o hash diverge. */
  png?: Buffer;
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
  options: { gpu?: GpuMode; ratios?: number[]; includePng?: boolean } = {},
): Promise<GoldenBlock> {
  // Verificação pode rodar em paralelo; sob carga, exige mais leituras estáveis.
  const shots = Math.max(1, Number(process.env.FRANKFRAMES_GOLDEN_SHOTS) || 5);
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
    // Goldens são verificação, não caminho de velocidade: exigem frames estáveis.
    captureShots: shots,
  });

  try {
    const frames: GoldenFrame[] = [];
    const samples = sampleFrames(prepared.totalFrames);

    // Aquecimento: a primeira captura de uma sessão nova ainda carrega estado de
    // composição. Uma rodada no primeiro frame amostrado é descartada.
    await session.seekFrame(samples[0]!, prepared.fps);
    await session.capture();
    void shots;

    for (const frame of samples) {
      await session.seekFrame(frame, prepared.fps);
      const { png, sha256 } = await session.capture();
      frames.push({ frame, sha256, ...(options.includePng === true ? { png } : {}) });
    }
    const errors = session.pageErrors();
    if (errors.length > 0) throw new Error(`erros na página em ${entry}: ${errors[0]}`);
    return { name: basename(prepared.entryDir), durationSeconds: prepared.seconds, frames };
  } finally {
    await session.close();
    await server.close();
  }
}

/** Um frame no meio do bloco, como PNG, para thumbnail. */
export async function captureFrameAt(entry: string, ratio = 0.5): Promise<{ png: Buffer; frame: number; totalFrames: number }> {
  const prepared = await prepare({ entry });
  const server = await startServer(prepared.entryDir, {
    ...(prepared.mediaDir !== undefined ? { mediaRoot: prepared.mediaDir } : {}),
    ...(prepared.manifest !== undefined ? { manifest: prepared.manifest } : {}),
    page: { path: basename(prepared.entry), html: prepared.compiledHtml },
  });
  const session = await openSession({
    url: `${server.url}${basename(prepared.entry)}`,
    viewport: prepared.viewport,
    gpu: "software",
    captureShots: 3,
  });
  try {
    const frame = Math.min(prepared.totalFrames - 1, Math.round(ratio * (prepared.totalFrames - 1)));
    await session.seekFrame(frame, prepared.fps);
    const { png } = await session.capture();
    return { png, frame, totalFrames: prepared.totalFrames };
  } finally {
    await session.close();
    await server.close();
  }
}

export async function engineSignature(gpu: GpuMode = "software"): Promise<GoldenManifest["engine"]> {
  const chrome = await resolveChrome();
  return { browser: chrome.version, gpu, viewport: "nativo" };
}
