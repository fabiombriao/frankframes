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
import { FONT_CATALOG, PINNED_BROWSER, assetHome, checkPinnedBrowser, cleanupWarning, fileSha256, fontFileName, removeOrWarn, removeTree } from "@frankframes/engine";
import { FFMPEG_BUILD } from "@frankframes/encode";

const run = promisify(execFile);
const FONT_VERSION = "5.2.5";
const EXE = process.platform === "win32" ? ".exe" : "";

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

/** FFmpeg LGPL pinado, com licença e oferta de fonte. */
export async function ensureFfmpeg(options: { check?: boolean } = {}): Promise<StepResult> {
  const dir = join(assetHome(), "ffmpeg");
  const binary = join(dir, "bin", `ffmpeg${EXE}`);
  if (await exists(binary)) {
    const manifestPath = join(dir, "manifest.json");
    if (!(await exists(manifestPath))) {
      return { name: "ffmpeg", state: "ok", detail: `${FFMPEG_BUILD.version} em ${dir} (sem manifesto para conferir)` };
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { ffmpegSha256?: string };
    const digest = await fileSha256(binary);
    if (manifest.ffmpegSha256 === digest) {
      return { name: "ffmpeg", state: "ok", detail: `${FFMPEG_BUILD.version} em ${dir}` };
    }
    if (options.check === true) {
      return { name: "ffmpeg", state: "falhou", detail: `binário não confere com o manifesto (${digest.slice(0, 16)}…); rode \`frankframes setup\`` };
    }
    // O setup segue dependendo desta remoção para reinstalar: se falhar, é erro com o caminho (sem force; o binário existe).
    const stale = await removeTree(join(dir, "bin"));
    if (stale !== undefined) throw new Error(`binário que não confere em ${join(dir, "bin")} e não consegui removê-lo: ${stale.message}`);
  }
  if (options.check === true) return { name: "ffmpeg", state: "ausente", detail: `rode \`frankframes setup\`` };

  await mkdir(join(dir, "bin"), { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "ff-vendor-"));
  let result: StepResult;
  try {
    const archive = join(work, FFMPEG_BUILD.archive);
    const bytes = await download(FFMPEG_BUILD.url, archive);
    const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
    if (digest !== FFMPEG_BUILD.sha256) {
      throw new Error(`SHA-256 do arquivo não confere (esperado ${FFMPEG_BUILD.sha256.slice(0, 16)}…, obtido ${digest.slice(0, 16)}…)`);
    }
    try {
      await run("unzip", ["-q", "-o", FFMPEG_BUILD.archive, "-d", "."], { cwd: work });
    } catch {
      if (process.platform !== "win32") throw new Error("unzip ausente");
      await run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${work}' -Force`]);
    }
    const extracted = join(work, FFMPEG_BUILD.root);
    await copyFile(join(extracted, "bin", `ffmpeg${EXE}`), binary);
    await copyFile(join(extracted, "bin", `ffprobe${EXE}`), join(dir, "bin", `ffprobe${EXE}`));
    await copyFile(join(extracted, "LICENSE.txt"), join(dir, "LICENSE.txt"));

    const manifest = {
      ...FFMPEG_BUILD,
      ffmpegSha256: await fileSha256(binary),
      ffprobeSha256: await fileSha256(join(dir, "bin", `ffprobe${EXE}`)),
      vendoredAt: new Date().toISOString(),
    };
    await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      join(dir, "SOURCE.txt"),
      [
        "FFmpeg — build LGPL, sem --enable-gpl (sem libx264/libx265).",
        "",
        `versão:      ${FFMPEG_BUILD.version}`,
        `arquivo:     ${FFMPEG_BUILD.archive}`,
        `origem:      ${FFMPEG_BUILD.url}`,
        `sha256(zip): ${FFMPEG_BUILD.sha256}`,
        `sha256 ffmpeg:  ${manifest.ffmpegSha256}`,
        `sha256 ffprobe: ${manifest.ffprobeSha256}`,
        "",
        "Reconstruir: baixe o arquivo acima, confira o SHA-256 e descompacte;",
        "a receita de build está em https://github.com/BtbN/FFmpeg-Builds.",
        "Licença completa em LICENSE.txt, ao lado deste arquivo.",
        "O FrankFrames executa o FFmpeg como processo separado; nada é linkado.",
      ].join("\n"),
    );
    result = { name: "ffmpeg", state: "instalado", detail: `${FFMPEG_BUILD.version}, ${(bytes / 1024 / 1024).toFixed(0)} MB` };
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
  const pin = await checkPinnedBrowser();
  if (pin.present && pin.matches) return { name: "browser", state: "ok", detail: `${PINNED_BROWSER.version} em ${pin.path}` };
  if (options.check === true) {
    return { name: "browser", state: "ausente", detail: pin.present ? "digest diferente" : `rode \`frankframes browser install\`` };
  }

  const vendor = join(assetHome(), "browsers");
  await mkdir(vendor, { recursive: true });
  const args = ["--yes", "@puppeteer/browsers", "install", `chrome-headless-shell@${PINNED_BROWSER.version}`, "--path", vendor];
  await run(
    process.platform === "win32" ? "cmd" : "npx",
    process.platform === "win32" ? ["/c", "npx", ...args] : args,
    { maxBuffer: 8 << 20 },
  );

  const after = await checkPinnedBrowser();
  if (!after.matches) return { name: "browser", state: "falhou", detail: `digest não confere: ${after.digest ?? "arquivo ausente"}` };
  return { name: "browser", state: "instalado", detail: `${PINNED_BROWSER.version}` };
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
