// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { EncodePolicyError } from "@frankframes/encode";
import type { FfmpegPair, RenderOptions, RenderResult } from "@frankframes/producer";
import { ExportError, createExporter } from "../src/studio-export.ts";
import type { ExportJob, ExporterOptions } from "../src/studio-export.ts";

const HTML = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>teste</title></head>
<body style="margin:0;background:#000">
<div data-composition-id="teste" data-width="640" data-height="360" data-fps="30" data-duration="2">
  <div data-clip-id="a" data-start="0" data-duration="1" class="clip">Primeiro</div>
</div>
</body>
</html>
`;

const PAIR: FfmpegPair = { ffmpeg: "ffmpeg-falso", ffprobe: "ffprobe-falso", source: "path", warnings: [] };
const RESULT: RenderResult = { outPath: "", frames: 60, durationSeconds: 2, codec: "av1", preset: "draft", hasAudio: false, warnings: [], hashes: new Map(), workDir: "" };

/** Render falso que só termina quando o sinal aborta (e então rejeita, como o pipeline real). */
function holdUntilAbort(seen: { signal?: AbortSignal; calls: number }): (options: RenderOptions) => Promise<RenderResult> {
  return (options) => {
    seen.calls += 1;
    seen.signal = options.signal;
    return new Promise<RenderResult>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("render cancelado")), { once: true });
    });
  };
}

async function withExporter(
  overrides: Partial<ExporterOptions>,
  run: (exporter: ReturnType<typeof createExporter>, dir: string, events: ExportJob[]) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ff-export-test-"));
  const entry = join(dir, "comp.html");
  await writeFile(entry, HTML, "utf8");
  const events: ExportJob[] = [];
  const exporter = createExporter({
    entry,
    resolveFfmpeg: async () => PAIR,
    guard: async () => {},
    reveal: async () => {},
    onEvent: (job) => events.push(job),
    ...overrides,
  });
  try {
    await run(exporter, dir, events);
  } finally {
    await exporter.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function rejection(promise: Promise<unknown>): Promise<ExportError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ExportError, `esperava ExportError, veio ${String(error)}`);
    return error;
  }
  assert.fail("esperava rejeição");
}

test("export: segundo pedido com um em andamento é E_EXPORT_BUSY", async () => {
  const seen = { calls: 0 } as { signal?: AbortSignal; calls: number };
  await withExporter({ render: holdUntilAbort(seen) }, async (exporter) => {
    await exporter.start({ preset: "draft", output: "a.mp4" });
    const error = await rejection(exporter.start({ preset: "draft", output: "b.mp4" }));
    assert.equal(error.code, "E_EXPORT_BUSY");
    assert.equal(error.status, 409);
    assert.equal(seen.calls, 1, "o segundo pedido não chega ao render");
  });
});

test("export: cancelar aborta o render e o job termina canceled", async () => {
  const seen = { calls: 0 } as { signal?: AbortSignal; calls: number };
  await withExporter({ render: holdUntilAbort(seen) }, async (exporter, _dir, events) => {
    await exporter.start({ preset: "draft", output: "a.mp4" });
    await exporter.cancel();
    assert.equal(seen.signal?.aborted, true);
    assert.equal(exporter.job()?.status, "canceled");
    assert.equal(events.at(-1)?.status, "canceled");
  });
});

test("export: cancelar sem export em andamento é E_EXPORT_IDLE", async () => {
  await withExporter({}, async (exporter) => {
    const error = await rejection(exporter.cancel());
    assert.equal(error.code, "E_EXPORT_IDLE");
    assert.equal(error.status, 409);
  });
});

test("export: extensão incompatível com o codec é E_EXPORT_OUTPUT_INVALID", async () => {
  const seen = { calls: 0 } as { signal?: AbortSignal; calls: number };
  await withExporter({ render: holdUntilAbort(seen) }, async (exporter) => {
    const error = await rejection(exporter.start({ preset: "draft", codec: "av1", output: "video.webm" }));
    assert.equal(error.code, "E_EXPORT_OUTPUT_INVALID");
    assert.equal(error.status, 400);
    assert.equal(seen.calls, 0);
  });
});

test("export: contrato inválido bloqueia com diagnósticos e não chama o render", async () => {
  const seen = { calls: 0 } as { signal?: AbortSignal; calls: number };
  await withExporter({ render: holdUntilAbort(seen) }, async (exporter, dir) => {
    await writeFile(join(dir, "comp.html"), HTML.replace('data-start="0"', 'data-start="abc"'), "utf8");
    const error = await rejection(exporter.start({ preset: "draft", output: "a.mp4" }));
    assert.equal(error.code, "E_CONTRACT_INVALID");
    assert.equal(error.status, 400);
    assert.ok(Array.isArray(error.diagnostics) && error.diagnostics.length > 0, "traz os diagnósticos do contrato");
    assert.equal(seen.calls, 0);
    assert.equal(exporter.job(), null, "nenhum job é criado");
  });
});

test("export: h264 sem opt-in falha com o erro da guarda de licença", async () => {
  const seen = { calls: 0 } as { signal?: AbortSignal; calls: number };
  await withExporter(
    {
      render: holdUntilAbort(seen),
      guard: async () => {
        throw new EncodePolicyError("E_H264_NOT_OPTED_IN", "H.264 exige FRANKFRAMES_ALLOW_H264=1");
      },
    },
    async (exporter) => {
      const error = await rejection(exporter.start({ preset: "draft", codec: "h264", output: "a.mp4" }));
      assert.equal(error.code, "E_H264_NOT_OPTED_IN");
      assert.equal(error.status, 400);
      assert.equal(seen.calls, 0);
    },
  );
});

test("export: o progresso do render vira evento com estágio e percentual", async () => {
  await withExporter(
    {
      render: async (options) => {
        options.onProgress?.("capture", 50);
        return RESULT;
      },
    },
    async (exporter, _dir, events) => {
      await exporter.start({ preset: "draft", output: "a.mp4" });
      await exporter.idle();
      const progress = events.find((job) => job.stage === "capture" && job.percent === 50);
      assert.ok(progress, JSON.stringify(events));
      assert.equal(progress.status, "running");
      assert.equal(exporter.job()?.status, "done");
      assert.equal(exporter.job()?.result?.frames, 60);
    },
  );
});

test("export: falha do render vira failed com o payload de erro", async () => {
  await withExporter(
    {
      render: async () => {
        throw new Error("quebrou");
      },
    },
    async (exporter) => {
      await exporter.start({ preset: "draft", output: "a.mp4" });
      await exporter.idle();
      const job = exporter.job();
      assert.equal(job?.status, "failed");
      assert.ok(job?.error, "failed carrega o payload do erro");
    },
  );
});

test("export: abrir a pasta só vale com o job concluído e usa o caminho absoluto", async () => {
  const revealed: string[] = [];
  await withExporter(
    {
      render: async () => RESULT,
      reveal: async (file) => {
        revealed.push(file);
      },
    },
    async (exporter) => {
      const before = await rejection(exporter.reveal());
      assert.equal(before.code, "E_EXPORT_NOT_DONE");
      await exporter.start({ preset: "draft", output: "a.mp4" });
      await exporter.idle();
      await exporter.reveal();
      assert.equal(revealed.length, 1);
      assert.ok(isAbsolute(revealed[0] ?? ""));
      assert.match(revealed[0] ?? "", /a\.mp4$/);
    },
  );
});

test("export: destino existente sem overwrite é E_EXPORT_EXISTS; com overwrite segue", async () => {
  await withExporter({ render: async () => RESULT }, async (exporter, dir) => {
    await writeFile(join(dir, "a.mp4"), "x");
    const error = await rejection(exporter.start({ preset: "draft", output: "a.mp4" }));
    assert.equal(error.code, "E_EXPORT_EXISTS");
    assert.equal(error.status, 409);
    await exporter.start({ preset: "draft", output: "a.mp4", overwrite: true });
    await exporter.idle();
    assert.equal(exporter.job()?.status, "done");
  });
});
