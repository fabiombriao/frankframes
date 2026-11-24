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
