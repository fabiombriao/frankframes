// FrankFrames — proprietário. Ver LICENSE na raiz.
import { existsSync } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { removeOrWarn } from "@frankframes/engine";
import { analyzeFaces, faceComposition, trackFaces } from "@frankframes/producer";

const USAGE = "uso: frankframes reframe <vídeo> -o <pasta> [--start S] [--duration S] [--swap]";

export async function runReframeCommand(argv: string[]): Promise<number> {
  let input: string;
  let folder: string;
  let start: number;
  let duration: number | undefined;
  let swap: boolean;
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      out: { type: "string", short: "o" },
      start: { type: "string" },
      duration: { type: "string" },
      swap: { type: "boolean" },
    } });
    if (positionals.length !== 1 || !values.out) throw new Error("informe um vídeo e a pasta de saída");
    input = resolve(positionals[0]!);
    folder = resolve(values.out);
    swap = values.swap ?? false;
    start = Number(values.start ?? 0);
    duration = values.duration === undefined ? undefined : Number(values.duration);
    if (values.start === "" || !Number.isFinite(start) || start < 0 ||
        (duration !== undefined && (!Number.isFinite(duration) || duration <= 0))) {
      throw new Error("use início >= 0 e duração > 0, em segundos");
    }
  } catch (error) {
    process.stderr.write((error as Error).message + "\n" + USAGE + "\n");
    return 2;
  }
  try {
    if (existsSync(folder)) throw new Error("a pasta de saída já existe: " + folder);
    if (!(await stat(input)).isFile()) throw new Error("a entrada precisa ser um arquivo de vídeo");
    process.stderr.write("Detectando rostos em " + basename(input) + "…\n");
    const analysis = await analyzeFaces(input, start, duration);
    const tracks = trackFaces(analysis.samples, analysis.aspect);
    const media = "source" + extname(input).toLowerCase();
    await mkdir(dirname(folder), { recursive: true });
    await mkdir(folder);
    try {
      const assets = join(folder, "assets");
      await mkdir(assets);
      await copyFile(input, join(assets, media));
      await writeFile(join(folder, "index.html"), faceComposition("assets/" + media, start, analysis.duration, tracks, swap));
    } catch (error) {
      await removeOrWarn(folder);
      throw error;
    }
    process.stdout.write("GPU: " + analysis.adapter + "\n");
    process.stdout.write("Detecções esquerda/direita: " + tracks.left.found + "/" + tracks.right.found + " em " + analysis.samples.length + " amostras\n");
    process.stdout.write(join(folder, "index.html") + "\n");
    return 0;
  } catch (error) {
    process.stderr.write("reframe: " + (error as Error).message + "\n");
    return 1;
  }
}
