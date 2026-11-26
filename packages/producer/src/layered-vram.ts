// FrankFrames — proprietário. Ver LICENSE na raiz.
import type { Fps } from "@frankframes/contract";
import type { Preset } from "@frankframes/encode";
import type { Viewport } from "@frankframes/engine";
import type { GlassRegion } from "./layered-capture.ts";

export const vulkanDeviceArgs = ["-init_hw_device", "vulkan=ffgpu:NVIDIA", "-filter_hw_device", "ffgpu"];
export const vulkanDecodeArgs = ["-hwaccel", "vulkan", "-hwaccel_device", "ffgpu", "-hwaccel_output_format", "vulkan"];

export const rgbVulkan = "format=rgba:colorspace=gbr:color_trc=iec61966-2-1:color_primaries=bt709:range=pc:disable_linear=1:dithering=none";
export const uploadRgba = "format=rgba,setparams=range=pc:colorspace=gbr:color_trc=iec61966-2-1:color_primaries=bt709,hwupload";
export const encodeVulkan = "libplacebo=format=nv12:colorspace=smpte170m:range=tv:disable_linear=1:dithering=none,format=vulkan";

export function vulkanRotation(rotation: number, width: number, height: number): string[] {
  // O libplacebo respeita o recorte da superfície decodificada, inclusive quando a imagem foi alinhada a macroblocos.
  if (rotation === 0) return [];
  const clockwise = (360 - rotation) % 360;
  return [`libplacebo=w=${width}:h=${height}:rotate=${clockwise}:format=nv12`, "format=vulkan"];
}

export function vulkanEncoderArgs(viewport: Viewport, fps: Fps, preset: Preset): string[] {
  const perPixel = { draft: 0.016, standard: 0.0265, high: 0.052 }[preset];
  const rate = Math.max(100_000, Math.round(viewport.width * viewport.height * fps.num / fps.den * perPixel));
  return ["-c:v", "av1_vulkan", "-bf", "0", "-tune", "hq", "-rc_mode", "vbr", "-b:v", String(rate), "-maxrate", String(rate * 2), "-bufsize", String(rate * 4)];
}

export function vulkanOverlay(base: string, overlay: string, out: string, viewport: Viewport, position?: Viewport & { x: number; y: number }): string {
  const place = position === undefined ? "" : [
    `pos_x='if(eq(idx,0),0,${position.x})'`,
    `pos_y='if(eq(idx,0),0,${position.y})'`,
    `pos_w='if(eq(idx,0),ow,${position.width})'`,
    `pos_h='if(eq(idx,0),oh,${position.height})'`,
  ].join(":") + ":";
  return `${base}${overlay}libplacebo=inputs=2:w=${viewport.width}:h=${viewport.height}:${place}${rgbVulkan},format=vulkan${out}`;
}

export type CssVideoFilter = { kind: "contrast" | "brightness" | "saturate"; amount: number };

export function colorShader(filters: CssVideoFilter[]): string {
  const operations = filters.map(({ kind, amount }) => {
    const value = amount.toFixed(8);
    if (kind === "saturate") return `rgb = quantize(mix(vec3(dot(rgb, vec3(0.213, 0.715, 0.072))), rgb, ${value}));`;
    if (kind === "contrast") return `rgb = quantize((rgb - 0.5) * ${value} + 0.5);`;
    return `rgb = quantize(rgb * ${value});`;
  });
  return `//!HOOK MAIN
//!BIND HOOKED
vec3 quantize(vec3 value) {
    return floor(clamp(value, 0.0, 1.0) * 255.0 + 0.5) / 255.0;
}
vec4 hook() {
    vec4 c = HOOKED_tex(HOOKED_pos);
    vec3 rgb = c.rgb;
    ${operations.join("\n    ")}
    return vec4(rgb, c.a);
}
`;
}

/** Usa amostragem linear para avaliar dois pesos gaussianos adjacentes em uma leitura. */
function gaussian(sigma: number): { center: number; pairs: Array<[number, number]> } {
  const extent = Math.min(768, Math.max(1, Math.ceil(3 * sigma)));
  const weights = Array.from({ length: extent + 2 }, (_, i) => i > extent ? 0 : Math.exp(-(i * i) / (2 * sigma * sigma)));
  const sum = weights[0]! + 2 * weights.slice(1).reduce((a, b) => a + b, 0);
  const pairs: Array<[number, number]> = [];
  for (let i = 1; i <= extent; i += 2) {
    const first = weights[i]!;
    const second = weights[i + 1]!;
    pairs.push([i + second / (first + second), (first + second) / sum]);
  }
  return { center: 1 / sum, pairs };
}

/** Vidro calculado em meia resolução, com composição e amostragem final na GPU. */
export function glassShader(sigma: number, frames: Array<GlassRegion[]>): string {
  const slots = frames.reduce((max, regions) => Math.max(max, regions.length), 0);
  const data = Buffer.alloc(frames.length * slots * 32);
  for (const [frame, regions] of frames.entries()) {
    for (const [index, region] of regions.entries()) {
      const fields = [region.x / 2, region.y / 2, region.width / 4, region.height / 4, region.radius / 2, region.opacity];
      for (const [field, value] of fields.entries()) data.writeFloatLE(value, (frame * slots + index) * 32 + field * 4);
    }
  }
  const { center, pairs } = gaussian(Math.max(0.05, sigma / 2));
  const pass = (input: string, output: string, axis: string): string => `//!HOOK MAIN
//!BIND ${input}
//!SAVE ${output}
//!WIDTH ${input}.w
//!HEIGHT ${input}.h
vec4 hook() {
    vec2 p = ${input}_pos;
    vec2 step = ${input}_pt * ${axis};
    vec4 c = ${input}_tex(p) * ${center.toFixed(12)};
    ${pairs.map(([offset, weight]) =>
      `c += (${input}_tex(p + step * ${offset.toFixed(8)}) + ${input}_tex(p - step * ${offset.toFixed(8)})) * ${weight.toFixed(12)};`).join("\n    ")}
    return c;
}
`;
  return `//!BUFFER glass_data
//!VAR vec4 regions[${frames.length * slots * 2}]
//!STORAGE
${data.toString("hex")}

//!HOOK MAIN
//!BIND HOOKED
//!SAVE half_image
//!WIDTH HOOKED.w 2 /
//!HEIGHT HOOKED.h 2 /
vec4 hook() { return HOOKED_tex(HOOKED_pos); }

${pass("half_image", "blur_x", "vec2(1.0, 0.0)")}
${pass("blur_x", "blur_y", "vec2(0.0, 1.0)")}
//!HOOK MAIN
//!BIND HOOKED
//!BIND blur_y
//!BIND glass_data
float mask_at(vec2 point, int base_index) {
    float opacity = 0.0;
    for (int i = 0; i < ${slots}; ++i) {
        vec4 box = regions[base_index + 2 * i];
        vec4 style = regions[base_index + 2 * i + 1];
        float r = min(style.x, min(box.z, box.w));
        vec2 distance = abs(point - box.xy - box.zw) - box.zw + r;
        float edge = length(max(distance, 0.0)) + min(max(distance.x, distance.y), 0.0) - r;
        opacity = mix(opacity, 1.0, clamp(0.5 - edge, 0.0, 1.0) * style.y);
    }
    return opacity;
}
vec4 hook() {
    // O contador do libplacebo avança nos quatro passes MAIN deste shader.
    int index = clamp(frame / 4 - 1, 0, ${frames.length - 1}) * ${slots * 2};
    vec2 p = HOOKED_pos * blur_y_size - 0.5;
    vec2 orig = floor(p) + 0.5;
    vec2 f = fract(p);
    float top = mix(mask_at(orig, index), mask_at(orig + vec2(1.0, 0.0), index), f.x);
    float bottom = mix(mask_at(orig + vec2(0.0, 1.0), index), mask_at(orig + 1.0, index), f.x);
    return mix(HOOKED_tex(HOOKED_pos), blur_y_tex(blur_y_pos), mix(top, bottom, f.y));
}
`;
}
