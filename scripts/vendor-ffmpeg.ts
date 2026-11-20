// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Baixa o FFmpeg LGPL pinado para `vendor/ffmpeg`.
 * O binário não é versionado: o que fica no repositório é este script, a versão,
 * o SHA-256 e a oferta de código-fonte.
 *
 * Uso: node scripts/vendor-ffmpeg.ts [--force]
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

/** Build LGPL (sem --enable-gpl), com libsvtav1, libvpx e libopenh264. */
export const FFMPEG_BUILD = {
  version: "n8.1.3-39-g660b5aa7db",
  archive: "ffmpeg-n8.1-latest-win64-lgpl-8.1.zip",
  url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-lgpl-8.1.zip",
  sha256: "e22cd9184816f0eb912e95a0adc39e4129f38bdff55974d6d21f2037440afde9",
  root: "ffmpeg-n8.1-latest-win64-lgpl-8.1",
} as const;

const TARGET = fileURLToPath(new URL("../vendor/ffmpeg/", import.meta.url));
const force = process.argv.includes("--force");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (!force && (await exists(join(TARGET, "bin", "ffmpeg.exe")))) {
  process.stdout.write(`vendor/ffmpeg já existe (${FFMPEG_BUILD.version}); use --force para refazer\n`);
  process.exit(0);
}

const work = await mkdtemp(join(tmpdir(), "ff-vendor-"));
const archive = join(work, FFMPEG_BUILD.archive);

process.stdout.write(`baixando ${FFMPEG_BUILD.url}\n`);
const response = await fetch(FFMPEG_BUILD.url);
if (!response.ok) throw new Error(`download falhou: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
await writeFile(archive, bytes);

const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== FFMPEG_BUILD.sha256) {
  throw new Error(`SHA-256 do arquivo não confere\nesperado ${FFMPEG_BUILD.sha256}\nobtido   ${digest}`);
}

// `tar` do ambiente não lê zip; `unzip` quando existe, PowerShell no resto.
try {
  await run("unzip", ["-q", "-o", FFMPEG_BUILD.archive, "-d", "."], { cwd: work });
} catch {
  if (process.platform !== "win32") throw new Error("unzip ausente: instale unzip para extrair o arquivo");
  await run("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${work}' -Force`,
  ]);
}
const extracted = join(work, FFMPEG_BUILD.root);
await mkdir(join(TARGET, "bin"), { recursive: true });
await copyFile(join(extracted, "bin", "ffmpeg.exe"), join(TARGET, "bin", "ffmpeg.exe"));
await copyFile(join(extracted, "bin", "ffprobe.exe"), join(TARGET, "bin", "ffprobe.exe"));
await copyFile(join(extracted, "LICENSE.txt"), join(TARGET, "LICENSE.txt"));

const ffmpegSha = createHash("sha256").update(await readFile(join(TARGET, "bin", "ffmpeg.exe"))).digest("hex");
const ffprobeSha = createHash("sha256").update(await readFile(join(TARGET, "bin", "ffprobe.exe"))).digest("hex");

await writeFile(
  join(TARGET, "SOURCE.txt"),
  [
    "FFmpeg — build LGPL, sem --enable-gpl (sem libx264/libx265).",
    "",
    `versão:      ${FFMPEG_BUILD.version}`,
    `arquivo:     ${FFMPEG_BUILD.archive}`,
    `origem:      ${FFMPEG_BUILD.url}`,
    `sha256(zip): ${FFMPEG_BUILD.sha256}`,
    `sha256 ffmpeg.exe:  ${ffmpegSha}`,
    `sha256 ffprobe.exe: ${ffprobeSha}`,
    "",
    "Como reconstruir este binário:",
    "1. baixe o arquivo acima e confira o SHA-256;",
    "2. descompacte; bin/ffmpeg.exe e bin/ffprobe.exe são os binários usados;",
    "3. a receita de build do projeto BtbN/FFmpeg-Builds está em https://github.com/BtbN/FFmpeg-Builds",
    "   (scripts de compilação geram builds LGPL e GPL a partir das mesmas fontes do FFmpeg).",
    "",
    "O texto completo da licença está em LICENSE.txt, ao lado deste arquivo.",
    "O FrankFrames chama o FFmpeg como processo separado; nenhuma biblioteca é linkada.",
  ].join("\n"),
);

await writeFile(
  join(TARGET, "manifest.json"),
  `${JSON.stringify({ ...FFMPEG_BUILD, ffmpegSha256: ffmpegSha, ffprobeSha256: ffprobeSha, vendoredAt: new Date().toISOString() }, null, 2)}\n`,
);

await rm(work, { recursive: true, force: true });
process.stdout.write(`ok ${FFMPEG_BUILD.version} em vendor/ffmpeg (ffmpeg ${(ffmpegSha.length && "verificado")})\n`);
