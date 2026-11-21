// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-54: transições entre clips adjacentes, com Chrome e FFmpeg reais. Spec: docs/contract.md §7b.10.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openSessionFor, resolveChrome, startServer } from "@frankframes/engine";
import { compileComposition } from "../src/compile.ts";
import { resolveFfmpeg } from "../src/ffmpeg.ts";

const run = promisify(execFile);
const FPS = { num: 30, den: 1 };

async function environmentOrSkip(t: TestContext): Promise<boolean> {
  try {
    await resolveChrome();
  } catch {
    t.skip("Chrome não encontrado");
    return false;
  }
  const pair = await resolveFfmpeg();
  try {
    await run(pair.ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
  } catch {
    t.skip("ffmpeg não encontrado");
    return false;
  }
  return true;
}

/**
 * A (vermelho, 0–2 s) e B (azul) começando em `a - 0.5`: a transição ocupa [1,5 s; 2 s].
 * Sem transição B só existiria a partir de 2 s, então o frame do meio só difere dos outros
 * se o motion de A e B estiver de fato aplicado.
 */
const card = (id: string, color: string, start: string, attrs: string): string =>
  `<div id="${id}" data-clip-id="${id}" data-start="${start}" data-duration="2" ${attrs}
     style="position:fixed;left:0;top:0;width:320px;height:180px;background:${color}"></div>`;

const PRESETS = ["dissolver", "cortina", "empurrar", "zoom", "iris"] as const;

// Frame 30 = só A (1,0 s); frames 46–59 = meio da transição; frame 75 = só B (2,5 s).
const ONLY_A = 30;
const ONLY_B = 75;
const MIDDLE = [46, 52, 59];
const FRAMES = [0, ONLY_A, ...MIDDLE, ONLY_B, 104];

for (const preset of PRESETS) {
  test(`transição ${preset}: o meio difere de só A e de só B e o seek é determinístico`, { timeout: 600_000 }, async (t) => {
    if (!(await environmentOrSkip(t))) return;

    const dir = await mkdtemp(join(tmpdir(), `ff-transition-${preset}-`));
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style></head><body>
<div data-composition-id="main" data-root="true" data-width="320" data-height="180" data-fps="30">
${card("a", "#d02020", "0", "")}
${card("b", "#2030d0", "a - 0.5", `data-transition="${preset}"`)}
</div></body></html>`;
    const compiled = await compileComposition({ entryHtml: html, entryDir: dir });
    assert.equal(compiled.composition.ok, true, JSON.stringify(compiled.composition.diagnostics));
    assert.ok(compiled.html.includes("data-ff-motion"), "o compilador precisa anotar o motion da transição");

    const server = await startServer(dir, { page: { path: "index.html", html: compiled.html } });
    const session = await openSessionFor(server, { url: `${server.url}index.html`, viewport: { width: 320, height: 180 }, gpu: "auto" });
    try {
      const hashes = new Map<number, string>();
      for (const frame of FRAMES) {
        await session.seekFrame(frame, FPS);
        hashes.set(frame, (await session.capture()).sha256);
      }
      const onlyA = hashes.get(ONLY_A)!;
      const onlyB = hashes.get(ONLY_B)!;
      assert.notEqual(onlyA, onlyB, "só A e só B precisam ser diferentes (cores distintas)");
      for (const frame of MIDDLE) {
        const mid = hashes.get(frame)!;
        assert.notEqual(mid, onlyA, `frame ${frame} igual ao frame só com A`);
        assert.notEqual(mid, onlyB, `frame ${frame} igual ao frame só com B`);
      }
      assert.ok(new Set(MIDDLE.map((f) => hashes.get(f))).size === MIDDLE.length, "os frames do meio precisam ser distintos entre si");

      // Seek em ordem, repetido e invertido dá os mesmos pixels.
      for (const order of [FRAMES, FRAMES, [...FRAMES].reverse()]) {
        for (const frame of order) {
          await session.seekFrame(frame, FPS);
          assert.equal((await session.capture()).sha256, hashes.get(frame), `frame ${frame} mudou com a ordem do seek`);
        }
      }
      assert.deepEqual(session.pageErrors(), []);
    } finally {
      await session.close();
      await server.close();
    }
  });
}
