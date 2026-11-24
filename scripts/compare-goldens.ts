// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Compara os goldens do catálogo com a máquina atual em modo `software` e CONTA, por frame:
 * idêntico (hash igual), só PSNR (hash diferente, PSNR ≥ 50 dB) ou falha (PSNR < 50 dB ou sem PNG de referência).
 * Não regenera nada: é a medição do EDT-13 (Windows × Linux). Sai com 1 se algum frame falhar.
 *
 *   node scripts/compare-goldens.ts [--out out/goldens-compare.json] [--set win64|linux64]
 *
 * Sem `--set` compara com o conjunto da plataforma atual; `--set` escolhe o conjunto de outra plataforma (medição cruzada).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveChrome } from "@frankframes/engine";
import { captureGolden, engineSignature, loadGoldenSet, psnr } from "@frankframes/producer";
import { defaultConcurrency, mapPool } from "./pool.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const MIN_PSNR_DB = 50;

type Verdict = "identico" | "psnr" | "falha";

interface FrameResult {
  block: string;
  frame: number;
  verdict: Verdict;
  /** PSNR em dB (Infinity vira `null` no JSON); só medido quando o hash difere. */
  psnr: number | null;
  detail: string | undefined;
}

const { values } = parseArgs({ options: { out: { type: "string", default: "out/goldens-compare.json" }, set: { type: "string" } }, strict: true });
const outPath = resolve(root, values.out ?? "out/goldens-compare.json");

// Conjunto da plataforma atual; a medição entre plataformas usa `--set <plataforma>` (referência de OUTRA plataforma).
const NODE_PLATFORM: Record<string, string> = { win64: "win32", linux64: "linux" };
if (values.set !== undefined && NODE_PLATFORM[values.set] === undefined) throw new Error(`--set ${values.set} desconhecido: use ${Object.keys(NODE_PLATFORM).join(" ou ")}`);
const { manifest, pngPath, platform: goldenPlatform } =
  values.set === undefined ? await loadGoldenSet(join(root, "catalog")) : await loadGoldenSet(join(root, "catalog"), NODE_PLATFORM[values.set], "x64");
const engine = await engineSignature("software");
const chrome = await resolveChrome();

const perBlock = await mapPool(manifest.blocks, defaultConcurrency(), async (expected): Promise<FrameResult[]> => {
  const actual = await captureGolden(join(root, "catalog", "blocks", expected.name, "index.html"), { gpu: "software", includePng: true });
  const results: FrameResult[] = [];
  for (const golden of expected.frames) {
    const got = actual.frames.find((frame) => frame.frame === golden.frame);
    if (got === undefined) {
      results.push({ block: expected.name, frame: golden.frame, verdict: "falha", psnr: null, detail: "frame não capturado" });
      continue;
    }
    if (got.sha256 === golden.sha256) {
      results.push({ block: expected.name, frame: golden.frame, verdict: "identico", psnr: null, detail: undefined });
      continue;
    }
    // Referência ausente ou ilegível é falha com o motivo, nunca "sem diferença".
    let stored: Buffer;
    try {
      stored = await readFile(pngPath(expected.name, golden.frame));
    } catch (error) {
      results.push({ block: expected.name, frame: golden.frame, verdict: "falha", psnr: null, detail: `sem PNG de referência: ${(error as Error).message}` });
      continue;
    }
    if (got.png === undefined) {
      results.push({ block: expected.name, frame: golden.frame, verdict: "falha", psnr: null, detail: "captura sem PNG" });
      continue;
    }
    const quality = await psnr(got.png, stored);
    results.push({
      block: expected.name,
      frame: golden.frame,
      verdict: quality >= MIN_PSNR_DB ? "psnr" : "falha",
      psnr: Number.isFinite(quality) ? quality : null,
      detail: undefined,
    });
  }
  return results;
});

const frames = perBlock.flat();
const count = (verdict: Verdict): number => frames.filter((item) => item.verdict === verdict).length;
const summary = {
  platform: `${process.platform}/${process.arch}`,
  goldenSet: goldenPlatform,
  browser: chrome.version,
  pinned: chrome.pinned,
  manifestBrowser: manifest.engine.browser,
  gpu: engine.gpu,
  blocks: manifest.blocks.length,
  frames: frames.length,
  identicos: count("identico"),
  soPsnr: count("psnr"),
  falhas: count("falha"),
  minPsnrDb: MIN_PSNR_DB,
};
const diverging = frames.filter((item) => item.verdict !== "identico");

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify({ summary, diverging, frames }, null, 2)}\n`);

process.stdout.write(`${JSON.stringify(summary)}\n`);
for (const item of diverging) {
  process.stdout.write(`${item.verdict.padEnd(5)} ${item.block} frame ${item.frame}${item.psnr === null ? "" : ` PSNR ${item.psnr.toFixed(2)} dB`}${item.detail === undefined ? "" : ` — ${item.detail}`}\n`);
}
process.stdout.write(`relatório: ${outPath}\n`);
process.exitCode = summary.falhas > 0 ? 1 : 0;
