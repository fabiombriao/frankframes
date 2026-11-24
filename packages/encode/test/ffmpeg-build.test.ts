// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EncodePolicyError, FFMPEG_BUILDS, POLICY_CODES, ffmpegBuildFor, ffmpegPlatform } from "../src/index.ts";

test("pin do FFmpeg: win64 (zip) e linux64 (tar.xz) na mesma versão e na mesma tag datada", () => {
  const win = ffmpegBuildFor("win32", "x64");
  const linux = ffmpegBuildFor("linux", "x64");
  assert.equal(win.platform, "win64");
  assert.equal(linux.platform, "linux64");
  assert.equal(win.format, "zip");
  assert.equal(linux.format, "tar.xz");
  assert.equal(win.version, linux.version);
  assert.equal(win.tag, linux.tag);
  assert.match(win.tag, /^autobuild-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/, "tag datada e imutável, nunca `latest`");
  for (const build of Object.values(FFMPEG_BUILDS)) {
    assert.ok(build.url.includes(`/download/${build.tag}/`), build.url);
    assert.ok(build.url.endsWith(build.archive), build.url);
    assert.ok(build.archive.endsWith(`.${build.format}`));
    assert.ok(build.root.includes("lgpl"), "só build LGPL");
    assert.match(build.sha256, /^[0-9a-f]{64}$/);
  }
  assert.notEqual(win.sha256, linux.sha256);
});

test("pin do FFmpeg: plataforma sem pin falha alto com código e hint", () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["win32", "arm64"], ["linux", "arm64"], ["freebsd", "x64"]] as const) {
    assert.equal(ffmpegPlatform(platform, arch), undefined);
    assert.throws(
      () => ffmpegBuildFor(platform, arch),
      (error: unknown) => {
        assert.ok(error instanceof EncodePolicyError);
        assert.equal(error.code, "E_FFMPEG_PLATFORM_UNSUPPORTED");
        assert.ok(error.message.includes(`${platform}/${arch}`), error.message);
        assert.match(error.hint ?? "", /FFMPEG_PATH/);
        assert.ok(error.message.includes(error.hint ?? "?"), "o hint vai dentro da message");
        return true;
      },
    );
  }
  assert.ok(POLICY_CODES.includes("E_FFMPEG_PLATFORM_UNSUPPORTED"));
});
