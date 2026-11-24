// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureFfmpeg, ensureFonts } from "../src/setup.ts";
import { withTempDir } from "../../../scripts/test-support/temp.ts";

function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  return withTempDir("ff-home-", async (home) => {
    const previous = process.env.FRANKFRAMES_HOME;
    process.env.FRANKFRAMES_HOME = home;
    try {
      return await run(home);
    } finally {
      if (previous === undefined) delete process.env.FRANKFRAMES_HOME;
      else process.env.FRANKFRAMES_HOME = previous;
    }
  });
}

test("ffmpeg com digest diferente do manifesto é detectado", async () => {
  await withHome(async (home) => {
    const bin = join(home, "ffmpeg", "bin");
    await mkdir(bin, { recursive: true });
    const binary = join(bin, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    await writeFile(binary, "binario adulterado");

    await writeFile(join(home, "ffmpeg", "manifest.json"), JSON.stringify({ ffmpegSha256: "0".repeat(64) }));
    const bad = await ensureFfmpeg({ check: true });
    assert.equal(bad.state, "falhou", "digest diferente precisa reprovar");

    const digest = createHash("sha256").update(await readFile(binary)).digest("hex");
    await writeFile(join(home, "ffmpeg", "manifest.json"), JSON.stringify({ ffmpegSha256: digest }));
    const good = await ensureFfmpeg({ check: true });
    assert.equal(good.state, "ok");
  });
});

test("home vazio reporta fontes e ffmpeg ausentes, sem baixar", async () => {
  await withHome(async () => {
    const fonts = await ensureFonts({ check: true });
    assert.equal(fonts.state, "ausente");
    const ffmpeg = await ensureFfmpeg({ check: true });
    assert.equal(ffmpeg.state, "ausente");
  });
});

/** Troca o `fetch` global: licença (URL .../LICENSE) responde `license`; fonte responde um woff2 mínimo. */
async function withFetch<T>(license: (url: string) => Response, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/LICENSE")) return license(url);
    return new Response(Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(16)]), { status: 200 });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("fontes: falha ao baixar a licença OFL não derruba o setup, mas aparece no detail com o nome e o motivo", async () => {
  await withHome(async () => {
    const step = await withFetch(() => new Response("indisponível", { status: 503 }), () => ensureFonts());
    assert.equal(step.state, "instalado");
    assert.match(step.detail, /aviso: \d+ licença\(s\) OFL não baixada\(s\)/);
    assert.match(step.detail, /OFL-[\w-]+\.txt: .*HTTP 503/);
  });
});

test("fontes: com todas as licenças baixadas o detail não traz aviso", async () => {
  await withHome(async () => {
    const step = await withFetch(() => new Response("licença", { status: 200 }), () => ensureFonts());
    assert.equal(step.state, "instalado");
    assert.ok(!step.detail.includes("aviso"), step.detail);
  });
});
