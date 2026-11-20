// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Política do projeto, verificada — não confiada à memória.
 *
 *   node scripts/check-policy.ts
 *
 * Reprova se aparecer: workflow de GitHub Actions, dependência proibida,
 * encoder GPL no código, fonte de CDN no caminho de render, `.env` versionado,
 * ou se faltar a licença/spec.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);

const failures: string[] = [];
const passes: string[] = [];

function fail(rule: string, detail: string): void {
  failures.push(`${rule}: ${detail}`);
}

function pass(rule: string): void {
  passes.push(rule);
}

function walk(dir: string, filter: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, filter));
    else if (filter(path)) out.push(path);
  }
  return out;
}

// 1. GitHub Actions proibido.
const workflows = existsSync(join(ROOT, ".github/workflows")) ? readdirSync(join(ROOT, ".github/workflows")) : [];
if (workflows.length > 0) fail("GitHub Actions", `${workflows.length} workflow(s) em .github/workflows: ${workflows.join(", ")}`);
else pass("GitHub Actions: ausente");

// 2. Dependências proibidas.
const FORBIDDEN_DEPS = ["gsap", "ffmpeg-static", "@ffmpeg-installer/ffmpeg", "fluent-ffmpeg", "remotion", "@remotion/cli"];
const manifests = [join(ROOT, "package.json"), ...walk(join(ROOT, "packages"), (p) => p.endsWith("package.json"))];
for (const manifest of manifests) {
  const json = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, Record<string, string> | undefined>;
  const deps = { ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) };
  for (const dep of FORBIDDEN_DEPS) {
    if (deps[dep] !== undefined) fail("dependência proibida", `${relative(ROOT, manifest)} declara ${dep}`);
  }
}
if (failures.length === 0) pass(`dependências: ${manifests.length} manifestos sem GPL/GSAP`);

// 3. Encoder GPL no código de produção.
// Menções legítimas: o bloco de política e os módulos que descrevem o build LGPL.
const ALLOWED_GPL_MENTIONS: Record<string, true> = {
  "packages/encode/src/policy.ts": true,
  "packages/encode/src/ffmpeg-build.ts": true,
  "packages/cli/src/setup.ts": true,
};
for (const file of walk(join(ROOT, "packages"), (p) => p.includes(`${join("src", "")}`) && p.endsWith(".ts") && !p.endsWith(".test.ts"))) {
  const rel = relative(ROOT, file).split("\\").join("/");
  if (ALLOWED_GPL_MENTIONS[rel] === true) continue;
  const text = readFileSync(file, "utf8");
  if (/libx26[45]|--enable-gpl/.test(text)) fail("encoder GPL", `${rel} menciona encoder GPL`);
}
pass("encoders GPL: só na lista de bloqueio");

// 4. Fonte de CDN no caminho de render (setup pode baixar; render não).
const ALLOWED_CDN: Record<string, true> = { "packages/cli/src/setup.ts": true };
for (const file of walk(join(ROOT, "packages"), (p) => p.includes(`${join("src", "")}`) && p.endsWith(".ts"))) {
  const rel = relative(ROOT, file).split("\\").join("/");
  if (ALLOWED_CDN[rel] === true) continue;
  const text = readFileSync(file, "utf8");
  if (/fonts\.googleapis|cdn\.jsdelivr|unpkg\.com/.test(text)) fail("CDN em render", `${rel} referencia fonte de CDN`);
}
pass("fontes: nenhuma CDN no caminho de render");

// 5. `.env` versionado.
const tracked = await run("git", ["ls-files", ".env"], { cwd: ROOT }).then((result) => result.stdout.trim()).catch(() => "");
if (tracked !== "") fail(".env versionado", ".env está no git");
else pass(".env: fora do versionamento");

// 6. Licença e spec presentes.
if (!existsSync(join(ROOT, "LICENSE"))) fail("licença", "LICENSE ausente");
else if (!readFileSync(join(ROOT, "LICENSE"), "utf8").includes("Fábio Morales Brião")) fail("licença", "LICENSE sem o titular");
else pass("licença: presente com titular");
if (!existsSync(join(ROOT, "docs/contract.md"))) fail("spec", "docs/contract.md ausente");
else pass("spec: docs/contract.md presente");

for (const rule of passes) process.stdout.write(`ok    ${rule}\n`);
for (const item of failures) process.stdout.write(`FALHA ${item}\n`);
process.stdout.write(`\n${passes.length} regra(s) ok · ${failures.length} violação(ões)\n`);
process.exit(failures.length === 0 ? 0 : 1);
