// FrankFrames — proprietário. Ver LICENSE na raiz.
import puppeteer from "puppeteer-core";
import { chromeArgs } from "./args.ts";
import type { ResolvedGpuMode } from "./args.ts";
import { browserSignalOptions } from "./signals.ts";

const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|lavapipe|softpipe|mesa offscreen|basic render|software/i;

export interface RendererInfo {
  renderer: string;
  hardware: boolean;
}

/** Uma sonda por binário por processo: quatro workers não abrem quatro browsers de teste. */
const probes = new Map<string, Promise<RendererInfo>>();

/**
 * Sonda de GPU: lança o Chrome com as flags de hardware e lê o renderer real.
 * É o que decide `auto`. Sem WebGL, assume software.
 */
export function probeRenderer(executablePath: string): Promise<RendererInfo> {
  const cached = probes.get(executablePath);
  if (cached) return cached;

  const probe = (async (): Promise<RendererInfo> => {
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: chromeArgs({ viewport: { width: 320, height: 200 }, gpu: "hardware" }),
      defaultViewport: { width: 320, height: 200, deviceScaleFactor: 1 },
      ...browserSignalOptions(),
    });
    try {
      const page = await browser.newPage();
      const renderer = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
        if (!gl) return "sem WebGL";
        const info = gl.getExtension("WEBGL_debug_renderer_info");
        return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "sem extensão de debug";
      });
      return { renderer, hardware: !SOFTWARE_RENDERERS.test(renderer) };
    } finally {
      await browser.close();
    }
  })();

  probes.set(executablePath, probe);
  probe.catch(() => probes.delete(executablePath));
  return probe;
}

/** `auto` -> hardware se a sonda achar GPU de verdade; senão SwiftShader. */
export async function resolveGpuMode(
  mode: "auto" | "software" | "hardware",
  executablePath: string,
): Promise<ResolvedGpuMode> {
  if (mode !== "auto") return mode;
  const probe = await probeRenderer(executablePath);
  return probe.hardware ? "hardware" : "software";
}
