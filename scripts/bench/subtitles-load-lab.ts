// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Laboratório do EDT-13: por que `subtitles` (frames 13 e 40) muda de hash em `software` quando a máquina está
 * carregada. Captura o bloco N vezes, `--parallel` ao mesmo tempo, sob `--load` laços de CPU, compara o hash de
 * cada frame com o da primeira captura e guarda os PNGs de cada hash distinto. Só diagnóstico: nada de `packages/`
 * muda e o produto não usa nada daqui.
 *
 *   node scripts/bench/subtitles-load-lab.ts [--block subtitles] [--rounds 30] [--parallel 4] [--load 10] [--out out/subtitles-lab]
 *
 * Saída: tabela no stdout e `out/subtitles-lab/<plataforma>/resumo.json` + `<frame>-<hash8>.png` por hash distinto.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { captureGolden } from "@frankframes/producer";
import { mapPool } from "../pool.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: {
    block: { type: "string", default: "subtitles" },
    rounds: { type: "string", default: "30" },
    parallel: { type: "string", default: "4" },
    load: { type: "string", default: "10" },
    out: { type: "string", default: "out/subtitles-lab" },
  },
  strict: true,
});
const rounds = Number(values.rounds);
const parallel = Number(values.parallel);
const load = Number(values.load);
const block = values.block ?? "subtitles";
const outDir = join(resolve(root, values.out ?? "out/subtitles-lab"), `${process.platform}-${block}`);
await mkdir(outDir, { recursive: true });

/** Laços de CPU em processos separados (o "10 loops" do lab do EDT-77). */
const burners: ChildProcess[] = [];
for (let i = 0; i < load; i++) burners.push(spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
const stopLoad = (): void => {
  for (const child of burners) child.kill("SIGKILL");
};
process.on("exit", stopLoad);

try {
  const entry = join(root, "catalog", "blocks", block, "index.html");
  const captures = await mapPool(Array.from({ length: rounds }, (_, i) => i), parallel, async (round) => {
    const golden = await captureGolden(entry, { gpu: "software", includePng: true });
    return { round, frames: golden.frames };
  });

  const reference = new Map(captures[0]!.frames.map((frame) => [frame.frame, frame.sha256]));
  const distinct = new Map<string, Buffer>(); // `${frame}-${hash8}` → PNG
  const perFrame = new Map<number, { total: number; diverged: number; hashes: Map<string, number> }>();
  for (const capture of captures) {
    for (const frame of capture.frames) {
      const stat = perFrame.get(frame.frame) ?? { total: 0, diverged: 0, hashes: new Map() };
      stat.total += 1;
      if (frame.sha256 !== reference.get(frame.frame)) stat.diverged += 1;
      stat.hashes.set(frame.sha256.slice(0, 8), (stat.hashes.get(frame.sha256.slice(0, 8)) ?? 0) + 1);
      perFrame.set(frame.frame, stat);
      if (frame.png !== undefined) distinct.set(`${frame.frame}-${frame.sha256.slice(0, 8)}`, frame.png);
    }
  }
  for (const [name, png] of distinct) await writeFile(join(outDir, `${name}.png`), png);

  const rows = [...perFrame].sort((a, b) => a[0] - b[0]).map(([frame, stat]) => ({
    frame,
    capturas: stat.total,
    divergentesDaPrimeira: stat.diverged,
    hashes: Object.fromEntries(stat.hashes),
  }));
  // Diverge = a captura tem ao menos um frame com hash diferente do da primeira captura.
  const roundsDiverged = captures.filter((capture) => capture.frames.some((frame) => frame.sha256 !== reference.get(frame.frame))).length;
  const cpuCount = (await import("node:os")).cpus().length;
  const summary = { platform: `${process.platform}/${process.arch}`, cpus: cpuCount, block, rounds, parallel, load, roundsDiverged, rows };
  await writeFile(join(outDir, "resumo.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${process.platform}: ${roundsDiverged} de ${rounds} capturas com ao menos um frame diferente da primeira (parallel ${parallel}, load ${load}, ${cpuCount} CPUs)\n`);
  for (const row of rows) process.stdout.write(`  frame ${String(row.frame).padStart(3)}: ${row.divergentesDaPrimeira}/${row.capturas} divergentes  hashes ${JSON.stringify(row.hashes)}\n`);
  process.stdout.write(`PNGs distintos: ${outDir}\n`);
} finally {
  stopLoad();
}
