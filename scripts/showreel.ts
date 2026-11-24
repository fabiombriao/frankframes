// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Showreel: renderiza todos os blocos do catálogo e concatena num único MP4.
 *
 *   node scripts/showreel.ts [saida.mp4] [--limit N] [--workers 4] [--parallel 2]
 *
 * Blocos 9:16 entram pillarboxed em 1920×1080 com fundo escuro.
 */
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { removeOrWarn } from "@frankframes/engine";
import { resolveFfmpeg, renderComposition } from "@frankframes/producer";
import { listBlocks } from "@frankframes/catalog";
import { mapPool } from "./pool.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);

const flag = (name: string, fallback: number): number => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback;
};

const output = args.find((arg) => !arg.startsWith("-")) ?? join(root, "out", "showreel.mp4");
const limit = flag("--limit", 0);
const workers = flag("--workers", 4);
const parallel = flag("--parallel", 2);

const pair = await resolveFfmpeg();
const catalog = listBlocks();
const blocks = limit === 0 ? catalog : catalog.slice(0, limit);
const work = await mkdtemp(join(tmpdir(), "ff-reel-"));
const started = Date.now();

try {
  process.stdout.write(`showreel: ${blocks.length} blocos · workers ${workers} · ${parallel} em paralelo\n`);

  const raw = await mapPool(blocks, parallel, async (block) => {
    const outPath = join(work, `raw-${block.slug}.mp4`);
    const result = await renderComposition({
      entry: join(block.dir, "index.html"),
      outPath,
      ffmpeg: pair.ffmpeg,
      ffprobe: pair.ffprobe,
      codec: "av1",
      preset: "draft",
      workers,
    });
    process.stdout.write(`  render ${block.slug.padEnd(22)} ${result.frames} frames · ${result.durationSeconds.toFixed(1)}s\n`);
    return outPath;
  });

  // Normaliza para 1920×1080/30 para permitir concat sem re-encode entre trechos.
  const normalized = await mapPool(raw, parallel, async (input, index) => {
    const outPath = join(work, `norm-${String(index).padStart(3, "0")}.mp4`);
    await run(pair.ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-i", input,
      "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b0b0f,fps=30,setsar=1",
      "-c:v", "libsvtav1", "-preset", "10", "-crf", "32", "-pix_fmt", "yuv420p",
      "-r", "30", "-video_track_timescale", "90000", "-an", "-y", outPath,
    ]);
    return outPath;
  });

  const listPath = join(work, "list.txt");
  await writeFile(listPath, normalized.map((file) => `file '${file.split("\\").join("/")}'`).join("\n") + "\n");
  await run(pair.ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-c", "copy", "-movflags", "+faststart", "-y", output,
  ]);

  const { stdout } = await run(pair.ffprobe, [
    "-v", "error", "-show_entries", "format=duration,size:stream=codec_name,nb_frames,width,height",
    "-of", "default=nw=1", output,
  ]);
  process.stdout.write(`\n${output}\n${stdout.trim()}\n`);
  process.stdout.write(`tempo total ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
} finally {
  // Limpeza que falha não derruba o showreel pronto, mas aparece no stderr com o caminho.
  await removeOrWarn(work);
}
