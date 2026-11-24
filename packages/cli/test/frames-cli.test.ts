// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveFfmpeg } from "@frankframes/producer";
import { tempDir } from "../../../scripts/test-support/temp.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[]): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 120_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code !== "number") throw error;
    return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("frames de arquivo inexistente: exit 1, E_FRAMES_INPUT no stderr com a dica, JSON de erro no stdout", async () => {
  const outcome = await cli(["frames", join(tmpdir(), "ff-nao-existe-xyz.mp4"), "--json"]);
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /E_FRAMES_INPUT/);
  assert.match(outcome.stderr, /frankframes render/);
  const payload = JSON.parse(outcome.stdout) as { ok: boolean; code: string; hint: string };
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "E_FRAMES_INPUT");
});

test("frames sem o vídeo ou com opção desconhecida: exit 2 com o uso", async () => {
  for (const args of [["frames"], ["frames", "a.mp4", "--nada"], ["frames", "a.mp4", "b.mp4"], ["frames", "a.mp4", "--at"]]) {
    const outcome = await cli(args);
    assert.equal(outcome.code, 2, args.join(" "));
    assert.match(outcome.stderr, /uso: frankframes frames/);
  }
});

test("frames --json devolve os instantes pedidos, com estatística e PNG", async (t) => {
  let pair;
  try {
    pair = await resolveFfmpeg();
    await run(pair.ffmpeg, ["-hide_banner", "-version"], { timeout: 15_000 });
  } catch {
    t.skip("FFmpeg indisponível");
    return;
  }
  const dir = await tempDir(t, "ff-frames-cli-");
  const video = join(dir, "v.webm");
  await run(pair.ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:d=2:r=30",
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-y", video,
  ], { timeout: 60_000 });

  const out = join(dir, "pngs");
  const outcome = await cli(["frames", video, "--at", "25%,1.5", "-o", out, "--json"]);
  assert.equal(outcome.code, 0, outcome.stderr);
  const report = JSON.parse(outcome.stdout) as { durationSeconds: number; frames: Array<{ t: number; png: string; meanLuma: number; stdLuma: number; uniform: boolean }> };
  assert.deepEqual(report.frames.map((frame) => frame.t), [0.5, 1.5]);
  for (const frame of report.frames) {
    assert.ok(existsSync(frame.png), frame.png);
    assert.equal(frame.uniform, false);
    assert.equal(typeof frame.meanLuma, "number");
  }
  assert.ok(Math.abs(report.durationSeconds - 2) < 0.1);

  const text = await cli(["frames", video, "--at", "50%", "-o", out]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /t=1 s/);
});
