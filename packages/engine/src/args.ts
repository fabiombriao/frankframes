// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * `auto` é o padrão: usa GPU quando existe, cai para SwiftShader quando não.
 * `software` é o modo de garantia entre máquinas (é o que roda no gate).
 * `hardware` força ANGLE no driver real, mesmo que a sonda discorde.
 */
export type GpuMode = "auto" | "software" | "hardware";
export type ResolvedGpuMode = "software" | "hardware";

export interface Viewport {
  width: number;
  height: number;
}

/**
 * Flags fixas. Toda flag aqui existe para tirar uma fonte de variação do pixel
 * (hinting, subpixel AA, perfil de cor, throttling de aba em background).
 */
const DETERMINISM_FLAGS = [
  "--hide-scrollbars",
  "--force-color-profile=srgb",
  "--force-device-scale-factor=1",
  "--disable-lcd-text",
  "--font-render-hinting=none",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-media-suspend",
  "--disable-sync",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-breakpad",
  "--disable-hang-monitor",
  "--disable-domain-reliability",
  "--disable-component-update",
  "--disable-print-preview",
  "--no-pings",
  "--autoplay-policy=no-user-gesture-required",
];

/**
 * `software`: SwiftShader, reprodutível entre máquinas, mais lento.
 * `hardware`: ANGLE no driver real, mais rápido; o pixel passa a depender do driver (compositor em software).
 */
export function gpuFlags(mode: ResolvedGpuMode, platform: string = process.platform): string[] {
  if (mode === "software") {
    return [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      // SwiftShader retém camada transformada por vários frames e re-apresenta
      // raster parcial; sem isso, blocos com clip-path/transform divergem.
      "--disable-gpu-compositing",
    ];
  }
  // EDT-77: com vários workers, o compositor de GPU não reproduzia hash na mesma máquina (110 de 240 frames
  // instáveis com 6 workers; 0 com 1 worker). Só o compositor vira software, como em `software`: o ANGLE segue
  // no driver real e WebGL/canvas continuam na GPU. Medido: 0/240 instáveis em 5 rodadas intercaladas.
  const semCompositorGpu = "--disable-gpu-compositing";
  if (platform === "win32") return ["--use-angle=d3d11", semCompositorGpu];
  if (platform === "darwin") return ["--use-angle=metal", semCompositorGpu];
  return ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu-rasterization", "--ignore-gpu-blocklist", semCompositorGpu];
}

export function chromeArgs(options: { viewport: Viewport; gpu: ResolvedGpuMode }): string[] {
  return [
    ...DETERMINISM_FLAGS,
    ...gpuFlags(options.gpu),
    `--window-size=${options.viewport.width},${options.viewport.height}`,
  ];
}
