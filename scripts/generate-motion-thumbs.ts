// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Gera `catalog/motion/thumbs/<nome>.gif` para cada preset de motion (docs/motion.md).
 * Cena de 320×180 a 15 fps: cartão "Aa" sobre fundo escuro, renderizado pelo próprio engine.
 * O GIF não é teste de determinismo: regenerar pode mudar bytes (Chrome e fonte).
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openSession, startServer } from "@frankframes/engine";
import type { Session } from "@frankframes/engine";
import { listPresets } from "@frankframes/contract";
import type { PresetDef } from "@frankframes/contract";
import { prepare, resolveFfmpeg } from "@frankframes/producer";
import { defaultConcurrency, mapPool } from "./pool.ts";

const run = promisify(execFile);
const target = fileURLToPath(new URL("../catalog/motion/thumbs/", import.meta.url));

const FPS = 15;
/** Margem parada antes e depois do movimento, em segundos. */
const MARGIN = 0.3;
/** Teto por arquivo (docs/motion.md). */
const MAX_BYTES = 200 * 1024;
const MAX_COLORS = 48;

const ATTR_OF = { enter: "data-enter", exit: "data-exit", emphasis: "data-emphasis" } as const;

/** Atributo de motion do cartão: entrada e ênfase começam depois da margem; a saída termina antes do fim. */
function motionAttr(preset: PresetDef): string {
  const kind = preset.kind;
  if (kind !== "enter" && kind !== "exit" && kind !== "emphasis") throw new Error(`preset ${preset.name}: tipo sem miniatura: ${kind}`);
  const at = kind === "exit" ? `end-${MARGIN}` : String(MARGIN);
  return `${ATTR_OF[kind]}="${preset.name} at=${at}"`;
}

/** Cena do preset. Duração: dur × ciclos padrão + margem dos dois lados. */
function sceneHtml(preset: PresetDef): { html: string; seconds: number } {
  const defaults: Record<string, number> = {};
  for (const spec of preset.params) {
    if (spec.kind === "number" || spec.kind === "int") defaults[spec.key] = spec.default;
  }
  const seconds = Number((preset.dur * preset.cycles(defaults) + 2 * MARGIN).toFixed(3));
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${preset.name}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #14161a; }
  .stage { position: relative; width: 320px; height: 180px; overflow: hidden; background: #14161a; font-family: "Inter", sans-serif; }
  .card {
    position: absolute; left: 90px; top: 55px; width: 140px; height: 70px;
    display: flex; align-items: center; justify-content: center;
    background: #e8e4da; color: #14161a; font-size: 38px; font-weight: 700;
  }
</style>
</head>
<body>
<div class="stage" data-composition-id="thumb-${preset.name}" data-root="true" data-width="320" data-height="180" data-fps="${FPS}" data-duration="${seconds}">
  <div class="card" data-clip-id="card" data-start="0" data-duration="${seconds}" ${motionAttr(preset)}>Aa</div>
</div>
</body>
</html>
`;
  return { html, seconds };
}

async function makeGif(preset: PresetDef, work: string, ffmpeg: string): Promise<{ bytes: number; frames: number }> {
  const dir = join(work, preset.name);
  await mkdir(dir, { recursive: true });
  const { html } = sceneHtml(preset);
  const entry = join(dir, "index.html");
  await writeFile(entry, html);

  const prepared = await prepare({ entry, workDir: join(dir, "work") });
  const server = await startServer(prepared.entryDir, {
    ...(prepared.mediaDir !== undefined ? { mediaRoot: prepared.mediaDir } : {}),
    ...(prepared.manifest !== undefined ? { manifest: prepared.manifest } : {}),
    page: { path: basename(prepared.entry), html: prepared.compiledHtml },
  });
  let session: Session | undefined;
  try {
    session = await openSession({
      url: `${server.url}${basename(prepared.entry)}`,
      viewport: prepared.viewport,
      gpu: "software",
      captureShots: 3,
      serverFailures: server.failures,
    });
    for (let frame = 0; frame < prepared.totalFrames; frame++) {
      await session.seekFrame(frame, prepared.fps);
      const { png } = await session.capture();
      await writeFile(join(dir, `${String(frame + 1).padStart(4, "0")}.png`), png);
    }
    const errors = session.pageErrors();
    if (errors.length > 0) throw new Error(`erros na página de ${preset.name}: ${errors[0]}`);
  } finally {
    try {
      await session?.close();
    } finally {
      await server.close();
    }
  }

  const out = join(target, `${preset.name}.gif`);
  await run(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-framerate",
    String(FPS),
    "-i",
    join(dir, "%04d.png"),
    "-vf",
    `split[a][b];[a]palettegen=max_colors=${MAX_COLORS}[p];[b][p]paletteuse=dither=none`,
    "-loop",
    "0",
    out,
  ]);
  const { size } = await stat(out);
  if (size > MAX_BYTES) {
    throw new Error(`miniatura de ${preset.name} tem ${(size / 1024).toFixed(0)} KB, acima do teto de ${MAX_BYTES / 1024} KB (max_colors=${MAX_COLORS})`);
  }
  return { bytes: size, frames: prepared.totalFrames };
}

const presets = listPresets();
const work = await mkdtemp(join(tmpdir(), "frankframes-motion-thumbs-"));
try {
  await mkdir(target, { recursive: true });
  const { ffmpeg } = await resolveFfmpeg();
  const results = await mapPool(presets, defaultConcurrency(), async (preset) => {
    const result = await makeGif(preset, work, ffmpeg);
    process.stdout.write(`${preset.name.padEnd(18)} ${String(result.frames).padStart(3)} quadros · ${(result.bytes / 1024).toFixed(0)} KB\n`);
    return result;
  });
  // GIF de preset que não existe mais é lixo: remove.
  const wanted = new Set(presets.map((p) => `${p.name}.gif`));
  for (const file of await readdir(target)) {
    if (file.endsWith(".gif") && !wanted.has(file)) {
      await rm(join(target, file));
      process.stdout.write(`removido órfão ${file}\n`);
    }
  }
  const total = results.reduce((sum, r) => sum + r.bytes, 0);
  process.stdout.write(`${presets.length} miniaturas · ${(total / 1024).toFixed(0)} KB no total\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
