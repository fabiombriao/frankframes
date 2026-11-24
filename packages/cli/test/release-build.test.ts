// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-65: o build do release (scripts/build-release.ts) gera um estágio JS compilado que roda de dentro de
// `node_modules` — onde o Node 24 recusa executar `.ts`. LENTO: roda `tsc` do repositório inteiro e
// `npm pack`, por isso fica na suíte completa e não nos testes rápidos.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTempDir } from "../../../scripts/test-support/temp.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SLOW = 5 * 60_000;

interface Manifest {
  name?: string;
  version?: string;
  type?: string;
  bin?: Record<string, string>;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: string[];
}

async function readJson(file: string): Promise<Manifest> {
  return JSON.parse(await readFile(file, "utf8")) as Manifest;
}

async function listFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listFiles(path)));
    else found.push(path);
  }
  return found;
}

describe("EDT-65 build do release", { timeout: SLOW }, () => {
  let temp: Awaited<ReturnType<typeof makeTempDir>> | undefined;
  let workdir = "";
  let releaseDir = "";
  let stageDir = "";
  let repoVersion = "";

  before(async () => {
    temp = await makeTempDir("ff-release-build-");
    workdir = temp.dir;
    releaseDir = join(workdir, "release");
    stageDir = join(releaseDir, "stage");
    repoVersion = (await readJson(join(ROOT, "packages", "cli", "package.json"))).version ?? "";

    const built = spawnSync(process.execPath, [join(ROOT, "scripts", "build-release.ts"), "--out", releaseDir], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: SLOW,
    });
    assert.equal(built.status, 0, `build-release.ts falhou (exit ${built.status})\n${built.stdout}\n${built.stderr}`);
  });

  after(async () => {
    await temp?.remove();
  });

  test("premissa: o Node recusa .ts dentro de node_modules (motivo de existir o build)", async () => {
    const probeDir = join(workdir, "premissa", "node_modules", "sonda");
    await mkdir(probeDir, { recursive: true });
    await writeFile(join(probeDir, "a.ts"), "export const valor: number = 1;\n");
    await writeFile(join(probeDir, "package.json"), '{"name":"sonda","type":"module"}\n');
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(probeDir, "a.ts")).href)})`], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
  });

  test("package.json do estágio: nome, bin, engines e só dependências de produção", async () => {
    const manifest = await readJson(join(stageDir, "package.json"));
    assert.equal(manifest.name, "@frankframes/cli");
    assert.equal(manifest.version, repoVersion);
    assert.equal(manifest.type, "module");
    assert.deepEqual(manifest.bin, { frankframes: "packages/cli/src/cli.js" });
    assert.equal(manifest.engines?.node, ">=22.18");
    assert.equal(manifest.devDependencies, undefined);

    const lock = JSON.parse(await readFile(join(ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string }>;
    };
    const dependencies = manifest.dependencies ?? {};
    for (const name of ["parse5", "puppeteer-core"]) {
      assert.ok(dependencies[name] !== undefined, `dependência de produção ausente: ${name}`);
    }
    for (const [name, version] of Object.entries(dependencies)) {
      assert.ok(!name.startsWith("@frankframes/"), `workspace não pode ser dependência do estágio: ${name}`);
      assert.notEqual(name, "typescript");
      assert.notEqual(name, "@types/node");
      assert.match(version, /^\d+\.\d+\.\d+/, `${name} sem versão exata: ${version}`);
      assert.equal(version, lock.packages[`node_modules/${name}`]?.version, `${name} diverge do package-lock.json`);
    }
    for (const path of manifest.files ?? []) {
      await stat(join(stageDir, path));
    }
  });

  test("nenhum .ts em packages/*/src e nenhum @frankframes/ restante no JS", async () => {
    const files = await listFiles(join(stageDir, "packages"));
    const sources = files.filter((file) => file.includes(`${join("src")}`) && /\.ts$/.test(file) && !file.endsWith(".d.ts"));
    assert.deepEqual(sources, []);
    const compiled = files.filter((file) => file.endsWith(".js") && !file.includes(join("cli", "src", "studio")));
    assert.ok(compiled.length > 50, `poucos .js compilados: ${compiled.length}`);
    for (const file of compiled) {
      const text = await readFile(file, "utf8");
      // Só posição de import: "@frankframes/cli@latest" em texto (upgrade --apply) é string comum.
      assert.doesNotMatch(text, /(?:\bfrom\s*|\bimport\s*\(?\s*)["']@frankframes\//, file);
      assert.doesNotMatch(text, /\.ts["']/, file);
    }
    const cli = await readFile(join(stageDir, "packages", "cli", "src", "cli.js"), "utf8");
    assert.ok(cli.startsWith("#!/usr/bin/env node"), "cli.js sem shebang");
  });

  test("estáticos presentes e nada de vendor/ nem goldens", async () => {
    await stat(join(stageDir, "catalog", "blocks", "title-card", "index.html"));
    await stat(join(stageDir, "catalog", "README.md"));
    await stat(join(stageDir, "docs", "contract.md"));
    await stat(join(stageDir, "LICENSE"));
    await stat(join(stageDir, "THIRD-PARTY-NOTICES.md"));
    await stat(join(stageDir, "packages", "cli", "skill", "frankframes", "SKILL.md"));
    await stat(join(stageDir, "packages", "cli", "src", "studio", "index.html"));
    const nested = await readJson(join(stageDir, "packages", "cli", "package.json"));
    assert.equal(nested.version, repoVersion);
    assert.equal(nested.type, "module");
    for (const absent of ["vendor", join("catalog", "goldens"), join("catalog", "goldens.json")]) {
      await assert.rejects(stat(join(stageDir, absent)), `não deveria existir no estágio: ${absent}`);
    }
  });

  test("gera o tarball frankframes-cli-<versão>.tgz ao lado do estágio", async () => {
    const tarball = join(releaseDir, `frankframes-cli-${repoVersion}.tgz`);
    const info = await stat(tarball);
    assert.ok(info.size > 100_000, `tarball pequeno demais: ${info.size} bytes`);
  });

  test("lint de um bloco roda de dentro de node_modules (copiando o estágio)", async () => {
    const prefix = join(workdir, "instalado");
    const installed = join(prefix, "node_modules", "@frankframes", "cli");
    await cp(stageDir, installed, { recursive: true });

    // Sem rede: as dependências de produção entram por junção apontando para o node_modules do repositório
    // (o Node resolve o caminho real, então as transitivas também vêm de lá).
    const manifest = await readJson(join(stageDir, "package.json"));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const link = join(prefix, "node_modules", ...name.split("/"));
      await mkdir(dirname(link), { recursive: true });
      await symlink(join(ROOT, "node_modules", ...name.split("/")), link, "junction");
    }

    const cli = join(installed, "packages", "cli", "src", "cli.js");
    const block = join(installed, "catalog", "blocks", "title-card", "index.html");
    const result = spawnSync(process.execPath, [cli, "lint", block, "--json"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, `lint falhou (exit ${result.status})\n${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout) as { ok: boolean; diagnostics: unknown[] };
    assert.equal(report.ok, true);

    const version = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), repoVersion);
  });
});
