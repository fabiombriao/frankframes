// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Avisos de terceiros (EDT-65).
 *
 *   node scripts/third-party.ts            # lista a árvore de produção: nome, versão, licença
 *   node scripts/third-party.ts --check     # falha se faltar aviso ou se a licença não for permissiva
 *
 * A árvore vem de `npm ls --omit=dev --all` nos workspaces; a licença, do `package.json` de cada pacote
 * instalado. Pacotes do próprio monorepo (`@frankframes/*`) não entram: são nossos.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Licenças aceitas em dependência de produção (identificadores SPDX). */
export const ALLOWED_LICENSES: readonly string[] = ["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "BlueOak-1.0.0"];

export interface DependencyEntry {
  name: string;
  version: string;
  /** Expressão SPDX do `package.json`, ou `null` se o pacote não declara licença legível. */
  license: string | null;
}

export interface Violation {
  name: string;
  version: string;
  kind: "licença" | "aviso";
  detail: string;
}

/** Erro com código estável e dica acionável. */
export class ThirdPartyError extends Error {
  readonly code: string;
  readonly hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.name = "ThirdPartyError";
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Aceita a expressão SPDX só se todas as licenças obrigatórias forem permitidas:
 * `A OR B` basta uma alternativa permitida; `A AND B` exige as duas. Parênteses são ignorados
 * porque as expressões do npm de interesse são planas.
 */
export function licenseAllowed(expression: string | null): boolean {
  if (expression === null || expression.trim() === "") return false;
  const alternatives = expression.replace(/[()]/g, " ").split(/\s+OR\s+/i);
  return alternatives.some((alternative) => {
    const required = alternative.trim().split(/\s+AND\s+/i);
    return required.every((id) => ALLOWED_LICENSES.includes(id.trim()));
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** O aviso existe se o pacote tem seção (`### nome …`) ou linha de tabela (`| nome | …`) em THIRD-PARTY-NOTICES.md. */
export function hasNotice(name: string, notices: string): boolean {
  const escaped = escapeRegExp(name);
  const heading = new RegExp(`^#{2,4}\\s+\`?${escaped}\`?(\\s|$)`, "m");
  const row = new RegExp(`^\\|\\s*\`?${escaped}\`?\\s*\\|`, "m");
  return heading.test(notices) || row.test(notices);
}

/** Função pura do `--check`: devolve as violações (lista vazia = tudo certo). */
export function checkLicenses(entries: readonly DependencyEntry[], notices: string): Violation[] {
  const violations: Violation[] = [];
  for (const entry of entries) {
    if (!licenseAllowed(entry.license)) {
      violations.push({
        name: entry.name,
        version: entry.version,
        kind: "licença",
        detail: `licença ${entry.license ?? "ausente"} fora de ${ALLOWED_LICENSES.join("/")}`,
      });
    }
    if (!hasNotice(entry.name, notices)) {
      violations.push({ name: entry.name, version: entry.version, kind: "aviso", detail: "sem aviso em THIRD-PARTY-NOTICES.md" });
    }
  }
  return violations;
}

interface LsNode {
  version?: string;
  path?: string;
  dependencies?: Record<string, LsNode>;
}

function npmLs(): LsNode {
  const args = ["ls", "--omit=dev", "--all", "--json", "--long", "--workspaces"];
  const invocation = process.platform === "win32" ? { file: "cmd", args: ["/c", "npm", ...args] } : { file: "npm", args };
  const result = spawnSync(invocation.file, invocation.args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new ThirdPartyError(
      "E_THIRD_PARTY_NPM_LS",
      `npm ls saiu com ${result.status ?? "sinal"}: ${(result.stderr || result.stdout).trim().slice(0, 600)}`,
      "rode `npm install` na raiz e confira `npm ls --omit=dev --all`",
    );
  }
  try {
    return JSON.parse(result.stdout) as LsNode;
  } catch {
    throw new ThirdPartyError("E_THIRD_PARTY_NPM_LS", `saída do npm ls não é JSON: ${result.stdout.slice(0, 200)}`, "confira a versão do npm (`npm -v`)");
  }
}

/** `license` do package.json: texto SPDX, ou o formato antigo `{ type }` / `licenses: [{ type }]`. */
function readLicense(manifest: { license?: unknown; licenses?: unknown }): string | null {
  const { license, licenses } = manifest;
  if (typeof license === "string") return license;
  if (license !== null && typeof license === "object" && "type" in license && typeof license.type === "string") return license.type;
  if (Array.isArray(licenses)) {
    const types = licenses.map((item) => (item !== null && typeof item === "object" && "type" in item && typeof item.type === "string" ? item.type : null));
    if (types.length > 0 && types.every((type): type is string => type !== null)) return types.join(" OR ");
  }
  return null;
}

/** Árvore de produção sem repetição (nome + versão), ordenada. Dependência opcional não instalada não entra. */
export function listProductionDependencies(): DependencyEntry[] {
  const tree = npmLs();
  const found = new Map<string, DependencyEntry>();
  const visit = (name: string, node: LsNode): void => {
    if (!name.startsWith("@frankframes/")) {
      // Nó sem versão e sem caminho: peer opcional que o npm não instalou (ex.: proxy-agent do @puppeteer/browsers).
      if (node.version !== undefined) {
        if (node.path === undefined) {
          throw new ThirdPartyError("E_THIRD_PARTY_NO_PATH", `${name}@${node.version} sem caminho no npm ls`, "rode `npm install` e tente de novo");
        }
        const manifestPath = join(node.path, "package.json");
        if (!existsSync(manifestPath)) {
          throw new ThirdPartyError("E_THIRD_PARTY_NO_MANIFEST", `${manifestPath} não existe`, "rode `npm install` e tente de novo");
        }
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { license?: unknown; licenses?: unknown };
        found.set(`${name}@${node.version}`, { name, version: node.version, license: readLicense(manifest) });
      }
    }
    for (const [childName, child] of Object.entries(node.dependencies ?? {})) visit(childName, child);
  };
  for (const [name, node] of Object.entries(tree.dependencies ?? {})) visit(name, node);
  return [...found.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    throw new ThirdPartyError("E_THIRD_PARTY_USAGE", `argumento desconhecido: ${unknown.join(" ")}`, "uso: node scripts/third-party.ts [--check]");
  }
  const entries = listProductionDependencies();
  if (entries.length === 0) {
    throw new ThirdPartyError("E_THIRD_PARTY_EMPTY", "nenhuma dependência de produção encontrada", "rode `npm install` na raiz");
  }
  if (!check) {
    for (const entry of entries) process.stdout.write(`${entry.name}@${entry.version}  ${entry.license ?? "SEM LICENÇA"}\n`);
    process.stdout.write(`\n${entries.length} dependências de produção\n`);
    return 0;
  }
  const notices = readFileSync(join(ROOT, "THIRD-PARTY-NOTICES.md"), "utf8");
  const violations = checkLicenses(entries, notices);
  if (violations.length === 0) {
    process.stdout.write(`ok · ${entries.length} dependências de produção, todas com aviso e licença permissiva\n`);
    return 0;
  }
  for (const violation of violations) {
    process.stderr.write(`✖ ${violation.name}@${violation.version} (${violation.kind}): ${violation.detail}\n`);
  }
  process.stderr.write("\ndica: acrescente a dependência em THIRD-PARTY-NOTICES.md e PROVENANCE.md; licença fora da lista exige decisão do titular\n");
  return 1;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ThirdPartyError) {
      process.stderr.write(`✖ ${error.code}: ${error.message}\n  dica: ${error.hint}\n`);
    } else {
      process.stderr.write(`✖ E_THIRD_PARTY_UNEXPECTED: ${(error as Error).stack ?? String(error)}\n`);
    }
    process.exitCode = 1;
  }
}
