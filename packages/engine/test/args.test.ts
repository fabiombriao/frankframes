// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromeArgs, gpuFlags } from "../src/args.ts";

const PLATAFORMAS = ["win32", "darwin", "linux"] as const;
const SEM_COMPOSITOR_GPU = "--disable-gpu-compositing";

for (const platform of PLATAFORMAS) {
  test(`hardware em ${platform}: compositor em software (EDT-77)`, () => {
    const flags = gpuFlags("hardware", platform);
    assert.ok(flags.includes(SEM_COMPOSITOR_GPU), `faltou ${SEM_COMPOSITOR_GPU} em ${platform}: ${flags.join(" ")}`);
  });

  test(`hardware em ${platform}: o ANGLE segue no driver real`, () => {
    const flags = gpuFlags("hardware", platform);
    assert.ok(
      flags.some((flag) => flag.startsWith("--use-angle=") && flag !== "--use-angle=swiftshader"),
      `esperava ANGLE do driver real em ${platform}: ${flags.join(" ")}`,
    );
    assert.ok(!flags.includes("--enable-unsafe-swiftshader"), "hardware não pode ligar o SwiftShader");
  });
}

test("software mantém o SwiftShader e o compositor em software", () => {
  const flags = gpuFlags("software", "win32");
  assert.ok(flags.includes("--use-angle=swiftshader"));
  assert.ok(flags.includes(SEM_COMPOSITOR_GPU));
});

test("chromeArgs em hardware inclui --disable-gpu-compositing, uma vez só", () => {
  const args = chromeArgs({ viewport: { width: 1280, height: 720 }, gpu: "hardware" });
  assert.equal(args.filter((flag) => flag === SEM_COMPOSITOR_GPU).length, 1);
  assert.ok(args.includes("--window-size=1280,720"));
});

test("chromeArgs em software também leva a flag, uma vez só", () => {
  const args = chromeArgs({ viewport: { width: 1280, height: 720 }, gpu: "software" });
  assert.equal(args.filter((flag) => flag === SEM_COMPOSITOR_GPU).length, 1);
});
