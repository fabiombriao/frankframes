// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Instalação de assets: fontes, FFmpeg e browser pinado.
 *
 *   frankframes setup [--check] [--fonts-only]
 *
 * Idempotente: só baixa o que falta e verifica hash do que já existe.
 * O `postinstall` chama apenas as fontes (1 MB); o resto exige o comando.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BrowserPlatformError, FONT_CATALOG, assetHome, checkPinnedBrowser, cleanupWarning, fileSha256, fontFileName, pinnedBrowser, removeOrWarn, removeTree } from "@frankframes/engine";
import { EncodePolicyError, ffmpegBuildFor } from "@frankframes/encode";
import type { FfmpegBuild } from "@frankframes/encode";

const run = promisify(execFile);
const FONT_VERSION = "5.2.5";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url: string, destination: string, validate?: (bytes: Buffer) => void): Promise<number> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const staging = `${destination}.part`;
  await writeFile(staging, bytes);
  try {
    validate?.(bytes);
  } catch (error) {
    // O staging acabou de ser escrito, então sumir seria erro: sem force. Se a remoção falhar, aviso no stderr e a falha de validação sobe.
    await removeOrWarn(staging, { recursive: false });
    throw error;
  }
  await rename(staging, destination);
  return bytes.byteLength;
}

export interface StepResult {
  name: string;
  state: "ok" | "instalado" | "ausente" | "falhou";
  detail: string;
}

/** Fontes OFL do catálogo. ~1 MB no total. */
export async function ensureFonts(options: { check?: boolean } = {}): Promise<StepResult> {
  const dir = join(assetHome(), "fonts");
  await mkdir(dir, { recursive: true });
  const present = new Set(await readdir(dir).catch(() => []));
  const missing: Array<{ file: string; pkg: string }> = [];
  for (const family of FONT_CATALOG) {
    for (const weight of family.weights) {
      const file = fontFileName(family, weight);
      if (!present.has(file)) missing.push({ file, pkg: family.pkg });
    }
  }

  if (missing.length === 0) return { name: "fontes", state: "ok", detail: `${present.size} arquivos em ${dir}` };
  if (options.check === true) return { name: "fontes", state: "ausente", detail: `${missing.length} arquivo(s) faltando em ${dir}` };

  let bytes = 0;
  // A licença OFL não bloqueia o render, mas a falha não some: vai para o detail do passo.
  const licenseFailures: string[] = [];
  for (const family of FONT_CATALOG) {
    if (!present.has(`OFL-${family.slug}.txt`) && !missing.some((item) => item.pkg === family.pkg)) continue;
    const license = `OFL-${family.slug}.txt`;
    if (!present.has(license)) {
      try {
        bytes += await download(`https://cdn.jsdelivr.net/npm/@fontsource/${family.pkg}@${FONT_VERSION}/LICENSE`, join(dir, license));
      } catch (error) {
        licenseFailures.push(`${license}: ${(error as Error).message}`);
      }
    }
  }
  for (const item of missing) {
    const url = `https://cdn.jsdelivr.net/npm/@fontsource/${item.pkg}@${FONT_VERSION}/files/${item.file}`;
    bytes += await download(url, join(dir, item.file), (buffer) => {
      if (buffer.subarray(0, 4).toString("latin1") !== "wOF2") throw new Error(`${item.file} não é woff2`);
    });
  }
  const warning = licenseFailures.length > 0 ? `; aviso: ${licenseFailures.length} licença(s) OFL não baixada(s) (${licenseFailures.join("; ")})` : "";
  return { name: "fontes", state: "instalado", detail: `${missing.length} arquivo(s), ${(bytes / 1024).toFixed(0)} KB${warning}` };
}

/**
 * Extrai o arquivo do FFmpeg para `work`. `archive` é o nome do arquivo dentro de `work` (relativo ao cwd do filho:
 * o `tar` do GNU lê `C:\…` como host remoto). zip: `unzip`, com `Expand-Archive` no Windows; tar.xz: `tar -xJf`.
 */
export async function extractArchive(format: FfmpegBuild["format"], archive: string, work: string): Promise<void> {
  if (format === "tar.xz") {
    try {
      await run("tar", ["-xJf", archive, "-C", "."], { cwd: work });
    } catch (error) {
      throw new Error(`não consegui extrair ${archive} com tar -xJf (precisa de tar e xz): ${(error as Error).message}`, { cause: error });
    }
    return;
  }
  try {
    await run("unzip", ["-q", "-o", archive, "-d", "."], { cwd: work });
  } catch (unzipError) {
    if (process.platform !== "win32") {
      throw new Error(`não consegui extrair ${archive} com unzip (instalado?): ${(unzipError as Error).message}`, { cause: unzipError });
    }
    try {
      // O Windows PowerShell 5.1 herda o PSModulePath de um PowerShell 7 pai e carrega o módulo Archive do 7, que falha em
      // ExtractToDirectory com erro NÃO terminante: sem `Stop` o comando sai com 0 e não extrai nada. Sem PSModulePath,
      // o 5.1 recalcula o seu; com `Stop`, qualquer erro vira código de saída diferente de zero.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
      await run(
        "powershell",
        ["-NoProfile", "-Command", `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath '${join(work, archive)}' -DestinationPath '${work}' -Force`],
        { env },
      );
    } catch (powershellError) {
      throw new Error(
        `não consegui extrair ${archive}: unzip (${(unzipError as Error).message}); PowerShell (${(powershellError as Error).message})`,
        { cause: powershellError },
      );
    }
  }
}

/**
 * FFmpeg LGPL pinado, com licença e oferta de fonte. `options.build` existe para teste (arquivo pequeno, mesma rota
 * de download, SHA-256 e extração); o padrão é o build pinado da plataforma.
 */
export async function ensureFfmpeg(options: { check?: boolean; build?: FfmpegBuild } = {}): Promise<StepResult> {
  let build: FfmpegBuild;
  try {
    build = options.build ?? ffmpegBuildFor();
  } catch (error) {
    // Plataforma sem pin: o passo falha com o código e o hint (nunca instala o build de outra plataforma).
    if (error instanceof EncodePolicyError) return { name: "ffmpeg", state: "falhou", detail: `${error.code}: ${error.message}` };
    throw error;
  }
  // O conteúdo do arquivo segue a plataforma do build, não a do host.
  const exe = build.platform === "win64" ? ".exe" : "";
  const dir = join(assetHome(), "ffmpeg");
  const binary = join(dir, "bin", `ffmpeg${exe}`);
  if (await exists(binary)) {
    const manifestPath = join(dir, "manifest.json");
    if (!(await exists(manifestPath))) {
      return { name: "ffmpeg", state: "ok", detail: `${build.version} em ${dir} (sem manifesto para conferir)` };
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { ffmpegSha256?: string; sha256?: string };
    const digest = await fileSha256(binary);
    // Binário íntegro E instalado a partir do arquivo que o pin de hoje manda: pin novo reinstala (EDT-13).
    if (manifest.ffmpegSha256 === digest && manifest.sha256 === build.sha256) {
      return { name: "ffmpeg", state: "ok", detail: `${build.version} (${build.platform}) em ${dir}` };
    }
    const why =
      manifest.ffmpegSha256 === digest
        ? `instalado a partir de outro arquivo (${manifest.sha256?.slice(0, 16) ?? "sem digest no manifesto"}…), o pin manda ${build.sha256.slice(0, 16)}…`
        : `binário não confere com o manifesto (${digest.slice(0, 16)}…)`;
    if (options.check === true) {
      return { name: "ffmpeg", state: "falhou", detail: `${why}; rode \`frankframes setup\`` };
    }
    // O setup segue dependendo desta remoção para reinstalar: se falhar, é erro com o caminho (sem force; o binário existe).
    const stale = await removeTree(join(dir, "bin"));
    if (stale !== undefined) throw new Error(`ffmpeg desatualizado em ${join(dir, "bin")} (${why}) e não consegui removê-lo: ${stale.message}`);
  }
  if (options.check === true) return { name: "ffmpeg", state: "ausente", detail: `rode \`frankframes setup\`` };

  await mkdir(join(dir, "bin"), { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "ff-vendor-"));
  let result: StepResult;
  try {
    const archive = join(work, build.archive);
    const bytes = await download(build.url, archive);
    const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
    if (digest !== build.sha256) {
      throw new Error(`SHA-256 do arquivo não confere (esperado ${build.sha256.slice(0, 16)}…, obtido ${digest.slice(0, 16)}…)`);
    }
    await extractArchive(build.format, build.archive, work);
    const extracted = join(work, build.root);
    // Extração que "deu certo" sem criar a pasta do pin é falha, não um ENOENT obscuro no copyFile.
    if (!(await exists(extracted))) {
      const found = (await readdir(work)).filter((name) => name !== build.archive);
      throw new Error(`o arquivo ${build.archive} foi extraído, mas a pasta ${build.root} não apareceu em ${work} (encontrado: ${found.join(", ") || "nada"})`);
    }
    await copyFile(join(extracted, "bin", `ffmpeg${exe}`), binary);
    await copyFile(join(extracted, "bin", `ffprobe${exe}`), join(dir, "bin", `ffprobe${exe}`));
    await copyFile(join(extracted, "LICENSE.txt"), join(dir, "LICENSE.txt"));

    const manifest = {
      ...build,
      ffmpegSha256: await fileSha256(binary),
      ffprobeSha256: await fileSha256(join(dir, "bin", `ffprobe${exe}`)),
      vendoredAt: new Date().toISOString(),
    };
    await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      join(dir, "SOURCE.txt"),
      [
        "FFmpeg — build LGPL, sem --enable-gpl (sem libx264/libx265).",
        "",
        `versão:      ${build.version}`,
        `plataforma:  ${build.platform}`,
        `tag:         ${build.tag}`,
        `arquivo:     ${build.archive}`,
        `origem:      ${build.url}`,
        `sha256(${build.format}): ${build.sha256}`,
        `sha256 ffmpeg:  ${manifest.ffmpegSha256}`,
        `sha256 ffprobe: ${manifest.ffprobeSha256}`,
        "",
        "Reconstruir: baixe o arquivo acima, confira o SHA-256 e descompacte;",
        "a receita de build está em https://github.com/BtbN/FFmpeg-Builds.",
        "Licença completa em LICENSE.txt, ao lado deste arquivo.",
        "O FrankFrames executa o FFmpeg como processo separado; nada é linkado.",
      ].join("\n"),
    );
    result = { name: "ffmpeg", state: "instalado", detail: `${build.version} (${build.platform}), ${(bytes / 1024 / 1024).toFixed(0)} MB` };
  } catch (error) {
    // O corpo falhou: a limpeza que falhar vai para o stderr e o erro original sobe intacto.
    await removeOrWarn(work);
    throw error;
  }
  // Instalou, mas o temporário não saiu: o aviso vai no detail (o passo continua "instalado").
  const leftover = await removeTree(work);
  return leftover === undefined ? result : { ...result, detail: `${result.detail}; aviso: ${cleanupWarning(work, leftover)}` };
}

/** Shell headless pinado por digest. */
export async function ensureBrowser(options: { check?: boolean } = {}): Promise<StepResult> {
  let pinned;
  try {
    pinned = pinnedBrowser();
  } catch (error) {
    // Plataforma sem pin: o passo falha com o código e o hint (nunca instala o shell de outra plataforma).
    if (error instanceof BrowserPlatformError) return { name: "browser", state: "falhou", detail: error.message };
    throw error;
  }
  const pin = await checkPinnedBrowser();
  if (pin.present && pin.matches) return { name: "browser", state: "ok", detail: `${pinned.version} (${pinned.platform}) em ${pin.path}` };
  if (options.check === true) {
    return { name: "browser", state: "ausente", detail: pin.present ? "digest diferente" : `rode \`frankframes browser install\`` };
  }

  const vendor = join(assetHome(), "browsers");
  await mkdir(vendor, { recursive: true });
  const args = ["--yes", "@puppeteer/browsers", "install", `chrome-headless-shell@${pinned.version}`, "--path", vendor];
  await run(
    process.platform === "win32" ? "cmd" : "npx",
    process.platform === "win32" ? ["/c", "npx", ...args] : args,
    { maxBuffer: 8 << 20 },
  );

  const after = await checkPinnedBrowser();
  if (!after.matches) return { name: "browser", state: "falhou", detail: `digest não confere: ${after.digest ?? "arquivo ausente"}` };
  return { name: "browser", state: "instalado", detail: `${pinned.version} (${pinned.platform})` };
}

export interface SetupOptions {
  check?: boolean;
  fontsOnly?: boolean;
}

/** Executa o setup e devolve o código de saída. */
export async function runSetup(options: SetupOptions = {}): Promise<number> {
  const steps: StepResult[] = [];
  steps.push(await ensureFonts(options));
  if (options.fontsOnly !== true) {
    steps.push(await ensureFfmpeg(options));
    steps.push(await ensureBrowser(options));
  }

  for (const step of steps) process.stdout.write(`${step.state.padEnd(10)} ${step.name.padEnd(8)} ${step.detail}\n`);
  if (options.check !== true) {
    const failed = steps.filter((step) => step.state === "falhou").length;
    if (failed > 0) return 1;
  }
  return options.check === true && steps.some((step) => step.state === "ausente") ? 1 : 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  // `process.exit()` logo após fetch pode abortar com UV_HANDLE_CLOSING no Node 24/Windows.
  process.exitCode = await runSetup({ check: process.argv.includes("--check"), fontsOnly: process.argv.includes("--fonts-only") });
}
