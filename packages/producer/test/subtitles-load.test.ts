// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChrome } from "@frankframes/engine";
import { captureGolden } from "../src/goldens.ts";

const CATALOG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "catalog", "blocks");
const SESSIONS = 16;
const PARALLEL = 8;

/**
 * EDT-13: em `software`, sob carga de CPU, o raster do texto da legenda do `subtitles` saía com outra fase de
 * subpixel em ~1/3 das sessões (frames 13 e 40, poucos glifos de `.c1 .line`) e ficava assim a sessão inteira.
 * O DOM era idêntico; só o estado da camada do compositor mudava. Esta prova repete o cenário que divergia
 * (sessões em paralelo + CPUs saturadas) e exige um único hash por frame: falha sem a reconstrução da camada
 * em `startSession`, passa com ela. Sem carga o defeito aparece em ~1 de 12 sessões, por isso o teste a gera.
 */
test("subtitles sob carga: toda sessão em software dá o mesmo hash por frame", { timeout: 900_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch {
    t.skip("Chrome não encontrado");
    return;
  }
  const burners = Array.from({ length: Math.max(4, availableParallelism()) }, () =>
    spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }),
  );
  const hashes = new Map<string, number>();
  try {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < SESSIONS) {
        next += 1;
        const golden = await captureGolden(join(CATALOG, "subtitles", "index.html"), { gpu: "software" });
        const key = golden.frames.map((f) => `${f.frame}:${f.sha256.slice(0, 8)}`).join(" ");
        hashes.set(key, (hashes.get(key) ?? 0) + 1);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  } finally {
    const exits = burners.map((b) => (b.exitCode === null ? once(b, "exit") : Promise.resolve()));
    for (const b of burners) b.kill("SIGKILL");
    await Promise.all(exits);
  }
  assert.equal(
    hashes.size,
    1,
    `as ${SESSIONS} sessões deveriam dar o mesmo conjunto de hashes; saíram ${hashes.size}: ${JSON.stringify([...hashes])}`,
  );
});
