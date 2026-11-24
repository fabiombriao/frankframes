// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-88: o painel Blocos insere o bloco do catálogo de verdade, o Importar aceita `.html` como sub-composição e
// nada cai em "Texto" por engano.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";
import { resolveChrome } from "@frankframes/engine";
import { renderComposition, resolveFfmpeg } from "@frankframes/producer";
import { startStudio } from "../src/studio-server.ts";
import { withTempDir } from "../../../scripts/test-support/temp.ts";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BLOCK = "vertical-lower-third";

const ENTRY = `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#0b0b0f}</style></head><body>
<div data-composition-id="main" data-root="true" data-width="1080" data-height="1920" data-fps="10" data-duration="4"></div>
</body></html>
`;

const LEGENDAS = `<!doctype html>
<html><head><meta charset="utf-8"><style>.cap{position:absolute;left:0;right:0;bottom:200px;text-align:center;font-size:60px}</style></head>
<body><div data-composition-id="legendas" data-root="true" data-width="1080" data-height="1920" data-duration="2.5">
  <div class="cap" data-clip-id="cap-1" data-start="0" data-duration="2.5">Olá mundo</div>
</div></body></html>
`;

async function withStudio(task: (server: { url: string }, dir: string, entry: string) => Promise<void>): Promise<void> {
  await withTempDir("ff-studio-blocks-", async (dir) => {
    const entry = join(dir, "index.html");
    await writeFile(entry, ENTRY, "utf8");
    const server = await startStudio({ entry });
    try {
      await task(server, dir, entry);
    } finally {
      await server.close();
    }
  });
}

async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

async function upload(server: { url: string }, name: string, content: string, start: number): Promise<{ status: number; json: Record<string, any> }> {
  const response = await fetch(`${server.url}api/media?name=${encodeURIComponent(name)}&start=${start}`, { method: "POST", body: content });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

test("bloco do catálogo entra como sub-composição no playhead, com a duração do bloco (EDT-88)", () =>
  withStudio(async (server, dir, entry) => {
    const inserted = await post(`${server.url}api/blocks`, { slug: BLOCK, start: 1.5 });
    assert.equal(inserted.status, 200, JSON.stringify(inserted.json));
    const source = await readFile(entry, "utf8");
    assert.match(source, new RegExp(`data-clip-id="${String(inserted.json.id)}"[^>]*data-composition-src="blocks/${BLOCK}/index.html"`));
    assert.match(source, /data-start="1.5" data-duration="3.5"/, "início no playhead e duração do meta.json do bloco");
    assert.doesNotMatch(source, /Texto/, "bloco de catálogo nunca vira o texto genérico");

    // Mesma rotina do `blocks add`: o diretório do bloco inteiro foi copiado.
    const copied = await readFile(join(dir, "blocks", BLOCK, "index.html"), "utf8");
    assert.equal(copied, await readFile(join(ROOT, "catalog", "blocks", BLOCK, "index.html"), "utf8"));
    assert.ok((await readdir(join(dir, "blocks", BLOCK))).includes("meta.json"));

    // O servidor enxerga o clip e a duração derivada da janela do bloco.
    const composition = (await (await fetch(`${server.url}api/composition`)).json()) as { clips: Array<{ id: string; hasChildren: boolean }> };
    assert.equal(composition.clips.find((clip) => clip.id === inserted.json.id)?.hasChildren, true);

    // Desfazer remove o clip; os arquivos copiados ficam (documentado em docs/contract.md §9d).
    const undone = await post(`${server.url}api/undo`, {});
    assert.equal(undone.status, 200, JSON.stringify(undone.json));
    assert.equal(await readFile(entry, "utf8"), ENTRY);
    assert.ok((await stat(join(dir, "blocks", BLOCK, "index.html"))).isFile(), "arquivos copiados permanecem");

    // De novo: reaproveita a cópia sem sobrescrever.
    await writeFile(join(dir, "blocks", BLOCK, "index.html"), copied + "<!-- edição do autor -->", "utf8");
    const again = await post(`${server.url}api/blocks`, { slug: BLOCK, start: 0 });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.reused, true);
    assert.match(await readFile(join(dir, "blocks", BLOCK, "index.html"), "utf8"), /edição do autor/);
  }));

test("sem plano B: bloco desconhecido e template desconhecido falham com código e hint (EDT-88)", () =>
  withStudio(async (server, dir, entry) => {
    const unknown = await post(`${server.url}api/blocks`, { slug: "nao-existe", start: 0 });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.code, "E_BLOCK_UNKNOWN");
    assert.ok(unknown.json.diagnostics.some((item: { hint?: string }) => /blocks list/.test(item.hint ?? "")), "hint acionável");

    // O template genérico antigo ("title"/"subtitle") não existe mais; só "text" cria texto, e diz isso.
    for (const template of ["title", "subtitle", "qualquer"]) {
      const rejected = await post(`${server.url}api/clips`, { template, start: 0, duration: 1 });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.json.code, "E_TEMPLATE_INVALID");
      assert.ok(rejected.json.diagnostics.some((item: { hint?: string }) => /POST \/api\/blocks/.test(item.hint ?? "")));
    }
    assert.equal(await readFile(entry, "utf8"), ENTRY, "falha não toca no arquivo");
    await assert.rejects(stat(join(dir, "blocks")), /ENOENT/, "bloco desconhecido não copia nada");

    const text = await post(`${server.url}api/clips`, { template: "text", start: 0, duration: 1 });
    assert.equal(text.status, 200, JSON.stringify(text.json));
    assert.match(await readFile(entry, "utf8"), />Texto</, "o texto simples continua existindo, com nome próprio");
  }));

test("Importar .html: sub-composição com duração derivada; inválida falha com o código do contrato (EDT-88)", () =>
  withStudio(async (server, dir, entry) => {
    const ok = await upload(server, "legendas.html", LEGENDAS, 0.5);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.kind, "composition");
    assert.equal(ok.json.duration, 2.5, "duração vem da raiz do arquivo (§5)");
    assert.equal(ok.json.src, "compositions/legendas.html");
    const source = await readFile(entry, "utf8");
    assert.match(source, /data-composition-src="compositions\/legendas.html" data-start="0.5" data-duration="2.5"/);
    assert.equal(await readFile(join(dir, "compositions", "legendas.html"), "utf8"), LEGENDAS);

    // Sem raiz de composição: E_CONTRACT_INVALID carregando o código do contrato; nada fica no projeto.
    const bad = await upload(server, "solto.html", "<!doctype html><html><body><p>oi</p></body></html>", 0);
    assert.equal(bad.status, 400, JSON.stringify(bad.json));
    assert.equal(bad.json.code, "E_CONTRACT_INVALID");
    assert.ok(bad.json.diagnostics.some((item: { code?: string }) => item.code === "E_NO_ROOT"), JSON.stringify(bad.json.diagnostics));
    assert.equal(await readFile(entry, "utf8"), source, "arquivo de entrada intacto");
    assert.ok(!(await readdir(join(dir, "compositions"))).includes("solto.html"), "arquivo inválido descartado");

    // Id de clip repetido entre a entrada e a sub-composição é erro do contrato na árvore inteira.
    const clash = await upload(server, "outra.html", LEGENDAS.replace('data-composition-id="legendas"', 'data-composition-id="outra"'), 0);
    assert.equal(clash.status, 400, JSON.stringify(clash.json));
    assert.ok(clash.json.diagnostics.some((item: { code?: string }) => item.code === "E_DUPLICATE_ID"), JSON.stringify(clash.json.diagnostics));
    assert.equal(await readFile(entry, "utf8"), source);
    assert.ok(!(await readdir(join(dir, "compositions"))).includes("outra.html"));
  }));

test("pelo Studio no Chrome: bloco e .html entram, aparecem no preview e o desfazer remove o clip (EDT-88)", async (t) => {
  try {
    await resolveChrome();
  } catch (error) {
    t.skip(`Chrome indisponível: ${(error as Error).message}`);
    return;
  }
  await withStudio(async (server, dir, entry) => {
    const chrome = await resolveChrome();
    const browser = await puppeteer.launch({ executablePath: chrome.path, headless: true, args: ["--no-sandbox"], defaultViewport: { width: 1600, height: 900 } });
    try {
      const page = await browser.newPage();
      await page.goto(server.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelectorAll(".block-button").length > 10, { timeout: 15_000 });

      const inPlayer = (selector: string): Promise<string | null> =>
        page.evaluate((query) => {
          const doc = (document.getElementById("player") as HTMLIFrameElement).contentDocument;
          return doc?.querySelector(query)?.textContent ?? null;
        }, selector);

      // 1) Clique no bloco do catálogo.
      await page.evaluate((slug) => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".block-button"));
        const target = buttons.find((button) => (button.getAttribute("aria-label") ?? "").includes("Crédito vertical"));
        if (target === undefined) throw new Error("bloco Crédito vertical ausente do painel: " + slug);
        target.click();
      }, BLOCK);
      await page.waitForFunction(
        () => (document.getElementById("blocksDiagnostics")?.textContent ?? "").includes("inserido"),
        { timeout: 20_000 },
      );
      assert.match(await readFile(entry, "utf8"), new RegExp(`data-composition-src="blocks/${BLOCK}/index.html"`));
      await page.waitForFunction(
        () => (document.getElementById("player") as HTMLIFrameElement).contentDocument?.querySelector('[data-clip-id="name"]') !== null,
        { timeout: 20_000 },
      );
      assert.match((await inPlayer('[data-clip-id="name"]')) ?? "", /Helena/, "o conteúdo do bloco está no preview");

      // 2) Desfazer remove o clip.
      await page.click("#undoButton");
      await page.waitForFunction(async () => !(await (await fetch("/api/composition")).text()).includes("hasChildren\":true"), { timeout: 15_000 });
      assert.doesNotMatch(await readFile(entry, "utf8"), /data-composition-src/);

      // 3) Importar .html local.
      const legendas = join(dir, "legendas.html");
      await writeFile(legendas, LEGENDAS, "utf8");
      const input = await page.$("#importInput");
      assert.ok(input, "o botão Importar tem o input de arquivo");
      assert.match(await page.$eval("#importInput", (el) => el.getAttribute("accept") ?? ""), /\.html/, "Importar aceita .html");
      await (input as unknown as { uploadFile: (...paths: string[]) => Promise<void> }).uploadFile(legendas);
      await page.waitForFunction(
        () => (document.getElementById("player") as HTMLIFrameElement).contentDocument?.querySelector('[data-clip-id="cap-1"]') !== null,
        { timeout: 30_000 },
      );
      assert.match((await inPlayer('[data-clip-id="cap-1"]')) ?? "", /Olá mundo/);
      assert.match(await readFile(entry, "utf8"), /data-composition-src="compositions\/legendas.html"/);
    } finally {
      await browser.close();
    }
  });
});

test("o render mostra o bloco inserido pelo Studio: faixa amarela só dentro da janela do bloco (EDT-88)", { timeout: 600_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch (error) {
    t.skip(`Chrome indisponível: ${(error as Error).message}`);
    return;
  }
  let pair: Awaited<ReturnType<typeof resolveFfmpeg>>;
  try {
    pair = await resolveFfmpeg();
  } catch (error) {
    t.skip(`ffmpeg indisponível: ${(error as Error).message}`);
    return;
  }
  await withStudio(async (server, dir, entry) => {
    const inserted = await post(`${server.url}api/blocks`, { slug: BLOCK, start: 1 });
    assert.equal(inserted.status, 200, JSON.stringify(inserted.json));
    const out = join(dir, "bloco.mp4");
    const result = await renderComposition({ entry, outPath: out, ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe, codec: "av1", preset: "draft", workers: 2 });
    assert.equal(result.frames, 40, "4 s a 10 fps");

    // Pixel (500,1300) fica dentro da faixa `.band` do bloco (#f2e34c) quando ela terminou de crescer.
    const pixel = async (seconds: number): Promise<[number, number, number]> => {
      const { stdout } = await run(
        pair.ffmpeg,
        ["-hide_banner", "-loglevel", "error", "-ss", String(seconds), "-i", out, "-frames:v", "1", "-vf", "crop=4:4:500:1300", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        { encoding: "buffer", maxBuffer: 1024 },
      );
      const bytes = stdout as unknown as Buffer;
      return [bytes[0]!, bytes[1]!, bytes[2]!];
    };
    const near = (actual: number[], expected: number[]): boolean => actual.every((value, index) => Math.abs(value - expected[index]!) <= 40);
    assert.ok(!near(await pixel(0.5), [242, 227, 76]), "antes do bloco não há faixa amarela");
    const inside = await pixel(2.5);
    assert.ok(near(inside, [242, 227, 76]), `dentro da janela a faixa amarela do bloco aparece: ${inside.join(",")}`);
  });
});
