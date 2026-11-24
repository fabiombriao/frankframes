// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-78: quem chama `prepare` sem renderizar não pode deixar `ff-render-*` no temporário.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveChrome } from "@frankframes/engine";
import { captureFrameAt } from "../src/goldens.ts";
import { prepare } from "../src/render.ts";
import { resolveFfmpeg } from "../src/ffmpeg.ts";
import { makeTempDir } from "../../../scripts/test-support/temp.ts";

const run = promisify(execFile);

const PLAIN = `<html><body><div data-composition-id="main" data-root="true" data-width="320" data-height="180"
  data-fps="30" data-duration="1"><div data-clip-id="t" data-start="0" data-duration="1">oi</div></div></body></html>`;

const TEMP_VARS = ["TEMP", "TMP", "TMPDIR"] as const;

/**
 * Roda `fn` com um temporário só deste teste: outros testes (e o resto do sistema) não mexem nele, então
 * contar `ff-render-*` aqui é exato. `os.tmpdir()` relê o ambiente a cada chamada.
 */
async function withIsolatedTemp<T>(fn: (temp: string) => Promise<T>): Promise<T> {
  const saved = TEMP_VARS.map((name) => [name, process.env[name]] as const);
  const made = await makeTempDir("ff-isolated-tmp-");
  const temp = await realpath(made.dir);
  for (const name of TEMP_VARS) process.env[name] = temp;
  try {
    return await fn(temp);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await made.remove();
  }
}

async function renderDirs(temp: string): Promise<string[]> {
  return (await readdir(temp)).filter((name) => name.startsWith("ff-render-")).sort();
}

async function workspaceIn(temp: string): Promise<string> {
  const workspace = join(temp, "ws");
  await mkdir(workspace, { recursive: true });
  return workspace;
}

async function chromeOrSkip(t: TestContext): Promise<boolean> {
  try {
    await resolveChrome();
    return true;
  } catch {
    t.skip("Chrome não encontrado");
    return false;
  }
}

test("prepare sem mídia e sem render não deixa ff-render-* no temporário", async () => {
  await withIsolatedTemp(async (temp) => {
    const entry = join(await workspaceIn(temp), "index.html");
    await writeFile(entry, PLAIN);
    assert.deepEqual(await renderDirs(temp), [], "o temporário isolado começa sem ff-render-*");

    for (let i = 0; i < 3; i += 1) {
      const prepared = await prepare({ entry });
      assert.equal(prepared.seconds, 1);
    }
    assert.deepEqual(await renderDirs(temp), [], "prepare não cria pasta de trabalho");
  });
});

test("prepare que falha no contrato também não deixa ff-render-*", async () => {
  await withIsolatedTemp(async (temp) => {
    const entry = join(await workspaceIn(temp), "ruim.html");
    await writeFile(entry, "<html><body><div>sem composição</div></body></html>");
    await assert.rejects(prepare({ entry }), /contrato|duração/i);
    assert.deepEqual(await renderDirs(temp), []);
  });
});

test("prepare com vídeo (extração de frames) e sem render não deixa ff-render-*", { timeout: 300_000 }, async (t) => {
  const pair = await resolveFfmpeg();
  try {
    await run(pair.ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
  } catch {
    return t.skip("ffmpeg não encontrado");
  }
  await withIsolatedTemp(async (temp) => {
    const dir = await workspaceIn(temp);
    await run(pair.ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=1",
      "-c:v", "mpeg4", "-q:v", "5", "-pix_fmt", "yuv420p", "-y", join(dir, "clip.mp4"),
    ]);
    const entry = join(dir, "index.html");
    await writeFile(
      entry,
      `<html><body><div data-composition-id="main" data-root="true" data-width="320" data-height="180" data-fps="30" data-duration="1">
        <video data-clip-id="v" data-start="0" data-duration="1" src="clip.mp4" style="position:fixed;left:0;top:0;width:160px;height:90px"></video>
      </div></body></html>`,
    );
    const prepared = await prepare({ entry, ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe });
    assert.ok(prepared.manifest !== undefined && prepared.manifest.clips.length === 1, "o vídeo foi extraído de verdade");
    assert.deepEqual(await renderDirs(temp), []);
  });
});

test("conferência de goldens (captureFrameAt) não deixa ff-render-*", { timeout: 300_000 }, async (t) => {
  if (!(await chromeOrSkip(t))) return;
  await withIsolatedTemp(async (temp) => {
    const entry = join(await workspaceIn(temp), "index.html");
    await writeFile(entry, PLAIN);
    const shot = await captureFrameAt(entry);
    assert.ok(shot.png.length > 0);
    assert.deepEqual(await renderDirs(temp), []);
  });
});
