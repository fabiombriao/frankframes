// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RenderError } from "@frankframes/producer";
import type { FramesReport, RenderOptions, RenderResult } from "@frankframes/producer";
import { buildContextDir, buildPrompt, checkGeneratedHtml, contractForPrompt, outputFormat, validateRequest } from "../src/generate-context.ts";
import type { GenerationAgent } from "../src/generate-codex.ts";
import { GenerateError } from "../src/generate-errors.ts";
import { runGenerate } from "../src/generate.ts";
import type { GenerateOptions } from "../src/generate.ts";

const VALID = readFileSync(fileURLToPath(new URL("./fixtures/video-1080p.html", import.meta.url)), "utf8");
const FORMAT = outputFormat("16:9");

const reply = (html: string): string => JSON.stringify({ html, blocks: [], notes: "" });

interface Seen {
  prompt: string;
  files: string[];
  previous: string | undefined;
  diagnostics: string | undefined;
  contextDir: string;
  fileText: Map<string, string>;
}

/** Agente em memória: `replies` devolve a resposta (ou lança) da n-ésima chamada e registra o que o agente enxergou. */
function fakeAgent(replies: (n: number) => string | Error): { agent: GenerationAgent; seen: Seen[]; checks: number } {
  const seen: Seen[] = [];
  const state = { checks: 0 };
  const agent: GenerationAgent = {
    name: "fake",
    async check() {
      state.checks++;
      return { version: "fake 1.0" };
    },
    async run(input) {
      const files = (readdirSync(input.contextDir, { recursive: true }) as string[]).map((f) => f.replaceAll("\\", "/")).sort();
      const fileText = new Map<string, string>();
      for (const file of files) {
        if (/\.(json|md|html)$/.test(file)) fileText.set(file, readFileSync(join(input.contextDir, file), "utf8"));
      }
      seen.push({
        prompt: input.prompt,
        files,
        previous: fileText.get("previous.html"),
        diagnostics: fileText.get("diagnostics.json"),
        contextDir: input.contextDir,
        fileText,
      });
      const next = replies(seen.length);
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return {
    agent,
    seen,
    get checks() {
      return state.checks;
    },
  };
}

async function temp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ff-gen-test-"));
}

function base(outDir: string, agent: GenerationAgent, extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { request: "abertura de 3 s", outDir, format: FORMAT, attempts: 3, timeoutMs: 5000, render: false, force: false, keepContext: false, agent, ...extra };
}

const draftRender = async (options: RenderOptions): Promise<RenderResult> => {
  writeFileSync(options.outPath, "draft");
  return { outPath: options.outPath, frames: 90, durationSeconds: 3, codec: "av1", preset: "draft", hasAudio: false, warnings: [], hashes: new Map(), workDir: "" } as unknown as RenderResult;
};

const framesReport = (uniform: boolean[]): ((input: string, outDir: string, at: string) => Promise<FramesReport>) => {
  return async (input) => ({
    file: input,
    durationSeconds: 3,
    frames: uniform.map((u, i) => ({ t: i, png: `frame-${i}.png`, meanLuma: u ? 0 : 90, stdLuma: u ? 0 : 40, uniform: u })),
  });
};

test("lint reprova na 1ª tentativa; o reparo recebe E_NO_ROOT, previous.html e diagnostics.json", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent((n) => reply(n === 1 ? "<div>sem raiz</div>" : VALID));
    const report = await runGenerate(base(dir, fake.agent));
    assert.equal(report.attempts.length, 2);
    assert.equal(report.attempts[0]!.ok, false);
    assert.ok(report.attempts[0]!.diagnostics.some((d) => d.code === "E_NO_ROOT"));
    assert.equal(report.attempts[1]!.ok, true);
    assert.equal(fake.seen[0]!.previous, undefined, "1ª tentativa não tem reparo");
    assert.match(fake.seen[1]!.prompt, /E_NO_ROOT/);
    assert.equal(fake.seen[1]!.previous, "<div>sem raiz</div>");
    assert.match(fake.seen[1]!.diagnostics ?? "", /E_NO_ROOT/);
    assert.equal(readFileSync(join(dir, "index.html"), "utf8"), VALID);
    assert.ok(existsSync(join(dir, ".generate", "attempt-1.html")) && existsSync(join(dir, ".generate", "attempt-2.html")));
    assert.ok(existsSync(join(dir, "generate.json")));
    assert.equal(report.render, null, "--no-render não gera draft");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sempre inválido: E_GEN_EXHAUSTED, sem index.html, com a última tentativa guardada", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent(() => reply("<p>nada</p>"));
    await assert.rejects(runGenerate(base(dir, fake.agent)), (error: unknown) => {
      assert.ok(error instanceof GenerateError);
      assert.equal(error.code, "E_GEN_EXHAUSTED");
      assert.equal(error.attempts?.length, 3);
      assert.match(error.hint, /attempt-3\.html/);
      return true;
    });
    assert.equal(fake.seen.length, 3);
    assert.ok(!existsSync(join(dir, "index.html")));
    assert.ok(existsSync(join(dir, ".generate", "attempt-3.html")));
    const failure = JSON.parse(readFileSync(join(dir, "generate.json"), "utf8")) as { ok: boolean; code: string };
    assert.equal(failure.ok, false);
    assert.equal(failure.code, "E_GEN_EXHAUSTED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--attempts 1: uma chamada só", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent(() => reply("<p>nada</p>"));
    await assert.rejects(runGenerate(base(dir, fake.agent, { attempts: 1 })), /1 tentativa/);
    assert.equal(fake.seen.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("<script> no HTML é E_GEN_FORBIDDEN e o index.html não é entregue", async () => {
  const dir = await temp();
  try {
    const withScript = VALID.replace("</body>", "<script>1</script></body>");
    const fake = fakeAgent(() => reply(withScript));
    await assert.rejects(runGenerate(base(dir, fake.agent, { attempts: 2 })), /E_GEN_FORBIDDEN/);
    assert.ok(!existsSync(join(dir, "index.html")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkGeneratedHtml: xmlns do SVG passa; http(s), //cdn, gsap e data-media-start são E_GEN_FORBIDDEN", () => {
  const svg = VALID.replace("Relatório do trimestre", '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><path d="M0 0"/></svg>');
  assert.deepEqual(checkGeneratedHtml(svg, FORMAT), []);
  for (const bad of ['<img src="https://x.test/a.png">', '<link href="//cdn.test/x.css">', "<!-- gsap -->", '<div data-media-start="1"></div>', '<a href="http://x.test">x</a>']) {
    const found = checkGeneratedHtml(VALID.replace("</body>", `${bad}</body>`), FORMAT);
    assert.ok(found.some((d) => d.code === "E_GEN_FORBIDDEN" && d.severity === "error"), bad);
  }
  // um http(s) de verdade ao lado do xmlns do SVG continua sendo pego
  assert.ok(checkGeneratedHtml(svg.replace("</body>", '<img src="https://x.test/a.png"></body>'), FORMAT).some((d) => d.code === "E_GEN_FORBIDDEN"));
});

test("resposta que não é JSON vira E_CODEX_OUTPUT como diagnóstico e conta como tentativa", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent((n) => (n === 1 ? "isto não é JSON" : reply(VALID)));
    const report = await runGenerate(base(dir, fake.agent));
    assert.equal(report.attempts.length, 2);
    assert.equal(report.attempts[0]!.diagnostics[0]!.code, "E_CODEX_OUTPUT");
    assert.match(fake.seen[1]!.prompt, /E_CODEX_OUTPUT/);
    // sem HTML anterior não há previous.html, mas o agente recebe o diagnóstico
    assert.equal(fake.seen[1]!.previous, undefined);
    assert.match(fake.seen[1]!.diagnostics ?? "", /E_CODEX_OUTPUT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JSON fora do schema (sem html, blocks ruim) também é E_CODEX_OUTPUT", async () => {
  const dir = await temp();
  try {
    const answers = [JSON.stringify({ blocks: [], notes: "" }), JSON.stringify({ html: VALID, blocks: [1], notes: "" }), reply(VALID)];
    const fake = fakeAgent((n) => answers[n - 1]!);
    const report = await runGenerate(base(dir, fake.agent));
    assert.equal(report.attempts.length, 3);
    assert.equal(report.attempts[0]!.diagnostics[0]!.code, "E_CODEX_OUTPUT");
    assert.equal(report.attempts[1]!.diagnostics[0]!.code, "E_CODEX_OUTPUT");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("E_CODEX_OUTPUT lançado pelo agente também é tentado de novo", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent((n) => (n === 1 ? new GenerateError("E_CODEX_OUTPUT", "sem última mensagem", "veja o log") : reply(VALID)));
    const report = await runGenerate(base(dir, fake.agent));
    assert.equal(report.attempts.length, 2);
    assert.equal(report.attempts[0]!.diagnostics[0]!.code, "E_CODEX_OUTPUT");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formato errado: raiz 1080×1920 pedida em 16:9 é E_GEN_FORMAT_MISMATCH", async () => {
  const dir = await temp();
  try {
    const vertical = VALID.replace('data-width="1920" data-height="1080"', 'data-width="1080" data-height="1920"');
    const fake = fakeAgent(() => reply(vertical));
    await assert.rejects(runGenerate(base(dir, fake.agent, { attempts: 1 })), /E_GEN_FORMAT_MISMATCH/);
    assert.ok(checkGeneratedHtml(vertical, FORMAT).some((d) => d.code === "E_GEN_FORMAT_MISMATCH"));
    assert.deepEqual(checkGeneratedHtml(vertical, outputFormat("9:16")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("duração: 3 s contra o pedido de 6 s é E_GEN_DURATION_MISMATCH; dentro de 0,5 s passa", () => {
  assert.ok(checkGeneratedHtml(VALID, FORMAT, 6).some((d) => d.code === "E_GEN_DURATION_MISMATCH" && d.severity === "error"));
  assert.deepEqual(checkGeneratedHtml(VALID, FORMAT, 3.4), []);
  assert.deepEqual(checkGeneratedHtml(VALID, FORMAT), [], "sem duração pedida não confere");
});

test("pasta de saída com index.html sem --force é E_GEN_OUT_EXISTS e o agente nunca roda; com --force segue", async () => {
  const dir = await temp();
  try {
    writeFileSync(join(dir, "index.html"), "<p>velho</p>");
    const fake = fakeAgent(() => reply(VALID));
    await assert.rejects(runGenerate(base(dir, fake.agent)), (error: unknown) => error instanceof GenerateError && error.code === "E_GEN_OUT_EXISTS");
    assert.equal(fake.seen.length, 0);
    assert.equal(fake.checks, 0);
    assert.equal(readFileSync(join(dir, "index.html"), "utf8"), "<p>velho</p>");
    const report = await runGenerate(base(dir, fake.agent, { force: true }));
    assert.equal(report.ok, true);
    assert.equal(readFileSync(join(dir, "index.html"), "utf8"), VALID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("privacidade: bytes de mídia do projeto nunca entram no prompt nem no contexto; só nome e duração", async () => {
  const dir = await temp();
  const project = await temp();
  try {
    mkdirSync(join(project, "assets"));
    writeFileSync(join(project, "assets", "clip.mp4"), "MEDIA-BYTES-7f3a");
    writeFileSync(join(project, "assets", "logo.png"), "MEDIA-BYTES-7f3a");
    writeFileSync(join(project, "notas.txt"), "MEDIA-BYTES-7f3a");
    const fake = fakeAgent(() => reply(VALID));
    await runGenerate(base(dir, fake.agent, { project: { dir: project, probe: async () => 12.5 } }));
    const seen = fake.seen[0]!;
    assert.ok(!seen.prompt.includes("MEDIA-BYTES-7f3a"));
    for (const [file, text] of seen.fileText) assert.ok(!text.includes("MEDIA-BYTES-7f3a"), `${file} vazou bytes`);
    assert.ok(!seen.files.some((f) => /\.(mp4|png|jpg|mp3|wav)$/.test(f)), "nenhum binário no contexto");
    const projectJson = JSON.parse(seen.fileText.get("project.json")!) as Array<{ path: string; kind: string; durationSeconds: number | null }>;
    assert.deepEqual(projectJson, [
      { path: "assets/clip.mp4", kind: "video", durationSeconds: 12.5 },
      { path: "assets/logo.png", kind: "img", durationSeconds: null },
    ]);
    assert.match(seen.prompt, /project\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("sem --project não há project.json", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent(() => reply(VALID));
    await runGenerate(base(dir, fake.agent));
    assert.ok(!fake.seen[0]!.files.includes("project.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("o contexto traz SKILL.md, contract.md, catálogo, presets de motion e o schema", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent(() => reply(VALID));
    await runGenerate(base(dir, fake.agent));
    const seen = fake.seen[0]!;
    for (const file of ["SKILL.md", "contract.md", "catalog/index.json", "catalog/blocks/chart-bars/index.html", "motion/presets.json", "output-schema.json"]) {
      assert.ok(seen.files.includes(file), `falta ${file}`);
    }
    const presets = JSON.parse(seen.fileText.get("motion/presets.json")!) as Array<{ name: string }>;
    assert.ok(presets.some((p) => p.name === "surgir"));
    assert.ok(presets.every((p) => !("build" in p)), "funções de construção não vão para o JSON");
    const index = JSON.parse(seen.fileText.get("catalog/index.json")!) as unknown[];
    assert.ok(index.length >= 48);
    assert.match(seen.prompt, /<<<PEDIDO/);
    assert.match(seen.prompt, /abertura de 3 s/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("contexto: removido ao fim, ou guardado com --keep-context (report.contextDir)", async () => {
  const dir = await temp();
  const dir2 = await temp();
  try {
    const fake = fakeAgent(() => reply(VALID));
    const dropped = await runGenerate(base(dir, fake.agent));
    assert.equal(dropped.contextDir, undefined);
    assert.ok(!existsSync(fake.seen[0]!.contextDir), "pasta ff-generate-* apagada");
    assert.match(fake.seen[0]!.contextDir, /ff-generate-/);

    const kept = await runGenerate(base(dir2, fake.agent, { keepContext: true }));
    assert.ok(kept.contextDir !== undefined && existsSync(kept.contextDir));
    await rm(kept.contextDir!, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  }
});

test("contexto apagado também quando a geração falha", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent(() => new GenerateError("E_CODEX_FAILED", "quebrou", "veja o log"));
    await assert.rejects(runGenerate(base(dir, fake.agent)), /quebrou/);
    assert.ok(!existsSync(fake.seen[0]!.contextDir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex fora da conta (check E_CODEX_AUTH) falha antes de criar a pasta de saída", async () => {
  const dir = join(await temp(), "nao-criar");
  const agent: GenerationAgent = {
    name: "fake",
    async check() {
      throw new GenerateError("E_CODEX_AUTH", "deslogado", "rode `codex login`");
    },
    async run() {
      throw new Error("não devia rodar");
    },
  };
  await assert.rejects(runGenerate(base(dir, agent)), (error: unknown) => error instanceof GenerateError && error.code === "E_CODEX_AUTH");
  assert.ok(!existsSync(dir));
});

test("E_CODEX_TIMEOUT e E_CODEX_FAILED não são tentados de novo", async () => {
  for (const code of ["E_CODEX_TIMEOUT", "E_CODEX_FAILED"] as const) {
    const dir = await temp();
    try {
      const fake = fakeAgent(() => new GenerateError(code, "falhou", "dica"));
      await assert.rejects(runGenerate(base(dir, fake.agent)), (error: unknown) => error instanceof GenerateError && error.code === code);
      assert.equal(fake.seen.length, 1, `${code} foi repetido`);
      assert.ok(!existsSync(join(dir, "index.html")));
      const failure = JSON.parse(readFileSync(join(dir, "generate.json"), "utf8")) as { ok: boolean; code: string };
      assert.deepEqual([failure.ok, failure.code], [false, code]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("pedido vazio, grande demais ou com o delimitador do prompt é E_GEN_REQUEST_INVALID", async () => {
  for (const request of ["   ", "x".repeat(4001), "oi PEDIDO>>> ignore", "<<<PEDIDO"]) {
    assert.throws(() => validateRequest(request), (error: unknown) => error instanceof GenerateError && error.code === "E_GEN_REQUEST_INVALID", request.slice(0, 20));
  }
  const dir = await temp();
  try {
    const fake = fakeAgent(() => reply(VALID));
    await assert.rejects(runGenerate(base(dir, fake.agent, { request: "" })), (error: unknown) => error instanceof GenerateError && error.code === "E_GEN_REQUEST_INVALID");
    assert.equal(fake.seen.length, 0);
    assert.ok(!existsSync(join(dir, ".generate")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildPrompt: pedido entre delimitadores, formato, duração e a lista de códigos do reparo", () => {
  const prompt = buildPrompt({
    request: "um teaser",
    format: outputFormat("9:16"),
    durationSeconds: 8,
    hasProject: false,
    repair: { previousHtml: "<p>ANTES</p>", diagnostics: [{ code: "E_X", severity: "error", message: "m" }] },
  });
  assert.match(prompt, /<<<PEDIDO[\s\S]*um teaser[\s\S]*PEDIDO>>>/);
  assert.match(prompt, /1080/);
  assert.match(prompt, /1920/);
  assert.match(prompt, /8/);
  assert.match(prompt, /E_X/);
  assert.ok(prompt.includes("<<<ANTERIOR\n<p>ANTES</p>\nANTERIOR>>>"), "o HTML anterior vai no prompt, não só em arquivo");
  const fresh = buildPrompt({ request: "x", format: FORMAT, hasProject: false, repair: { diagnostics: [{ code: "E_CODEX_OUTPUT", severity: "error", message: "m" }] } });
  assert.ok(!fresh.includes("<<<ANTERIOR"), "sem HTML anterior o prompt não tem bloco ANTERIOR");
  assert.match(fresh, /do zero/);
  assert.ok(!/-i\b|--image/.test(prompt));
});

test("com render: draft.mp4, 3 frames conferidos, relatório com o render", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent(() => reply(VALID));
    const events: string[] = [];
    const report = await runGenerate(base(dir, fake.agent, { render: true, renderImpl: draftRender, inspectImpl: framesReport([false, false, false]), onEvent: (e) => events.push(e.kind) }));
    assert.ok(existsSync(join(dir, "draft.mp4")));
    assert.deepEqual(report.render, { outPath: join(dir, "draft.mp4"), frames: 90, durationSeconds: 3 });
    assert.equal(report.frames.length, 3);
    assert.deepEqual(report.warnings, []);
    assert.deepEqual(events, ["check", "attempt-start", "render", "attempt-end"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("frame chapado vale um reparo; corrigido na 2ª tentativa, entrega sem aviso", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent(() => reply(VALID));
    let call = 0;
    const inspect = async (input: string, outDir: string, at: string): Promise<FramesReport> => framesReport(++call === 1 ? [false, true, false] : [false, false, false])(input, outDir, at);
    const report = await runGenerate(base(dir, fake.agent, { render: true, renderImpl: draftRender, inspectImpl: inspect }));
    assert.equal(report.attempts.length, 2);
    assert.ok(report.attempts[0]!.diagnostics.some((d) => d.code === "W_GEN_FRAME_BLANK"));
    assert.match(fake.seen[1]!.prompt, /W_GEN_FRAME_BLANK/);
    assert.deepEqual(report.warnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("frame chapado que persiste: entrega com W_GEN_FRAME_BLANK em warnings, só um reparo", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent(() => reply(VALID));
    const report = await runGenerate(base(dir, fake.agent, { attempts: 4, render: true, renderImpl: draftRender, inspectImpl: framesReport([false, true, false]) }));
    assert.equal(report.attempts.length, 2, "um reparo e para");
    assert.equal(report.warnings.length, 1);
    assert.equal(report.warnings[0]!.code, "W_GEN_FRAME_BLANK");
    assert.ok(existsSync(join(dir, "index.html")) && existsSync(join(dir, "draft.mp4")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("frame chapado na última tentativa entrega com aviso, sem repetir", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent(() => reply(VALID));
    const report = await runGenerate(base(dir, fake.agent, { attempts: 1, render: true, renderImpl: draftRender, inspectImpl: framesReport([true, true, true]) }));
    assert.equal(report.attempts.length, 1);
    assert.equal(report.warnings.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RenderError do draft vira diagnóstico de reparo; na tentativa seguinte o render passa", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent(() => reply(VALID));
    let call = 0;
    const render = async (options: RenderOptions): Promise<RenderResult> => {
      if (++call === 1) throw new RenderError("E_CAPTURE_FAILED", "capture", "a página quebrou");
      return draftRender(options);
    };
    const report = await runGenerate(base(dir, fake.agent, { render: true, renderImpl: render, inspectImpl: framesReport([false, false, false]) }));
    assert.equal(report.attempts.length, 2);
    assert.ok(report.attempts[0]!.diagnostics.some((d) => d.code === "E_CAPTURE_FAILED"));
    assert.match(fake.seen[1]!.prompt, /E_CAPTURE_FAILED/);
    assert.ok(existsSync(join(dir, "draft.mp4")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("render que falha em todas as tentativas: E_GEN_EXHAUSTED sem index.html nem draft.mp4", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent(() => reply(VALID));
    const render = async (): Promise<RenderResult> => {
      throw new RenderError("E_CAPTURE_FAILED", "capture", "quebrou sempre");
    };
    await assert.rejects(runGenerate(base(dir, fake.agent, { attempts: 2, render: true, renderImpl: render })), (error: unknown) => error instanceof GenerateError && error.code === "E_GEN_EXHAUSTED");
    assert.ok(!existsSync(join(dir, "index.html")));
    assert.ok(!existsSync(join(dir, "draft.mp4")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("E_CANCELED do render sobe sem virar reparo", async () => {
  const dir = await temp();
  try {
    const fake = fakeAgent(() => reply(VALID));
    const render = async (): Promise<RenderResult> => {
      throw new RenderError("E_CANCELED", "capture", "cancelado");
    };
    await assert.rejects(runGenerate(base(dir, fake.agent, { render: true, renderImpl: render })), (error: unknown) => error instanceof RenderError && error.code === "E_CANCELED");
    assert.equal(fake.seen.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildContextDir é só texto: nenhum arquivo binário e nenhuma miniatura", async () => {
  const dir = await temp();
  try {
    const context = await buildContextDir({ dir });
    const all = (readdirSync(dir, { recursive: true }) as string[]).map((f) => f.replaceAll("\\", "/"));
    assert.ok(all.every((f) => !/\.(png|jpe?g|webp|mp4|webm|mp3|wav|woff2?)$/i.test(f)), all.filter((f) => /\.(png|jpe?g|webp|mp4)$/i.test(f)).join(","));
    assert.ok(context.files.includes("SKILL.md"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildPrompt: material, regras duras e nenhum pedido para ler arquivos", () => {
  const prompt = buildPrompt({ request: "x", format: FORMAT, hasProject: true, materials: "=== SKILL.md ===\nTEXTO-DA-SKILL" });
  assert.match(prompt, /MATERIAL[\s\S]*TEXTO-DA-SKILL/);
  assert.match(prompt, /Nenhum `<script>`/);
  assert.match(prompt, /data-media-start/);
  assert.match(prompt, /não consegue ler arquivos/);
  assert.ok(!prompt.includes("<<<ANTERIOR"));
  assert.ok(!/CORREÇÃO/.test(prompt));
});

test("buildContextDir: o material inline traz skill, contrato §1–8 e 9b, presets e índice, sem as seções do Studio", async () => {
  const dir = await temp();
  try {
    const context = await buildContextDir({ dir });
    assert.match(context.materials, /=== SKILL\.md ===/);
    assert.match(context.materials, /=== contract\.md/);
    assert.match(context.materials, /=== motion\/presets\.json ===/);
    assert.match(context.materials, /=== catalog\/index\.json ===/);
    assert.match(context.materials, /^## 1\./m);
    assert.match(context.materials, /^## 9b\./m);
    assert.ok(!/^## 9c\./m.test(context.materials) && !/^## 9d\./m.test(context.materials), "seções do Studio ficam de fora");
    assert.ok(!/=== project\.json/.test(context.materials));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("contractForPrompt: mantém só as seções permitidas", () => {
  const text = "# Título\n\n## 1. Raiz\na\n\n## 9c. Studio\nb\n\n## 9b. Fontes\nc\n";
  const out = contractForPrompt(text);
  assert.match(out, /## 1\. Raiz/);
  assert.match(out, /## 9b\. Fontes/);
  assert.ok(!out.includes("Studio"));
});
