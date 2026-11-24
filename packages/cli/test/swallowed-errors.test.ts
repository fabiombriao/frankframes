// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-83: "falhar alto" (.omp/RULES.md) como varredura. Nenhum erro some em silêncio no código de produção e nos scripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "out", "vendor", ".git"]);

/**
 * Formas que engolem o erro: `.catch(() => {})`, `.catch(() => undefined|null)` e `catch {}` / `catch (x) {}` sem corpo
 * (só comentário também é corpo vazio). A exceção é declarada, com motivo, por `ignora-erro: <motivo>` na linha do
 * achado ou na de cima. Ela existe para o erro que já tem outro destino (o original é relançado, a promessa é
 * observada em outro lugar) e para o ENOENT esperado; remoção de temporário nunca entra aqui (vira aviso ou erro).
 */
const SWALLOW: Array<{ kind: string; pattern: RegExp }> = [
  { kind: ".catch(() => {}|undefined|null)", pattern: /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*(\/\*[^]*?\*\/\s*|\/\/[^\n]*\n\s*)*\}|undefined|null|void 0)\s*\)/g },
  { kind: "catch sem corpo", pattern: /\bcatch\s*(\(\s*\w+(\s*:\s*\w+)?\s*\))?\s*\{\s*(\/\*[^]*?\*\/\s*|\/\/[^\n]*\n\s*)*\}/g },
];
const MARKER = /ignora-erro:[ \t]*\S[^\n]{6,}/;

export interface Finding {
  kind: string;
  line: number;
  text: string;
}

/** Achados de uma fonte, já sem os que carregam `ignora-erro:` com motivo. */
export function findSwallowed(source: string): Finding[] {
  const lines = source.split("\n");
  const findings: Finding[] = [];
  for (const { kind, pattern } of SWALLOW) {
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0;
      const first = source.slice(0, index).split("\n").length; // 1-based
      const last = first + match[0].split("\n").length - 1;
      const covered = lines.slice(Math.max(0, first - 2), last).join("\n"); // linha de cima até a última do achado
      if (MARKER.test(covered)) continue;
      findings.push({ kind, line: first, text: match[0].replace(/\s+/g, " ").slice(0, 90) });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourcesUnder(path, out);
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

function productionFiles(): string[] {
  const files: string[] = [];
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", pkg, "src");
    try {
      if (statSync(src).isDirectory()) sourcesUnder(src, files);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; // pacote sem src/ não tem o que varrer
    }
  }
  sourcesUnder(join(ROOT, "scripts"), files);
  return files;
}

test("a varredura enxerga as formas que engolem erro (e respeita a exceção declarada)", () => {
  const bad = [
    "await rm(dir).catch(() => {});",
    "await rm(dir).catch(() => undefined);",
    "await rm(dir).catch((e) => null);",
    "try { x(); } catch {}",
    "try { x(); } catch (error) {}",
    "try { x(); } catch (error) {\n  /* depois eu vejo */\n}",
    "try { x(); } catch {\n  // nada\n}",
    "await rm(dir)\n  .catch(() => {\n  });",
  ];
  for (const source of bad) assert.equal(findSwallowed(source).length, 1, `deveria reprovar: ${JSON.stringify(source)}`);

  const good = [
    "await rm(dir).catch((error) => warn(error));",
    "try { x(); } catch (error) { throw new Error('x', { cause: error }); }",
    "try { x(); } catch { return null; }",
    "// ignora-erro: o erro original já foi relançado acima\nawait unlink(tmp).catch(() => undefined);",
    "await unlink(tmp).catch(() => undefined); // ignora-erro: arquivo pode não existir (ENOENT esperado)",
    "try { x(); } catch {\n  /* ignora-erro: processo já morto (ESRCH) */\n}",
  ];
  for (const source of good) assert.deepEqual(findSwallowed(source), [], `deveria passar: ${JSON.stringify(source)}`);

  // Marcador sem motivo não vale.
  assert.equal(findSwallowed("await x().catch(() => {}); // ignora-erro:").length, 1);
});

test("packages/*/src e scripts/ não engolem erro: nada de catch vazio, .catch(() => {}) ou .catch(() => undefined)", () => {
  const files = productionFiles();
  assert.ok(files.length > 100, `a varredura precisa achar o código (achou ${files.length} arquivos)`);
  const report: string[] = [];
  for (const file of files) {
    for (const finding of findSwallowed(readFileSync(file, "utf8"))) {
      report.push(`${relative(ROOT, file).split("\\").join("/")}:${finding.line}  ${finding.kind}  «${finding.text}»`);
    }
  }
  assert.deepEqual(report, [], `erro engolido (.omp/RULES.md, "Falhar alto"). Trate, avise com o caminho ou declare "ignora-erro: <motivo>":\n${report.join("\n")}`);
});
