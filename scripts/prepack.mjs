// FrankFrames — proprietário. Ver LICENSE na raiz.
// Copia LICENSE e avisos de terceiros para dentro do pacote antes do `npm pack`.
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const packageDir = process.cwd();
const root = resolve(packageDir, "../..");
for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.md"]) {
  const source = resolve(root, file);
  if (existsSync(source)) copyFileSync(source, resolve(packageDir, file));
}
