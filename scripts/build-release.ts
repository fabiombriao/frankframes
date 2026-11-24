// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Build do release (EDT-65): um tarball só, `@frankframes/cli`, compilado.
 *
 *   node scripts/build-release.ts [--out <pasta>]     # padrão: out/release
 *
 * Por que existe: o Node 24 não executa `.ts` dentro de `node_modules`, e os pacotes do monorepo
 * exportam `src/*.ts`. O estágio espelha o layout do repositório (`packages/<pkg>/src/*.js`,
 * `catalog/`, `docs/`), então os `new URL("../../../catalog/blocks/", import.meta.url)` continuam valendo.
 *
 * Saída em `<out>/stage/` (o que vira tarball) e `<out>/frankframes-cli-<versão>.tgz`.
 */
import { spawnSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Marca a pasta de saída como nossa: só uma pasta marcada (ou vazia) pode ser apagada pelo build. */
const OUT_MARKER = ".frankframes-release";

/** Arquivos estáticos lidos em runtime por caminho relativo ao módulo e que não passam pelo tsc. */
const STATIC_COPIES: Array<{ from: string; to: string }> = [
  { from: "packages/cli/src/studio", to: "packages/cli/src/studio" },
  { from: "packages/cli/skill", to: "packages/cli/skill" },
  { from: "catalog/blocks", to: "catalog/blocks" },
  { from: "catalog/README.md", to: "catalog/README.md" },
  // O Studio serve estas miniaturas (`/__ff_motion/<preset>.gif`); o plano não as listava.
  { from: "catalog/motion/thumbs", to: "catalog/motion/thumbs" },
  { from: "docs", to: "docs" },
  { from: "LICENSE", to: "LICENSE" },
  { from: "THIRD-PARTY-NOTICES.md", to: "THIRD-PARTY-NOTICES.md" },
];

/** Planejamento interno não é documentação de produto: fica fora do tarball. */
const DOCS_EXCLUDED = new Set(["plano-1.0.md"]);

/**
 * Caminhos que o código tenta de propósito e que não existem no estágio: o fallback cai em outro lugar.
 * `vendor/` -> `~/.frankframes` (engine/home.ts); `skills/` -> `packages/cli/skill` (cli/onboarding.ts).
 */
const OPTIONAL_REFERENCES = ["vendor", "skills"];

/** Pastas do repositório que não podem aparecer no tarball (assets baixados, material de teste). */
const FORBIDDEN_IN_TARBALL = [/^package\/vendor\//, /^package\/catalog\/goldens/, /^package\/packages\/[^/]+\/test\//, /^package\/scripts\//];

/** Erro de build com código estável e dica acionável. */
export class ReleaseError extends Error {
  readonly code: string;
  readonly hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.name = "ReleaseError";
    this.code = code;
    this.hint = hint;
  }
}

/** Comando de linha de comando do npm: no Windows ele só existe como `.cmd`, e spawn direto falha com EINVAL. */
export function npmCommand(args: string[]): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "cmd", args: ["/c", "npm", ...args] };
  return { file: "npm", args };
}

interface PackageJson {
  name?: string;
  version?: string;
  type?: string;
  license?: string;
  author?: string;
  private?: boolean;
  bin?: Record<string, string> | string;
  exports?: unknown;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
  [key: string]: unknown;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Todos os arquivos de uma pasta, recursivamente (caminhos absolutos). */
async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

function posix(path: string): string {
  return path.split(sep).join("/");
}

/** Prepara a pasta de saída: apaga só o que é nosso e a recria vazia. */
async function prepareOut(out: string): Promise<void> {
  const normalized = resolve(out);
  if (normalized === resolve(ROOT) || resolve(ROOT).startsWith(`${normalized}${sep}`) || dirname(normalized) === normalized) {
    throw new ReleaseError("E_RELEASE_OUT_UNSAFE", `pasta de saída perigosa: ${normalized}`, "use uma subpasta própria, por exemplo --out out/release");
  }
  if (existsSync(normalized)) {
    const entries = await readdir(normalized);
    if (entries.length > 0 && !entries.includes(OUT_MARKER)) {
      throw new ReleaseError(
        "E_RELEASE_OUT_UNSAFE",
        `${normalized} não está vazia e não foi criada por este build`,
        "aponte --out para uma pasta nova ou vazia; o build só apaga o que ele mesmo criou",
      );
    }
    await rm(normalized, { recursive: true, force: true });
  }
  await mkdir(normalized, { recursive: true });
  await writeFile(join(normalized, OUT_MARKER), "gerado por scripts/build-release.ts\n");
}

/** Dependências de produção reais (todas as dos pacotes, menos as do próprio monorepo) na versão exata do lockfile. */
export function productionDependencies(workspaces: PackageJson[], lock: { packages: Record<string, { version?: string }> }): Record<string, string> {
  const names = new Set<string>();
  for (const workspace of workspaces) {
    for (const name of Object.keys(workspace.dependencies ?? {})) {
      if (!name.startsWith("@frankframes/")) names.add(name);
    }
  }
  const resolved: Record<string, string> = {};
  for (const name of [...names].sort()) {
    const version = lock.packages[`node_modules/${name}`]?.version;
    if (version === undefined) {
      throw new ReleaseError("E_RELEASE_LOCK", `${name} não consta no package-lock.json`, "rode `npm install` e tente de novo");
    }
    resolved[name] = version;
  }
  return resolved;
}

/** Troca `.ts` por `.js` em todo valor de texto de `exports`/`bin` (entradas que o tsc compila). */
function mapEntryPoints(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\.ts$/, ".js");
  if (Array.isArray(value)) return value.map(mapEntryPoints);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, mapEntryPoints(inner)]));
  }
  return value;
}

/** `package.json` de um pacote dentro do estágio: só o que o runtime lê (`type`, `version`, `name`). */
export function stagePackageJson(source: PackageJson): PackageJson {
  const { scripts: _scripts, files: _files, private: _private, dependencies: _dependencies, devDependencies: _dev, ...rest } = source as PackageJson & {
    devDependencies?: unknown;
  };
  const mapped: PackageJson = { ...rest, type: "module" };
  if (mapped.exports !== undefined) mapped.exports = mapEntryPoints(mapped.exports);
  if (mapped.bin !== undefined) mapped.bin = mapEntryPoints(mapped.bin) as PackageJson["bin"];
  return mapped;
}

/** Reescreve `from "@frankframes/<x>"` e `import "@frankframes/<x>"` para caminho relativo até o `index.js` do pacote. */
export function rewriteWorkspaceImports(code: string, fileDir: string, packagesDir: string, knownPackages: Set<string>): string {
  return code.replace(/(\b(?:from|import)\s*)(["'])@frankframes\/([a-z0-9-]+)\2/g, (_whole, lead: string, quote: string, name: string) => {
    if (!knownPackages.has(name)) {
      throw new ReleaseError("E_RELEASE_UNKNOWN_PACKAGE", `import de @frankframes/${name}, que não existe em packages/`, "corrija o import ou crie o pacote");
    }
    let target = posix(relative(fileDir, join(packagesDir, name, "src", "index.js")));
    if (!target.startsWith(".")) target = `./${target}`;
    return `${lead}${quote}${target}${quote}`;
  });
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Nome do pacote npm de um especificador (`@a/b/c` -> `@a/b`, `a/b` -> `a`). */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/** Valida o JS emitido: nada de `.ts"`, `@frankframes/` ou `import()` montado; imports nus só de dependências declaradas. */
export function validateCompiledJs(file: string, code: string, declared: Set<string>): string[] {
  const problems: string[] = [];
  const at = (index: number): string => `${file}:${lineOf(code, index)}`;
  for (const match of code.matchAll(/\.ts["']/g)) problems.push(`${at(match.index)}: sobrou referência a .ts`);
  // Só posição de import: um texto como "@frankframes/cli@latest" (npm install -g) é string comum.
  for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']@frankframes\//g)) problems.push(`${at(match.index)}: sobrou import de @frankframes/ sem reescrever`);
  for (const match of code.matchAll(/\bimport\s*\(\s*(?!["'])/g)) {
    problems.push(`${at(match.index)}: import() dinâmico com especificador montado em runtime (a reescrita só cobre imports estáticos)`);
  }
  const builtins = new Set(builtinModules);
  for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"'\n]+)\1/g)) {
    const specifier = match[2]!;
    if (specifier.startsWith(".") || specifier.startsWith("node:") || specifier.startsWith("/")) continue;
    const name = packageOf(specifier);
    if (builtins.has(name) || declared.has(name)) continue;
    problems.push(`${at(match.index)}: import de "${specifier}" que não está nas dependências do estágio`);
  }
  return problems;
}

/** `new URL("<relativo>", import.meta.url)` literais: o destino precisa existir no estágio (ou ser fallback conhecido). */
export function checkUrlReferences(stage: string, file: string, code: string): string[] {
  const problems: string[] = [];
  for (const match of code.matchAll(/new URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/g)) {
    const target = resolve(dirname(file), match[2]!);
    const inside = relative(stage, target);
    const top = posix(inside).split("/")[0] ?? "";
    if (existsSync(target) || OPTIONAL_REFERENCES.includes(top)) continue;
    problems.push(`${posix(relative(stage, file))}: lê "${match[2]}", que não existe no estágio (${posix(inside)})`);
  }
  return problems;
}

function runTsc(stage: string): void {
  const require = createRequire(import.meta.url);
  let tsc: string;
  try {
    tsc = require.resolve("typescript/bin/tsc");
  } catch (error) {
    throw new ReleaseError("E_RELEASE_TSC_MISSING", `typescript não encontrado: ${(error as Error).message}`, "rode `npm install` na raiz do repositório");
  }
  const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", stage], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    throw new ReleaseError("E_RELEASE_TSC_FAILED", `tsc -p tsconfig.build.json saiu com ${result.status ?? "sinal"}`, "corrija os erros de tipo acima (`npx tsc --noEmit` mostra os mesmos)");
  }
}

interface PackedFile {
  path: string;
}

function runPack(stage: string, out: string): { filename: string; files: string[] } {
  const { file, args } = npmCommand(["pack", "--json", "--ignore-scripts", "--pack-destination", out]);
  const result = spawnSync(file, args, { cwd: stage, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new ReleaseError(
      "E_RELEASE_PACK_FAILED",
      `npm pack saiu com ${result.status ?? "sinal"}: ${(result.stderr || result.stdout).trim().slice(-600)}`,
      "rode `npm pack --dry-run` dentro de out/release/stage para ver o motivo",
    );
  }
  let packed: Array<{ filename?: string; files?: PackedFile[] }>;
  try {
    packed = JSON.parse(result.stdout) as typeof packed;
  } catch {
    throw new ReleaseError("E_RELEASE_PACK_FAILED", `saída do npm pack não é JSON: ${result.stdout.slice(0, 300)}`, "confira a versão do npm (`npm -v`)");
  }
  const entry = packed[0];
  if (entry?.filename === undefined || entry.files === undefined) {
    throw new ReleaseError("E_RELEASE_PACK_FAILED", "npm pack não informou o arquivo gerado", "confira a versão do npm (`npm -v`)");
  }
  return { filename: entry.filename, files: entry.files.map((item) => item.path) };
}

export interface BuildResult {
  stage: string;
  tarball: string;
  version: string;
  files: number;
  bytes: number;
}

export async function buildRelease(options: { out: string }): Promise<BuildResult> {
  const out = resolve(ROOT, options.out);
  const stage = join(out, "stage");
  await prepareOut(out);

  const rootManifest = readJson<PackageJson>(join(ROOT, "package.json"));
  const packagesRoot = join(ROOT, "packages");
  const packageNames = (await readdir(packagesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const workspaces = packageNames.map((name) => ({ name, manifest: readJson<PackageJson>(join(packagesRoot, name, "package.json")) }));
  const cliManifest = workspaces.find((item) => item.name === "cli")?.manifest;
  const version = cliManifest?.version;
  if (cliManifest === undefined || version === undefined) {
    throw new ReleaseError("E_RELEASE_VERSION", "packages/cli/package.json sem version", "defina a versão do pacote cli");
  }
  const skewed = workspaces.filter((item) => item.manifest.version !== version).map((item) => `${item.manifest.name}@${item.manifest.version}`);
  if (skewed.length > 0) {
    throw new ReleaseError("E_RELEASE_VERSION", `versões divergentes de ${version}: ${skewed.join(", ")}`, "todos os pacotes do monorepo andam na mesma versão");
  }

  // 1. tsc: .ts -> .js (imports relativos reescritos pelo próprio compilador).
  process.stdout.write("▶ tsc -p tsconfig.build.json\n");
  runTsc(stage);

  // 2. @frankframes/* -> caminho relativo.
  const lock = readJson<{ packages: Record<string, { version?: string }> }>(join(ROOT, "package-lock.json"));
  const dependencies = productionDependencies(workspaces.map((item) => item.manifest), lock);
  const declared = new Set(Object.keys(dependencies));
  const stagePackages = join(stage, "packages");
  const known = new Set(packageNames);
  const compiled = (await walk(stagePackages)).filter((file) => file.endsWith(".js"));
  if (compiled.length === 0) {
    throw new ReleaseError("E_RELEASE_VALIDATE", "o tsc não emitiu nenhum .js", "confira `include` em tsconfig.build.json");
  }
  const problems: string[] = [];
  for (const file of compiled) {
    const rewritten = rewriteWorkspaceImports(await readFile(file, "utf8"), dirname(file), stagePackages, known);
    await writeFile(file, rewritten);
    problems.push(...validateCompiledJs(posix(relative(stage, file)), rewritten, declared));
  }
  if (problems.length > 0) {
    throw new ReleaseError("E_RELEASE_VALIDATE", `JS do estágio inválido:\n  ${problems.join("\n  ")}`, "a reescrita cobre só import estático com especificador literal; ajuste o código-fonte");
  }

  // 3. Estáticos, docs e package.json de cada pacote.
  for (const item of STATIC_COPIES) {
    const from = join(ROOT, item.from);
    if (!existsSync(from)) {
      throw new ReleaseError("E_RELEASE_STATIC", `${item.from} não existe`, "o build copia esse caminho para o estágio; restaure-o ou tire-o de STATIC_COPIES");
    }
    await cp(from, join(stage, item.to), {
      recursive: true,
      filter: (source) => !(item.from === "docs" && DOCS_EXCLUDED.has(relative(from, source))),
    });
  }
  for (const item of workspaces) {
    await writeFile(join(stage, "packages", item.name, "package.json"), `${JSON.stringify(stagePackageJson(item.manifest), null, 2)}\n`);
  }

  // CHANGELOG.md só é obrigatório a partir da 1.0.0 (passo 7 do EDT-65); antes disso entra se existir.
  const changelog = join(ROOT, "CHANGELOG.md");
  const files = ["packages", "catalog", "docs", "LICENSE", "THIRD-PARTY-NOTICES.md"];
  if (existsSync(changelog)) {
    await cp(changelog, join(stage, "CHANGELOG.md"));
    files.push("CHANGELOG.md");
  } else if (Number.parseInt(version, 10) >= 1) {
    throw new ReleaseError("E_RELEASE_STATIC", "CHANGELOG.md ausente na versão 1.x", "escreva o CHANGELOG.md (EDT-65, passo 7)");
  } else {
    process.stdout.write("aviso: CHANGELOG.md ainda não existe (obrigatório a partir da 1.0.0)\n");
  }

  const manifest: PackageJson = {
    name: "@frankframes/cli",
    version,
    description: "FrankFrames — vídeo determinístico a partir de HTML",
    type: "module",
    license: cliManifest.license ?? "SEE LICENSE IN LICENSE",
    ...(rootManifest.author === undefined ? {} : { author: rootManifest.author }),
    bin: { frankframes: "packages/cli/src/cli.js" },
    engines: rootManifest.engines ?? { node: ">=22.18" },
    dependencies,
    files,
  };
  await writeFile(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // 4. Validação do estágio.
  const stageProblems: string[] = [];
  for (const path of files) {
    if (!existsSync(join(stage, path))) stageProblems.push(`arquivo de "files" ausente: ${path}`);
  }
  const cliJs = join(stage, "packages", "cli", "src", "cli.js");
  if (!existsSync(cliJs)) stageProblems.push("packages/cli/src/cli.js ausente");
  else if (!(await readFile(cliJs, "utf8")).startsWith("#!/usr/bin/env node")) stageProblems.push("packages/cli/src/cli.js sem shebang");
  for (const file of await walk(stagePackages)) {
    if (file.endsWith(".ts") && !file.endsWith(".d.ts")) stageProblems.push(`sobrou .ts no estágio: ${posix(relative(stage, file))}`);
    if (file.endsWith(".js")) stageProblems.push(...checkUrlReferences(stage, file, await readFile(file, "utf8")));
  }
  if (stageProblems.length > 0) {
    throw new ReleaseError("E_RELEASE_VALIDATE", `estágio inválido:\n  ${stageProblems.join("\n  ")}`, "corrija a origem e rode o build de novo");
  }

  // 5. npm pack -> <out>/frankframes-cli-<versão>.tgz
  process.stdout.write("▶ npm pack\n");
  const packed = runPack(stage, out);
  const tarball = join(out, packed.filename);
  const expected = `frankframes-cli-${version}.tgz`;
  if (packed.filename !== expected || !existsSync(tarball)) {
    throw new ReleaseError("E_RELEASE_PACK_FAILED", `tarball esperado ${expected}, o npm gerou ${packed.filename}`, "confira name e version do estágio");
  }
  const leaked = packed.files.filter((path) => FORBIDDEN_IN_TARBALL.some((pattern) => pattern.test(`package/${path}`)));
  if (leaked.length > 0) {
    throw new ReleaseError("E_RELEASE_VALIDATE", `o tarball leva arquivos que não deveriam estar nele: ${leaked.slice(0, 5).join(", ")}`, "ajuste STATIC_COPIES");
  }
  for (const needed of ["package.json", "packages/cli/src/cli.js", "catalog/blocks/title-card/index.html", "LICENSE"]) {
    if (!packed.files.includes(needed)) {
      throw new ReleaseError("E_RELEASE_VALIDATE", `o tarball não contém ${needed}`, "confira `files` no package.json do estágio");
    }
  }
  const info = await stat(tarball);
  return { stage, tarball, version, files: packed.files.length, bytes: info.size };
}

function parseArgs(argv: string[]): { out: string } {
  let out = "out/release";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--out") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("-")) {
        throw new ReleaseError("E_RELEASE_USAGE", "--out sem valor", "uso: node scripts/build-release.ts [--out <pasta>]");
      }
      out = value;
    } else {
      throw new ReleaseError("E_RELEASE_USAGE", `argumento desconhecido: ${arg}`, "uso: node scripts/build-release.ts [--out <pasta>]");
    }
  }
  return { out: isAbsolute(out) ? out : resolve(ROOT, out) };
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const started = Date.now();
    const result = await buildRelease(parseArgs(process.argv.slice(2)));
    const megabytes = (result.bytes / 1_048_576).toFixed(2);
    process.stdout.write(`\nok ${result.version} · ${result.files} arquivos · ${megabytes} MiB · ${((Date.now() - started) / 1000).toFixed(1)} s\n${result.tarball}\n`);
  } catch (error) {
    if (error instanceof ReleaseError) {
      process.stderr.write(`\n✖ ${error.code}: ${error.message}\n  dica: ${error.hint}\n`);
    } else {
      process.stderr.write(`\n✖ E_RELEASE_UNEXPECTED: ${(error as Error).stack ?? String(error)}\n`);
    }
    process.exitCode = 1;
  }
}
