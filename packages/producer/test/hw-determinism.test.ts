// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * EDT-77: o contrato (§9) promete "igual nesta máquina" em hardware, e o padrão é `--gpu auto`.
 * Este teste renderiza `examples/cena-dupla` em `auto` com vários workers, 3 vezes, e exige o mesmo
 * SHA-256 por frame nas três rodadas. É o teste que a correção do EDT-77 vai fazer passar.
 *
 * Usa o render completo (`renderComposition`, com o encode em andamento), o mesmo caminho em que o sintoma
 * foi visto, não só a captura. Com 1 worker e em software o hash por frame já é estável; o problema só
 * aparece com hardware e vários workers, por isso o número de workers é fixo em 6 (o padrão da máquina de
 * referência). `FF_HW_WORKERS` muda o número só para investigação.
 *
 * Sem Chrome, sem FFmpeg ou sem GPU de hardware o teste faz `skip` com o motivo; nunca passa em silêncio.
 */
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChrome, resolveGpuMode } from "@frankframes/engine";
import { resolveFfmpeg } from "../src/ffmpeg.ts";
import { renderComposition } from "../src/render.ts";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "examples", "cena-dupla", "index.html");
const ROUNDS = 3;
const WORKERS = Math.max(2, Math.floor(Number(process.env.FF_HW_WORKERS ?? 6)) || 6);

test(
  "hardware (auto) com vários workers: hash por frame igual em 3 rodadas (EDT-77)",
  { timeout: 1_800_000 },
  async (t) => {
    let chromePath: string;
    try {
      chromePath = (await resolveChrome()).path;
    } catch (error) {
      t.skip(`Chrome não encontrado: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const pair = await resolveFfmpeg();
    if (pair.source === "path") {
      // Sem o FFmpeg pinado o render do produto não é o que roda no gate; sem nenhum, nem há render.
      try {
        await promisify(execFile)(pair.ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
      } catch {
        t.skip("FFmpeg não encontrado (nem em vendor/ffmpeg, nem em FFMPEG_PATH, nem no PATH)");
        return;
      }
    }

    // Só vale em máquina com GPU de hardware: `auto` cai para SwiftShader sem ela, e em software o hash já é estável.
    const resolved = await resolveGpuMode("auto", chromePath);
    if (resolved !== "hardware") {
      t.skip(`--gpu auto resolveu como ${resolved}: esta máquina não tem GPU de hardware utilizável`);
      return;
    }

    const workspace = await mkdtemp(join(tmpdir(), "ff-hwdet-"));
    try {
      const rounds: Array<Map<number, string>> = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        const result = await renderComposition({
          entry: ENTRY,
          outPath: join(workspace, `round-${round}.mp4`),
          ffmpeg: pair.ffmpeg,
          ffprobe: pair.ffprobe,
          codec: "av1",
          preset: "draft",
          gpu: "auto",
          workers: WORKERS,
        });
        assert.equal(result.hashes.size, result.frames, `rodada ${round + 1}: faltou hash de algum frame`);
        rounds.push(result.hashes);
      }

      const reference = rounds[0] as Map<number, string>;
      assert.equal(reference.size, 240, `cena-dupla tem 8 s a 30 fps = 240 frames, obtido ${reference.size}`);
      // A composição precisa animar: se todos os frames saíssem iguais, igualdade entre rodadas não provaria nada.
      assert.ok(new Set(reference.values()).size > 100, "poucos hashes distintos: a composição não animou, o teste não prova nada");

      const unstable: Array<{ frame: number; variants: number }> = [];
      for (const frame of [...reference.keys()].sort((a, b) => a - b)) {
        const variants = new Set(rounds.map((hashes) => hashes.get(frame)));
        if (variants.size > 1) unstable.push({ frame, variants: variants.size });
      }
      assert.equal(
        unstable.length,
        0,
        `${unstable.length} de ${reference.size} frames com hash diferente entre ${ROUNDS} rodadas ` +
          `(auto -> hardware, ${WORKERS} workers); primeiros: ${unstable.slice(0, 10).map((u) => u.frame).join(", ")}`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
