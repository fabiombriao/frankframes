// FrankFrames — proprietário. Ver LICENSE na raiz.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkPinnedBrowser, assetHome } from "@frankframes/engine";
import { expectedFontFiles } from "@frankframes/engine";
import { listBlocks } from "@frankframes/catalog";
import { assertFfmpegAllowed, detectFfmpeg } from "@frankframes/encode";
import { resolveFfmpeg } from "@frankframes/producer";

const STARTER = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; background: #0b0b0f; color: #fff; font-family: "Inter"; }
    #stage { position: relative; width: 1920px; height: 1080px; overflow: hidden; }
    .kicker { position: absolute; left: 120px; top: 350px; font-size: 26px; letter-spacing: 0.22em; text-transform: uppercase; color: #ff2d55; }
    .title { position: absolute; left: 120px; top: 400px; font-size: 128px; font-weight: 700; line-height: 1.02; }
    .rule { position: absolute; left: 120px; top: 570px; height: 6px; width: 0; background: #ff2d55; animation: grow 1.2s ease-out forwards; }
    @keyframes grow { to { width: 460px; } }
  </style>
</head>
<body>
  <div id="stage" data-composition-id="meu-video" data-root="true"
       data-width="1920" data-height="1080" data-fps="30" data-duration="4">
    <div class="kicker" data-clip-id="kicker" data-start="0" data-duration="4">FrankFrames</div>
    <div class="title" data-clip-id="titulo" data-start="0.2" data-duration="3.8">Seu primeiro vídeo</div>
    <div class="rule" data-clip-id="regua" data-start="0.4" data-duration="3.6"></div>
  </div>
</body>
</html>
`;

/** Cria um projeto mínimo que renderiza sem edição. */
export async function runInit(target: string): Promise<void> {
  const dir = resolve(target);
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "index.html"), STARTER);
  process.stdout.write(`criado ${join(dir, "index.html")}\n`);
  process.stdout.write(`\npróximos:\n  frankframes preview ${join(dir, "index.html")} --open\n  frankframes render ${join(dir, "index.html")} -o out/video.mp4\n`);
}

/** Uma skill de agente: nome da pasta e o `SKILL.md` dela. */
export interface SkillSource {
  name: string;
  file: string;
}

/** Skills dentro do pacote (publicado) ou no monorepo: uma por pasta que tenha `SKILL.md`, em ordem alfabética. */
export function skillSources(): SkillSource[] {
  const packaged = fileURLToPath(new URL("../skill/", import.meta.url));
  const monorepo = fileURLToPath(new URL("../../../skills/", import.meta.url));
  const base = existsSync(join(packaged, "frankframes", "SKILL.md")) ? packaged : monorepo;
  const found = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "SKILL.md")))
    .map((entry) => ({ name: entry.name, file: join(base, entry.name, "SKILL.md") }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (found.length === 0) throw new Error(`nenhuma skill encontrada em ${base} (rode \`node scripts/sync-skill.ts\`)`);
  return found;
}

/** Instala todas as skills no diretório de agente do projeto atual (Claude: uma pasta por skill; Cursor: um .mdc por skill). */
export async function runSkillInstall(target: "claude" | "cursor", destination: string): Promise<void> {
  for (const skill of skillSources()) {
    const dir = target === "claude" ? join(resolve(destination), ".claude", "skills", skill.name) : join(resolve(destination), ".cursor", "rules");
    await mkdir(dir, { recursive: true });
    const file = target === "claude" ? join(dir, "SKILL.md") : join(dir, `${skill.name}.mdc`);
    await copyFile(skill.file, file);
    process.stdout.write(`skill ${skill.name} instalada em ${file}\n`);
  }
}

/** Diagnóstico do ambiente. Sai com 1 quando falta requisito duro. */
export async function runDoctor(): Promise<number> {
  let failed = false;
  const line = (label: string, value: string): void => {
    process.stdout.write(`${label.padEnd(9)} ${value}\n`);
  };

  line("node", process.version);

  const pin = await checkPinnedBrowser();
  if (pin.present && pin.matches) line("browser", `ok ${pin.path}`);
  else {
    failed = true;
    line("browser", pin.present ? "digest não confere — rode `frankframes browser install`" : "ausente — rode `frankframes browser install`");
  }

  const pair = await resolveFfmpeg();
  try {
    const facts = await detectFfmpeg(pair.ffmpeg);
    const mode = pair.source === "vendor" ? "distribution" : "user-provided";
    const warnings = assertFfmpegAllowed(facts, mode);
    line("ffmpeg", `${facts.version} (${pair.source}, modo ${mode})${warnings.length > 0 ? ` — ${warnings.length} aviso(s) de licença` : ""}`);
  } catch (error) {
    failed = true;
    line("ffmpeg", (error as Error).message);
  }

  const fontsPresent = new Set(await readdir(join(assetHome(), "fonts")).catch(() => []));
  const missingFonts = expectedFontFiles().filter((file) => !fontsPresent.has(file));
  line("fontes", missingFonts.length === 0 ? `${expectedFontFiles().length} arquivos` : `${missingFonts.length} ausentes — rode \`node scripts/fetch-fonts.ts\``);
  if (missingFonts.length > 0) failed = true;

  line("catálogo", `${listBlocks().length} blocos`);
  return failed ? 1 : 0;
}
