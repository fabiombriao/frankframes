// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, retryOnceIfTransient } from "../src/failures.ts";

test("classifica falha de browser fechado como transiente e repetível", () => {
  assert.deepEqual(
    { kind: classifyFailure(new Error("Protocol error (Page.captureScreenshot): TargetCloseError")).kind, retryable: classifyFailure(new Error("TargetCloseError")).retryable },
    { kind: "transient", retryable: true },
  );
});

test("erro de autoria e de imagem nunca é repetido", () => {
  assert.equal(classifyFailure(new Error("data-start inválido em fedora")).retryable, false);
  assert.equal(classifyFailure(new Error("Image 3 failed to load")).kind, "verification");
  assert.equal(classifyFailure(new Error("ENOENT: no such file or directory")).kind, "io");
  assert.equal(classifyFailure(new Error("something odd")).kind, "unknown");
});

test("retryOnceIfTransient repete uma vez só em falha transiente", async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error("TargetCloseError");
    return "ok";
  };
  assert.equal(await retryOnceIfTransient(flaky), "ok");
  assert.equal(calls, 2);
});

test("retryOnceIfTransient não repete erro não transiente", async () => {
  let calls = 0;
  await assert.rejects(
    retryOnceIfTransient(async () => {
      calls++;
      throw new Error("data-start inválido");
    }),
  );
  assert.equal(calls, 1);
});
