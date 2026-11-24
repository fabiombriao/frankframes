// FrankFrames — proprietário. Ver LICENSE na raiz.
import { basename, extname, resolve } from "node:path";
import { FramesError, inspectFrames, resolveFfmpeg } from "@frankframes/producer";

const USAGE = "uso: frankframes frames <video.mp4|.webm> [--at 10%,50%,90%|1.5,3] [-o pasta] [--json]";
const DEFAULT_AT = "10%,50%,90%";

interface FramesArgs {
  input: string;
  at: string;
  out: string;
  json: boolean;
}

function parseArgs(argv: string[]): FramesArgs {
  let input: string | undefined;
  let at = DEFAULT_AT;
  let out: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--at" || arg === "-o" || arg === "--out") {
      const value = argv[++i];
      if (value === undefined || value === "") throw new Error(`${arg} precisa de um valor\n${USAGE}`);
      if (arg === "--at") at = value;
      else out = value;
    } else if (arg.startsWith("-")) throw new Error(`opção desconhecida: ${arg}\n${USAGE}`);
    else if (input === undefined) input = arg;
    else throw new Error(`um vídeo por vez (recebi também "${arg}")\n${USAGE}`);
  }
  if (input === undefined) throw new Error(`falta o vídeo\n${USAGE}`);
  return { input, at, out: out ?? `out/frames/${basename(input, extname(input))}`, json };
}

/** `frankframes frames`: extrai frames-chave de um vídeo e diz se algum está chapado. Devolve o código de saída. */
export async function runFramesCommand(argv: string[]): Promise<number> {
  let args: FramesArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  try {
    const pair = await resolveFfmpeg();
    const report = await inspectFrames({ ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe, input: resolve(args.input), at: args.at, outDir: resolve(args.out) });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${report.file} · ${report.durationSeconds} s\n`);
      for (const frame of report.frames) {
        process.stdout.write(`  t=${frame.t} s  luma ${frame.meanLuma} ± ${frame.stdLuma}${frame.uniform ? "  CHAPADO" : ""}  ${frame.png}\n`);
      }
      const flat = report.frames.filter((frame) => frame.uniform).length;
      if (flat > 0) process.stdout.write(`${flat} frame(s) chapado(s): confira se a cena devia estar vazia\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof FramesError) {
      process.stderr.write(`erro ${error.code}: ${error.message}\n  → ${error.hint}\n`);
      if (args.json) process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message, hint: error.hint }, null, 2)}\n`);
    } else {
      process.stderr.write(`erro: ${(error as Error).message}\n`);
    }
    return 1;
  }
}
