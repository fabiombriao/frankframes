// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOTION_PROPERTIES, OWNED_BY_PROP } from "@frankframes/contract";
import { CLOCK_SOURCE } from "../src/clock.ts";
import { injectionScript } from "../src/inject.ts";
import { MOTION_SOURCE } from "../src/motion-runtime.ts";

test("o runtime registra exatamente as propriedades do contrato (fonte única)", () => {
  for (const property of MOTION_PROPERTIES) {
    assert.ok(MOTION_SOURCE.includes(JSON.stringify(property)), `falta ${property.name}`);
  }
  assert.ok(MOTION_SOURCE.includes(JSON.stringify(OWNED_BY_PROP)), "tabela de posse do contrato");
  assert.ok(MOTION_SOURCE.includes("inherits: false"), "as variáveis não herdam");
});

test("o relógio expõe prepare e o runtime depende dele, sem GSAP nem biblioteca", () => {
  assert.ok(CLOCK_SOURCE.includes("prepare,"), "__ff.prepare exposto");
  assert.ok(MOTION_SOURCE.includes("clock.prepare("));
  assert.ok(MOTION_SOURCE.includes(".animate("), "WAAPI");
  assert.ok(!/gsap/i.test(MOTION_SOURCE));
});

test("o runtime entra logo depois do relógio e antes de manifesto, shim e áudio", () => {
  const block = injectionScript({
    manifest: { clips: [{ id: "v", frames: 1, fps: 30 }] } as never,
    audio: { disabled: "x" },
  });
  const clock = block.indexOf("window.__ff =");
  const motion = block.indexOf("E_MOTION_RUNTIME: relógio virtual ausente");
  const media = block.indexOf("window.__ffMedia=");
  const audio = block.indexOf("__ffPreviewAudio=");
  assert.ok(clock >= 0 && motion > clock, "relógio primeiro");
  assert.ok(media > motion && audio > motion, "runtime antes de mídia e áudio");
});

test("falha de preparação é fatal: o relógio rejeita ready com a mensagem do gancho", () => {
  // Corpo do settle: o gancho roda dentro de try e o erro vai para readyDeferred.reject.
  const at = CLOCK_SOURCE.indexOf("for (const hook of prepareHooks) hook();");
  assert.ok(at > 0);
  const start = CLOCK_SOURCE.lastIndexOf("const settle = () => {", at);
  const end = CLOCK_SOURCE.indexOf("document.fonts", at);
  assert.ok(start >= 0 && end > at);
  const around = CLOCK_SOURCE.slice(start, end);
  assert.ok(around.includes("try {") && around.includes("readyDeferred.reject(error)"));
});
