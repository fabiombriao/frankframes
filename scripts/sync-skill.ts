// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Copia as skills do monorepo (`skills/<nome>/`) para o pacote publicado (`packages/cli/skill/<nome>/`).
 * Rode após editar qualquer coisa em `skills/`. Apaga do pacote o que não existe mais na fonte.
 * Também escreve a tabela de presets de motion da skill de geração a partir do código (`motionPresetTable`).
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPresets } from "@frankframes/contract";

const SOURCE = fileURLToPath(new URL("../skills/", import.meta.url));
const TARGET = fileURLToPath(new URL("../packages/cli/skill/", import.meta.url));

/** Marcadores que delimitam a região gerada dentro do SKILL.md; o que fica entre eles é sobrescrito. */
export const PRESETS_BEGIN = "<!-- presets:begin (gerado por scripts/sync-skill.ts a partir de listPresets do contrato) -->";
export const PRESETS_END = "<!-- presets:end -->";

/** Tabela Markdown dos presets de motion, tirada da biblioteca do contrato: nunca escrita à mão. */
export function motionPresetTable(): string {
  const groups: Array<[string, string]> = [
    ["enter", "`data-enter` (entrada)"],
    ["exit", "`data-exit` (saída)"],
    ["emphasis", "`data-emphasis` (ênfase)"],
    ["camera", "`data-camera` (só `<img>`/`<video>`)"],
    ["transition", "`data-transition` (entre clips)"],
  ];
  const presets = listPresets();
  const rows = groups.map(([kind, label]) => {
    const names = presets.filter((preset) => preset.kind === kind).map((preset) => `\`${preset.name}\``);
    if (names.length === 0) throw new Error(`nenhum preset do tipo ${kind} em listPresets()`);
    return `| ${label} | ${names.join(", ")} |`;
  });
  return ["| atributo | presets |", "|---|---|", ...rows].join("\n");
}

/** Troca a região entre os marcadores pelo texto gerado; falha alto se os marcadores faltarem. */
export function fillPresets(markdown: string): string {
  const begin = markdown.indexOf(PRESETS_BEGIN);
  const end = markdown.indexOf(PRESETS_END);
  if (begin === -1 || end === -1 || end < begin) throw new Error(`faltam os marcadores de presets (${PRESETS_BEGIN} … ${PRESETS_END})`);
  // Respeita o fim de linha do arquivo (checkout no Windows pode trazer CRLF).
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const table = motionPresetTable().replaceAll("\n", eol);
  return `${markdown.slice(0, begin + PRESETS_BEGIN.length)}${eol}${table}${eol}${markdown.slice(end)}`;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("sync-skill.ts")) {
  const sourceNames = (await readdir(SOURCE, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  // A skill de geração leva a tabela de presets gerada do código: atualiza a fonte antes de copiar.
  const generate = join(SOURCE, "frankframes-generate", "SKILL.md");
  const text = await readFile(generate, "utf8");
  const filled = fillPresets(text);
  if (filled !== text) await writeFile(generate, filled);

  await mkdir(TARGET, { recursive: true });
  // Sai o que não existe mais na fonte (inclusive o `SKILL.md` solto de antes das duas skills).
  for (const entry of await readdir(TARGET)) {
    if (!sourceNames.includes(entry)) await rm(join(TARGET, entry), { recursive: true, force: true });
  }
  for (const name of sourceNames) {
    await rm(join(TARGET, name), { recursive: true, force: true });
    await cp(join(SOURCE, name), join(TARGET, name), { recursive: true });
    process.stdout.write(`skill sincronizada em packages/cli/skill/${name}/\n`);
  }
}
