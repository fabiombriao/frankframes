// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Prova de que ESTA plataforma reproduz a si mesma (EDT-13): captura os frames de todos os blocos do catálogo
 * em `software` duas vezes, em PROCESSOS separados, e compara o hash de cada frame entre as rodadas. Não lê
 * nem grava `catalog/goldens`: é o pré-requisito para gerar goldens de uma plataforma nova.
 *
 *   node scripts/goldens-self-check.ts [--out out/goldens-self-check.json] [--blocks a,b] [--rounds N]
 *
 * `--blocks` limita a prova a esses blocos; `--rounds` (padrão 2) sobe o número de processos comparados (para diagnóstico).
 *
 * Sai com 1 se algum frame diferir entre as rodadas (ou se uma rodada falhar). Uso interno: `--capture <arquivo>`.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { captureGolden } from "@frankframes/producer";
import { defaultConcurrency, mapPool } from "./pool.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const blocksDir = join(root, "catalog", "blocks");

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "out/goldens-self-check.json" },
    capture: { type: "string" },
    blocks: { type: "string" },
    rounds: { type: "string", default: "2" },
  },
  strict: true,
});

/** Hash por frame de cada bloco: `bloco/frame` → SHA-256. */
type Hashes = Record<string, string>;

async function captureAll(): Promise<Hashes> {
  const all = (await readdir(blocksDir)).sort();
  const wanted = values.blocks?.split(",").map((slug) => slug.trim()).filter((slug) => slug !== "");
  for (const slug of wanted ?? []) if (!all.includes(slug)) throw new Error(`bloco inexistente: ${slug}`);
  const slugs = wanted ?? all;
  const perBlock = await mapPool(slugs, defaultConcurrency(), async (slug) => {
    const golden = await captureGolden(join(blocksDir, slug, "index.html"), { gpu: "software" });
    return golden.frames.map((frame): [string, string] => [`${slug}/${frame.frame}`, frame.sha256]);
  });
  return Object.fromEntries(perBlock.flat());
}

if (values.capture !== undefined) {
  const target = resolve(root, values.capture);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(await captureAll(), null, 2)}\n`);
} else {
  const outPath = resolve(root, values.out ?? "out/goldens-self-check.json");
  const rounds = Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 2) throw new Error(`--rounds precisa de um inteiro ≥ 2: ${values.rounds}`);
  const runs: Hashes[] = [];
  for (let round = 1; round <= rounds; round++) {
    const file = join(dirname(outPath), `goldens-self-check-rodada${round}.json`);
    process.stdout.write(`rodada ${round}: processo novo\n`);
    // Falha de uma rodada (Chrome, página) aparece com o stderr dela; nunca vira "sem diferença".
    try {
      await exec(process.execPath, [fileURLToPath(import.meta.url), "--capture", file, ...(values.blocks !== undefined ? ["--blocks", values.blocks] : [])], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      throw new Error(`rodada ${round} falhou: ${failure.message}\n${failure.stderr ?? ""}`);
    }
    runs.push(JSON.parse(await readFile(file, "utf8")) as Hashes);
  }
  const keys = [...new Set(runs.flatMap((run) => Object.keys(run)))].sort();
  const diverging = keys.filter((key) => new Set(runs.map((run) => run[key])).size > 1);
  const summary = {
    platform: `${process.platform}/${process.arch}`,
    frames: keys.length,
    rodadas: rounds,
    identicos: keys.length - diverging.length,
    divergentes: diverging.length,
  };
  await writeFile(outPath, `${JSON.stringify({ summary, diverging }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  for (const key of diverging) process.stdout.write(`diverge ${key}: ${runs.map((run) => run[key]?.slice(0, 8) ?? "ausente").join(" ")}
`);
  process.exitCode = diverging.length === 0 && keys.length > 0 ? 0 : 1;
}
