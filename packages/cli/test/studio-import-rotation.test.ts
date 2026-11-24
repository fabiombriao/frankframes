// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveFfmpeg } from "@frankframes/producer";
import { startStudio } from "../src/studio-server.ts";
import { withTempDir } from "../../../scripts/test-support/temp.ts";

const run = promisify(execFile);

const HTML = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>teste</title></head>
<body style="margin:0;background:#000">
<div data-composition-id="teste" data-width="1080" data-height="1920" data-fps="30" data-duration="2"></div>
</body>
</html>
`;

/** Vídeo 160x96 gravado em paisagem e regravado só no contêiner com a Display Matrix pedida (sem libx264). */
async function makeVideo(ffmpeg: string, dir: string, name: string, flags: string[]): Promise<Buffer> {
  const base = join(dir, `${name}-base.mp4`);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=160x96:r=10:d=1", "-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p", "-y", base]);
  const out = join(dir, `${name}.mp4`);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", ...flags, "-i", base, "-c", "copy", "-y", out]);
  return readFile(out);
}

/** EDT-86: o import mede a orientação de exibição e recusa rotação que preview e render não aplicariam igual. */
test("estúdio importa vídeo com rotação -90 informando a exibição e recusa 45° sem deixar arquivo", async (t) => {
  let ffmpeg: string;
  try {
    ffmpeg = (await resolveFfmpeg()).ffmpeg;
  } catch (error) {
    t.skip(`ffmpeg indisponível: ${(error as Error).message}`);
    return;
  }
  await withTempDir("ff-studio-rot-", async (dir) => {
    const entry = join(dir, "comp.html");
    await writeFile(entry, HTML, "utf8");
    const server = await startStudio({ entry });
    try {
      const upload = async (name: string, body: Buffer): Promise<{ status: number; json: Record<string, unknown> }> => {
        const response = await fetch(`${server.url}api/media?name=${encodeURIComponent(name)}&start=0`, { method: "POST", body: new Uint8Array(body) });
        return { status: response.status, json: (await response.json()) as Record<string, unknown> };
      };

      const portrait = await upload("retrato.mp4", await makeVideo(ffmpeg, dir, "retrato", ["-display_rotation", "270"]));
      assert.equal(portrait.status, 200, JSON.stringify(portrait.json));
      assert.deepEqual(
        portrait.json.orientation,
        { rotation: -90, mirrored: false, displayWidth: 96, displayHeight: 160 },
        "informa rotação e dimensões de exibição (o arquivo é 160x96)",
      );

      const tilted = await upload("torto.mp4", await makeVideo(ffmpeg, dir, "torto", ["-display_rotation", "45"]));
      assert.equal(tilted.status, 400);
      assert.equal(tilted.json.code, "E_MEDIA_ROTATION");
      await assert.rejects(readFile(join(dir, "assets", "torto.mp4")), "arquivo recusado não fica no projeto");
    } finally {
      await server.close();
    }
  });
});
