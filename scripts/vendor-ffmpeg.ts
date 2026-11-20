// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Instala o FFmpeg LGPL pinado em `vendor/ffmpeg` (ou FRANKFRAMES_HOME). */
import { ensureFfmpeg } from "../packages/cli/src/setup.ts";

const result = await ensureFfmpeg();
process.stdout.write(`${result.state} ${result.name}: ${result.detail}\n`);
process.exit(result.state === "falhou" ? 1 : 0);
