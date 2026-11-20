// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Copia a skill do monorepo para o pacote publicado. Rode após editar skills/frankframes. */
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../skills/frankframes/SKILL.md", import.meta.url));
const target = fileURLToPath(new URL("../packages/cli/skill/SKILL.md", import.meta.url));
await mkdir(fileURLToPath(new URL("../packages/cli/skill/", import.meta.url)), { recursive: true });
await copyFile(source, target);
process.stdout.write(`skill sincronizada em packages/cli/skill/SKILL.md\n`);
