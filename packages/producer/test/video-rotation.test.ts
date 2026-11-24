// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { MediaRotationError, extractFrames, openSessionFor, probeVideo, resolveChrome, startServer } from "@frankframes/engine";
import { RenderError, prepare } from "../src/render.ts";
import { resolveFfmpeg } from "../src/ffmpeg.ts";
import type { FfmpegPair } from "../src/ffmpeg.ts";
import { tempDir } from "../../../scripts/test-support/temp.ts";

/**
 * EDT-86: vídeo de celular em retrato é gravado em paisagem com uma Display Matrix de rotação. Extração, preview,
 * Studio e render passam pelos mesmos frames extraídos (`<video>` vira `<img>`), então a orientação tem de ser a de
 * exibição em todos; rotação que o navegador e o FFmpeg não aplicariam igual falha alto com `E_MEDIA_ROTATION`.
 */
const run = promisify(execFile);
const FPS = { num: 10, den: 1 };

type Color = "R" | "G" | "B" | "?";
type Corners = [Color, Color, Color, Color];

/**
 * Padrão assimétrico gravado em 160x96: metade esquerda vermelha, direita azul, quadrado verde no canto superior
 * esquerdo. Cada orientação de exibição dá uma combinação única nos quatro cantos (tl, tr, bl, br).
 */
const SOURCE = "color=c=red:s=160x96:r=10:d=1,drawbox=x=iw/2:y=0:w=iw/2:h=ih:color=blue:t=fill,drawbox=x=0:y=0:w=40:h=32:color=lime:t=fill";

interface Case {
  name: string;
  /** Opções de entrada do FFmpeg que gravam a Display Matrix (`-c copy`, sem tocar nos pixels). */
  flags: string[];
  rotation: number;
  mirrored: boolean;
  /** Tamanho em que o vídeo aparece. */
  display: [number, number];
  /** Cantos esperados do frame de exibição, derivados da geometria acima. */
  corners: Corners;
}

const CASES: Case[] = [
  { name: "sem rotação", flags: [], rotation: 0, mirrored: false, display: [160, 96], corners: ["G", "B", "R", "B"] },
  { name: "rotação -90 (celular em retrato)", flags: ["-display_rotation", "270"], rotation: -90, mirrored: false, display: [96, 160], corners: ["R", "G", "B", "B"] },
  { name: "rotação 90", flags: ["-display_rotation", "90"], rotation: 90, mirrored: false, display: [96, 160], corners: ["B", "B", "G", "R"] },
  { name: "rotação 180", flags: ["-display_rotation", "180"], rotation: -180, mirrored: false, display: [160, 96], corners: ["B", "R", "B", "G"] },
  { name: "espelho horizontal", flags: ["-display_hflip"], rotation: -180, mirrored: true, display: [160, 96], corners: ["B", "G", "B", "R"] },
];

async function ffmpegOrSkip(t: TestContext): Promise<FfmpegPair | undefined> {
  const pair = await resolveFfmpeg();
  try {
    await run(pair.ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
    return pair;
  } catch {
    t.skip("ffmpeg não encontrado");
    return undefined;
  }
}

async function chromeOrSkip(t: TestContext): Promise<boolean> {
  try {
    await resolveChrome();
    return true;
  } catch {
    t.skip("Chrome não encontrado");
    return false;
  }
}

/** Gera o vídeo 160x96 e regrava só o contêiner com a Display Matrix pedida (mpeg4: nada de libx264). */
async function makeVideo(pair: FfmpegPair, dir: string, name: string, flags: string[]): Promise<string> {
  const base = join(dir, `${name}-base.mp4`);
  await run(pair.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", SOURCE, "-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p", "-y", base]);
  const out = join(dir, `${name}.mp4`);
  await run(pair.ffmpeg, ["-hide_banner", "-loglevel", "error", ...flags, "-i", base, "-c", "copy", "-y", out]);
  return out;
}

/** Cor dominante de cada canto (3 px para dentro), a partir dos pixels RGB crus. */
function cornersOf(rgb: Buffer, stride: number, x0: number, y0: number, width: number, height: number): Corners {
  const at = (x: number, y: number): Color => {
    const offset = ((y0 + y) * stride + x0 + x) * 3;
    const [r, g, b] = [rgb[offset]!, rgb[offset + 1]!, rgb[offset + 2]!];
    if (r > 180 && g < 90 && b < 90) return "R";
    if (g > 180 && r < 90 && b < 90) return "G";
    if (b > 180 && r < 90 && g < 90) return "B";
    return "?";
  };
  return [at(3, 3), at(width - 4, 3), at(3, height - 4), at(width - 4, height - 4)];
}

/** Decodifica uma imagem (JPEG ou PNG) para RGB cru com o próprio FFmpeg do projeto. */
async function decodeRgb(pair: FfmpegPair, file: string, bytes: number): Promise<Buffer> {
  const { stdout } = await run(pair.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], {
    encoding: "buffer",
    maxBuffer: 64 << 20,
  });
  assert.equal(stdout.length, bytes, `${basename(file)}: tamanho do RGB cru`);
  return stdout;
}

const composition = (video: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style></head><body>
<div data-composition-id="rot" data-root="true" data-width="256" data-height="256" data-fps="10" data-duration="1">
  ${video}
</div></body></html>`;

test("probe: dimensões gravadas, rotação e dimensões de exibição do FFmpeg real", { timeout: 120_000 }, async (t) => {
  const pair = await ffmpegOrSkip(t);
  if (pair === undefined) return;
  const dir = await tempDir(t, "ff-rot-probe-");
  for (const item of CASES) {
    const file = await makeVideo(pair, dir, `p${item.rotation}${item.mirrored ? "m" : ""}`, item.flags);
    const probe = await probeVideo(pair.ffprobe, file);
    assert.deepEqual(
      { w: probe.width, h: probe.height, rotation: probe.rotation, mirrored: probe.mirrored, dw: probe.displayWidth, dh: probe.displayHeight },
      { w: 160, h: 96, rotation: item.rotation, mirrored: item.mirrored, dw: item.display[0], dh: item.display[1] },
      item.name,
    );
    assert.ok(probe.duration > 0.9 && probe.duration < 1.2, `duração ${probe.duration}`);
  }
});

test("extração: o frame sai na orientação de exibição, com o tamanho do probe", { timeout: 120_000 }, async (t) => {
  const pair = await ffmpegOrSkip(t);
  if (pair === undefined) return;
  const dir = await tempDir(t, "ff-rot-extract-");
  for (const item of CASES) {
    const file = await makeVideo(pair, dir, `e${item.rotation}${item.mirrored ? "m" : ""}`, item.flags);
    const probe = await probeVideo(pair.ffprobe, file);
    const out = join(dir, `frames-${item.rotation}${item.mirrored ? "m" : ""}`);
    await extractFrames({
      ffmpeg: pair.ffmpeg,
      input: file,
      outDir: out,
      fps: FPS,
      expectDisplay: { width: probe.displayWidth, height: probe.displayHeight },
    });
    const [w, h] = item.display;
    const rgb = await decodeRgb(pair, join(out, "000000.jpg"), w * h * 3);
    assert.deepEqual(cornersOf(rgb, w, 0, 0, w, h), item.corners, `${item.name}: orientação do frame extraído`);
  }
});

test("extração falha alto quando o frame não tem o tamanho de exibição", { timeout: 120_000 }, async (t) => {
  const pair = await ffmpegOrSkip(t);
  if (pair === undefined) return;
  const dir = await tempDir(t, "ff-rot-mismatch-");
  const file = await makeVideo(pair, dir, "m", ["-display_rotation", "270"]);
  // 160x96 é o tamanho gravado, não o de exibição (96x160): o que o FFmpeg entrega não bate e a extração recusa.
  await assert.rejects(
    extractFrames({ ffmpeg: pair.ffmpeg, input: file, outDir: join(dir, "out"), fps: FPS, expectDisplay: { width: 160, height: 96 } }),
    (error: unknown) => error instanceof MediaRotationError && error.code === "E_MEDIA_ROTATION" && error.message.includes("96x160") && error.hint.length > 0,
  );
});

test("render e preview mostram o frame na mesma orientação do frame extraído", { timeout: 300_000 }, async (t) => {
  const pair = await ffmpegOrSkip(t);
  if (pair === undefined || !(await chromeOrSkip(t))) return;
  const dir = await tempDir(t, "ff-rot-render-");

  // -90 é o caso do celular em retrato; 90 e o espelho cobrem as demais; todos pelo caminho do render e do preview.
  for (const item of CASES.filter((c) => ["rotação -90 (celular em retrato)", "rotação 90", "espelho horizontal"].includes(c.name))) {
    const slug = `r${item.rotation}${item.mirrored ? "m" : ""}`;
    await makeVideo(pair, dir, slug, item.flags);
    const [w, h] = item.display;
    const entry = join(dir, `${slug}.html`);
    await writeFile(entry, composition(`<video data-clip-id="v" data-start="0" src="${slug}.mp4" style="position:absolute;left:0;top:0;width:${w}px;height:${h}px;object-fit:fill"></video>`));

    const prepared = await prepare({ entry, ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe });
    assert.ok(prepared.manifest !== undefined && prepared.mediaDir !== undefined, "o vídeo precisa gerar manifesto");
    const clip = prepared.manifest.clips[0]!;
    assert.deepEqual(
      clip.orientation,
      { rotation: item.rotation, mirrored: item.mirrored, displayWidth: w, displayHeight: h },
      `${item.name}: o manifesto leva a orientação de exibição`,
    );

    // Frame extraído (o que o render e o preview servem em `/__ff_media/`).
    const extracted = await decodeRgb(pair, join(prepared.mediaDir, clip.dir, "000000.jpg"), w * h * 3);
    const extractedCorners = cornersOf(extracted, w, 0, 0, w, h);
    assert.deepEqual(extractedCorners, item.corners, `${item.name}: frame extraído`);

    // Frame renderizado: a captura do Chrome com a `<img>` no lugar do `<video>`.
    const server = await startServer(prepared.entryDir, {
      mediaRoot: prepared.mediaDir,
      manifest: prepared.manifest,
      page: { path: basename(prepared.entry), html: prepared.compiledHtml },
    });
    const session = await openSessionFor(server, { url: `${server.url}${basename(prepared.entry)}`, viewport: prepared.viewport, gpu: "software" });
    try {
      await session.seekFrame(0, FPS);
      const shown = await session.evaluate<{ natural: [number, number]; box: [number, number] }>(`(() => {
        const img = document.querySelector("img[data-ff-media]");
        const rect = img.getBoundingClientRect();
        return { natural: [img.naturalWidth, img.naturalHeight], box: [Math.round(rect.width), Math.round(rect.height)] };
      })()`);
      assert.deepEqual(shown.natural, [w, h], `${item.name}: a <img> tem o tamanho de exibição, não o gravado`);
      assert.deepEqual(shown.box, [w, h]);

      const png = join(dir, `${slug}.png`);
      await writeFile(png, (await session.capture()).png);
      const { width, height } = prepared.viewport;
      const rgb = await decodeRgb(pair, png, width * height * 3);
      assert.deepEqual(cornersOf(rgb, width, 0, 0, w, h), extractedCorners, `${item.name}: o frame renderizado tem a orientação do frame extraído`);
    } finally {
      await session.close();
      await server.close();
    }
  }
});

test("rotação que não é múltipla de 90 falha no probe com E_MEDIA_ROTATION, mesmo com data-duration", { timeout: 120_000 }, async (t) => {
  const pair = await ffmpegOrSkip(t);
  if (pair === undefined) return;
  const dir = await tempDir(t, "ff-rot-45-");
  // O FFmpeg gira 45° com cantos pretos e o navegador ignora o ângulo: preview e render divergiriam.
  await makeVideo(pair, dir, "giro", ["-display_rotation", "45"]);

  for (const attrs of ['data-start="0"', 'data-start="0" data-duration="1"']) {
    const entry = join(dir, "giro.html");
    await writeFile(entry, composition(`<video data-clip-id="v" ${attrs} src="giro.mp4" style="position:absolute;left:0;top:0;width:160px;height:96px"></video>`));
    await assert.rejects(
      prepare({ entry, ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe }),
      (error: unknown) =>
        error instanceof RenderError &&
        error.code === "E_MEDIA_ROTATION" &&
        error.stage === "probe" &&
        error.message.includes("45") &&
        /reexporte/.test(error.message),
      attrs,
    );
  }
});
