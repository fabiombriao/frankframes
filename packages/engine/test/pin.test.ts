// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BROWSER_PINS, BrowserPlatformError, PINNED_BROWSER_VERSION, browserPlatform, pinnedBrowser } from "../src/index.ts";

test("pin do shell: win32/x64 e linux/x64 têm entrada, com a mesma versão", () => {
  assert.equal(browserPlatform("win32", "x64"), "win64");
  assert.equal(browserPlatform("linux", "x64"), "linux64");
  assert.equal(pinnedBrowser("win32", "x64").version, PINNED_BROWSER_VERSION);
  assert.equal(pinnedBrowser("linux", "x64").version, PINNED_BROWSER_VERSION);
  assert.match(pinnedBrowser("win32", "x64").relative, /win64.*\.exe$/);
  assert.match(pinnedBrowser("linux", "x64").relative, /linux.*chrome-headless-shell$/);
});

test("pin do shell: cada plataforma tem digest próprio de 64 hex (nunca o de outra)", () => {
  for (const pin of Object.values(BROWSER_PINS)) assert.match(pin.sha256, /^[0-9a-f]{64}$/, `${pin.platform} sem digest válido`);
  assert.notEqual(BROWSER_PINS.win64.sha256, BROWSER_PINS.linux64.sha256);
});

test("pin do shell: plataforma sem pin falha alto com código e hint", () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["win32", "arm64"], ["linux", "arm64"], ["freebsd", "x64"]] as const) {
    assert.equal(browserPlatform(platform, arch), undefined);
    assert.throws(
      () => pinnedBrowser(platform, arch),
      (error: unknown) => {
        assert.ok(error instanceof BrowserPlatformError);
        assert.equal(error.code, "E_BROWSER_PLATFORM_UNSUPPORTED");
        assert.ok(error.message.includes(`${platform}/${arch}`), error.message);
        assert.match(error.hint, /FRANKFRAMES_CHROME/);
        assert.ok(error.message.includes(error.hint), "o hint vai dentro da message");
        return true;
      },
    );
  }
});
