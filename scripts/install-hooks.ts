// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Instala o hook de pré-push que roda o gate rápido antes de enviar código. */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooks = join(root, ".git", "hooks");
await mkdir(hooks, { recursive: true });
const hook = join(hooks, "pre-push");
await writeFile(hook, "#!/bin/sh\nset -e\nexec node scripts/ci.ts --fast\n");
await chmod(hook, 0o755);
process.stdout.write(`hook instalado: ${hook}\n`);
