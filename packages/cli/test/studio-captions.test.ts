// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-97: editar no Studio o texto das legendas geradas por `frankframes captions` (API e interface no Chrome).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { resolveChrome } from "@frankframes/engine";
import { buildCaptionComposition, readCaptionFile } from "@frankframes/producer";
import { startStudio } from "../src/studio-server.ts";
import { withTempDir } from "../../../scripts/test-support/temp.ts";

/** Segmento com as palavras repartidas por igual, sem pausa que o divida. */
const segment = (start: number, text: string): { start: number; end: number; text: string; words: Array<{ start: number; end: number; word: string }> } => {
  const words = text.split(" ");
  const at = (i: number): number => start + (i * 1.5) / words.length;
  return { start, end: start + 1.5, text, words: words.map((word, i) => ({ word, start: at(i), end: at(i + 1) })) };
};

const CAPTIONS = buildCaptionComposition(
  [segment(0, "essa é a legneda"), segment(1.5, "agora vem outra"), segment(3, "fim do vídeo")],
  { width: 1080, height: 1920, fps: 10 },
);

const PLAIN = `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<div data-composition-id="outro" data-root="true" data-width="1080" data-height="1920" data-duration="2">
  <div data-clip-id="solto" data-start="0" data-duration="2">sem meta</div>
</div></body></html>
`;

const entryHtml = (titleId = "titulo", src = "compositions/legendas.html"): string => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#223}</style></head><body>
<div data-composition-id="main" data-root="true" data-width="1080" data-height="1920" data-fps="10" data-duration="6" style="position:relative;width:1080px;height:1920px">
  <div data-clip-id="legendas" data-composition-id="legendas" data-composition-src="${src}" data-start="0.5" data-duration="4.5" data-track="1" style="position:absolute;inset:0;overflow:hidden"></div>
  <div data-clip-id="outro" data-composition-id="outro" data-composition-src="compositions/outro.html" data-start="0" data-duration="2" data-track="2" style="position:absolute;inset:0"></div>
  <div data-clip-id="${titleId}" data-start="0" data-duration="2" data-track="3" style="position:absolute;top:100px">Título</div>
</div>
</body></html>
`;

interface Studio {
  url: string;
  entry: string;
  captions: string;
}

async function withStudio(task: (studio: Studio, dir: string) => Promise<void>, entrySource = entryHtml()): Promise<void> {
  await withTempDir("ff-studio-captions-", async (dir) => {
    const project = join(dir, "projeto");
    await mkdir(join(project, "compositions"), { recursive: true });
    const entry = join(project, "index.html");
    const captions = join(project, "compositions", "legendas.html");
    await writeFile(entry, entrySource, "utf8");
    await writeFile(captions, CAPTIONS, "utf8");
    await writeFile(join(project, "compositions", "outro.html"), PLAIN, "utf8");
    const server = await startStudio({ entry });
    try {
      await task({ url: server.url, entry, captions }, dir);
    } finally {
      await server.close();
    }
  });
}

type Reply = { status: number; json: Record<string, any> };

async function get(url: string): Promise<Reply> {
  const response = await fetch(url);
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

async function send(url: string, body: unknown): Promise<Reply> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

const editCue = (studio: Studio, host: string, cue: string, text: unknown): Promise<Reply> =>
  send(`${studio.url}api/captions/${host}/${cue}`, { text });

const preview = async (studio: Studio): Promise<string> => (await fetch(`${studio.url}preview`)).text();

const textsOf = async (file: string): Promise<string[]> => readCaptionFile(await readFile(file, "utf8")).cues.map((cue) => cue.text);

function refused(reply: Reply, status: number, code: string): void {
  assert.equal(reply.status, status, JSON.stringify(reply.json));
  assert.equal(reply.json.code, code, JSON.stringify(reply.json));
  assert.ok(
    reply.json.diagnostics.some((item: { code?: string; hint?: string }) => item.code === code && (item.hint ?? "") !== ""),
    `${code} sem hint: ${JSON.stringify(reply.json)}`,
  );
}

/** Espera o próximo `data: change` de `/api/events`, disparado por `action`. */
async function changeAfter<T>(studio: Studio, action: () => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("sem evento de mudança em 5 s")), 5_000);
  try {
    const response = await fetch(`${studio.url}api/events`, { signal: abort.signal });
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    const result = await action();
    let seen = "";
    while (!seen.includes("data: change")) {
      const { value, done } = await reader.read();
      assert.equal(done, false, "o canal de eventos fechou");
      seen += value;
    }
    return result;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

test("API: a composição marca o host de legendas e GET devolve as legendas com tempos locais (EDT-97)", () =>
  withStudio(async (studio) => {
    const composition = await get(`${studio.url}api/composition`);
    const flags = Object.fromEntries(composition.json.clips.map((clip: { id: string; captions: boolean }) => [clip.id, clip.captions]));
    assert.equal(flags["legendas"], true);
    assert.equal(flags["outro"], false, "sub-composição sem a meta não é legenda");
    assert.equal(flags["titulo"], false);

    const listed = await get(`${studio.url}api/captions/legendas`);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    assert.equal(listed.json.src, "compositions/legendas.html");
    assert.deepEqual(
      listed.json.cues.map((cue: { id: string; start: number; end: number; text: string }) => [cue.id, cue.start, cue.end, cue.text]),
      [["cap-0", 0, 1.5, "essa é a legneda"], ["cap-1", 1.5, 3, "agora vem outra"], ["cap-2", 3, 4.5, "fim do vídeo"]],
    );
    assert.equal(listed.json.cues[0].words.length, 4);
  }));

test("API: POST grava só o arquivo das legendas, registra no histórico e recarrega o preview (EDT-97)", () =>
  withStudio(async (studio) => {
    const entryBefore = await readFile(studio.entry, "utf8");
    // O preview fica em cache pelo mtime da entrada, que a edição da legenda não muda.
    assert.match(await preview(studio), />legneda</);

    const edited = await changeAfter(studio, () => editCue(studio, "legendas", "cap-0", "essa é a legenda"));
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.deepEqual(
      { ok: edited.json.ok, id: edited.json.id, changed: edited.json.changed, duration: edited.json.duration },
      { ok: true, id: "cap-0", changed: true, duration: 6 },
    );
    assert.deepEqual(edited.json.history, { canUndo: true, canRedo: false, undo: "editar legenda cap-0", redo: null });
    assert.equal(await readFile(studio.captions, "utf8"), CAPTIONS.replace(">legneda<", ">legenda<"));
    assert.equal(await readFile(studio.entry, "utf8"), entryBefore, "a entrada não muda");
    const after = await preview(studio);
    assert.match(after, />legenda</);
    assert.doesNotMatch(after, />legneda</);

    // Mesmo texto: não grava nem cria passo.
    const same = await editCue(studio, "legendas", "cap-0", "essa é a legenda");
    assert.equal(same.json.changed, false);
    const undone = await changeAfter(studio, () => send(`${studio.url}api/undo`, {}));
    assert.equal(undone.status, 200, JSON.stringify(undone.json));
    assert.equal(undone.json.history.canUndo, false, "a reaplicação não criou passo");
    assert.equal(await readFile(studio.captions, "utf8"), CAPTIONS);
    assert.match(await preview(studio), />legneda</, "o desfazer também recarrega o preview");
  }));

test("API: desfazer e refazer restauram o arquivo certo, entre a entrada e as legendas (EDT-97)", () =>
  withStudio(async (studio) => {
    const entry0 = await readFile(studio.entry, "utf8");
    const moved = await send(`${studio.url}api/clips/titulo`, { attributes: { "data-start": "1" } });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    const entry1 = await readFile(studio.entry, "utf8");
    assert.notEqual(entry1, entry0);
    const edited = await editCue(studio, "legendas", "cap-1", "agora vem mais uma frase");
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    const captions1 = await readFile(studio.captions, "utf8");
    assert.deepEqual(await textsOf(studio.captions), ["essa é a legneda", "agora vem mais uma frase", "fim do vídeo"]);

    const step = async (direction: "undo" | "redo", entry: string, captions: string): Promise<void> => {
      const reply = await send(`${studio.url}api/${direction}`, {});
      assert.equal(reply.status, 200, JSON.stringify(reply.json));
      assert.equal(reply.json.duration, 6, "a duração é sempre a da entrada");
      assert.equal(await readFile(studio.entry, "utf8"), entry, `${direction}: entrada`);
      assert.equal(await readFile(studio.captions, "utf8"), captions, `${direction}: legendas`);
    };
    await step("undo", entry1, CAPTIONS);
    await step("undo", entry0, CAPTIONS);
    await step("redo", entry1, CAPTIONS);
    await step("redo", entry1, captions1);
  }));

test("API: legendas mudadas ou apagadas fora do Studio barram o desfazer (E_HISTORY_STALE) (EDT-97)", () =>
  withStudio(async (studio) => {
    assert.equal((await editCue(studio, "legendas", "cap-0", "essa é a legenda")).status, 200);
    const outside = (await readFile(studio.captions, "utf8")).replace("</title>", " mexido por fora</title>");
    await writeFile(studio.captions, outside, "utf8");
    const stale = await send(`${studio.url}api/undo`, {});
    assert.equal(stale.status, 409, JSON.stringify(stale.json));
    assert.equal(stale.json.code, "E_HISTORY_STALE");
    assert.equal(await readFile(studio.captions, "utf8"), outside, "a edição de fora fica");
    assert.equal((await get(`${studio.url}api/history`)).json.canUndo, false);

    assert.equal((await editCue(studio, "legendas", "cap-0", "essa é a frase")).status, 200);
    await rm(studio.captions);
    const gone = await send(`${studio.url}api/undo`, {});
    assert.equal(gone.status, 409, JSON.stringify(gone.json));
    assert.equal(gone.json.code, "E_HISTORY_STALE");
  }));

test("API: host que não é legenda, legenda inexistente, texto vazio e arquivo legado falham com código e hint (EDT-97)", () =>
  withStudio(async (studio) => {
    refused(await get(`${studio.url}api/captions/nao-existe`), 404, "E_CLIP_NOT_FOUND");
    refused(await editCue(studio, "nao-existe", "cap-0", "x"), 404, "E_CLIP_NOT_FOUND");
    refused(await get(`${studio.url}api/captions/titulo`), 400, "E_CAPTIONS_HOST");
    refused(await editCue(studio, "titulo", "cap-0", "x"), 400, "E_CAPTIONS_HOST");
    refused(await get(`${studio.url}api/captions/outro`), 400, "E_CAPTIONS_LEGACY");
    refused(await editCue(studio, "outro", "solto", "x"), 400, "E_CAPTIONS_LEGACY");
    refused(await editCue(studio, "legendas", "cap-9", "x"), 404, "E_CAPTIONS_CUE_NOT_FOUND");
    refused(await editCue(studio, "legendas", "cap-0", "   "), 400, "E_ATTRIBUTE_INVALID");
    refused(await editCue(studio, "legendas", "cap-0", 7), 400, "E_BODY_INVALID");
    refused(await send(`${studio.url}api/captions/legendas/cap-0`, {}), 400, "E_BODY_INVALID");

    assert.equal(await readFile(studio.captions, "utf8"), CAPTIONS);
    assert.equal(await readFile(join(studio.entry, "..", "compositions", "outro.html"), "utf8"), PLAIN);
    assert.equal((await get(`${studio.url}api/history`)).json.canUndo, false);
  }));

test("API: data-composition-src fora da pasta da composição não é lido nem gravado (EDT-97)", () =>
  withStudio(async (studio, dir) => {
    const outside = join(dir, "fora.html");
    await writeFile(outside, CAPTIONS, "utf8");
    const composition = await get(`${studio.url}api/composition`);
    assert.equal(composition.json.clips.find((clip: { id: string }) => clip.id === "legendas").captions, false);
    refused(await get(`${studio.url}api/captions/legendas`), 400, "E_CAPTIONS_HOST");
    refused(await editCue(studio, "legendas", "cap-0", "invadido"), 400, "E_CAPTIONS_HOST");
    assert.equal(await readFile(outside, "utf8"), CAPTIONS);
  }, entryHtml("titulo", "../fora.html")));

test("API: contrato inválido na árvore não grava (E_CONTRACT_INVALID) (EDT-97)", () =>
  // `cap-1` na entrada colide com a legenda: só a validação da árvore inteira vê.
  withStudio(async (studio) => {
    const reply = await editCue(studio, "legendas", "cap-0", "essa é a legenda");
    assert.equal(reply.status, 400, JSON.stringify(reply.json));
    assert.equal(reply.json.code, "E_CONTRACT_INVALID");
    assert.ok(reply.json.diagnostics.some((item: { code?: string }) => item.code === "E_DUPLICATE_ID"), JSON.stringify(reply.json));
    assert.equal(await readFile(studio.captions, "utf8"), CAPTIONS);
    assert.equal((await get(`${studio.url}api/history`)).json.canUndo, false);
  }, entryHtml("cap-1")));

test("API: o que se valida é o arquivo como vai ficar, não o que está no disco (EDT-97)", () =>
  // Um atributo inválido posto à mão numa legenda some quando ela é redesenhada: só validando o texto novo passa.
  withStudio(async (studio) => {
    const broken = CAPTIONS.replace('data-clip-id="cap-0"', 'data-clip-id="cap-0" data-volume="abc"');
    await writeFile(studio.captions, broken, "utf8");
    const other = await editCue(studio, "legendas", "cap-1", "agora vem a outra");
    assert.equal(other.status, 400, JSON.stringify(other.json));
    assert.equal(other.json.code, "E_CONTRACT_INVALID");
    assert.equal(await readFile(studio.captions, "utf8"), broken);

    const fixed = await editCue(studio, "legendas", "cap-0", "essa é a legenda");
    assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
    assert.equal(await readFile(studio.captions, "utf8"), CAPTIONS.replace(">legneda<", ">legenda<"));
  }));

test("pelo Studio no Chrome: corrigir uma letra, ver no preview, desfazer; trocar palavras e navegar pela lista (EDT-97)", { timeout: 180_000 }, async (t) => {
  try {
    await resolveChrome();
  } catch (error) {
    t.skip(`Chrome indisponível: ${(error as Error).message}`);
    return;
  }
  await withStudio(async (studio) => {
    const chrome = await resolveChrome();
    const browser = await puppeteer.launch({ executablePath: chrome.path, headless: true, args: ["--no-sandbox"], defaultViewport: { width: 1600, height: 900 } });
    try {
      const page = await browser.newPage();
      await page.goto(studio.url, { waitUntil: "domcontentloaded" });

      const row = (cue: string): string => `#captionsList li[data-cue-id="${cue}"]`;
      const inPreview = (cue: string, expected: string): Promise<unknown> =>
        page.waitForFunction(
          (id, text) => {
            const doc = (document.getElementById("player") as HTMLIFrameElement).contentDocument;
            return doc?.querySelector(`[data-clip-id="${id}"]`)?.textContent === text;
          },
          { timeout: 20_000 },
          cue,
          expected,
        );
      const inputValue = (cue: string): Promise<string> => page.$eval(`${row(cue)} input`, (el) => (el as HTMLInputElement).value);
      const retype = async (cue: string, text: string): Promise<void> => {
        await page.click(`${row(cue)} input`, { count: 3 });
        await page.keyboard.type(text);
      };
      const disabled = (selector: string): Promise<boolean> => page.$eval(selector, (el) => (el as HTMLButtonElement).disabled);

      await inPreview("cap-0", "essa é a legneda");
      // Outro host: sem a seção.
      await page.click('.clip-bar[data-clip-id="titulo"]');
      assert.equal(await page.$eval("#captionsSection", (el) => (el as HTMLElement).hidden), true);

      await page.click('.clip-bar[data-clip-id="legendas"]');
      await page.waitForSelector(row("cap-2"), { timeout: 15_000 });
      assert.deepEqual(
        await page.$$eval("#captionsList .caption-time", (els) => els.map((el) => el.textContent)),
        ["0.5s – 2s", "2s – 3.5s", "3.5s – 5s"],
        "tempos da timeline: início do host mais o da legenda",
      );

      // 1) Corrigir uma letra e aplicar com Enter.
      await page.waitForFunction(() => !(document.getElementById("exportButton") as HTMLButtonElement).disabled, { timeout: 15_000 });
      await retype("cap-0", "essa é a legenda");
      assert.equal(await disabled("#exportButton"), true, "texto não aplicado segura o Exportar");
      await page.keyboard.press("Enter");
      await inPreview("cap-0", "essa é a legenda");
      assert.match(await readFile(studio.captions, "utf8"), />legenda<\/span>/);
      await page.waitForFunction(() => !(document.getElementById("exportButton") as HTMLButtonElement).disabled, { timeout: 15_000 });
      assert.equal(await inputValue("cap-0"), "essa é a legenda");

      // 2) Desfazer volta o arquivo, o preview e o campo.
      await page.click("#undoButton");
      await inPreview("cap-0", "essa é a legneda");
      await page.waitForFunction(
        (selector) => (document.querySelector(selector) as HTMLInputElement | null)?.value === "essa é a legneda",
        { timeout: 15_000 },
        `${row("cap-0")} input`,
      );
      assert.equal(await readFile(studio.captions, "utf8"), CAPTIONS);

      // 3) Mudar a quantidade de palavras, pelo botão da linha.
      await retype("cap-1", "agora vem mais uma frase");
      await page.click(`${row("cap-1")} .caption-apply`);
      await inPreview("cap-1", "agora vem mais uma frase");
      assert.equal(readCaptionFile(await readFile(studio.captions, "utf8")).cues[1]!.words!.length, 5);

      // 4) Recusa aparece na linha, com código e hint, e o arquivo fica como estava.
      const saved = await readFile(studio.captions, "utf8");
      await retype("cap-2", "   ");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (selector) => (document.querySelector(selector)?.textContent ?? "").includes("E_ATTRIBUTE_INVALID"),
        { timeout: 15_000 },
        `${row("cap-2")} .diagnostics`,
      );
      assert.match(await page.$eval(`${row("cap-2")} .diagnostics`, (el) => el.textContent ?? ""), /escreva o texto da legenda/);
      assert.equal(await readFile(studio.captions, "utf8"), saved);
      await retype("cap-2", "fim do vídeo");

      // 5) O tempo leva o playhead ao início da legenda, e a linha sob o playhead fica marcada.
      const currentRow = (): Promise<string[]> =>
        page.$$eval("#captionsList li.is-current", (els) => els.map((el) => (el as HTMLElement).dataset["cueId"] ?? ""));
      for (const [cue, ms] of [["cap-2", 3500], ["cap-1", 2000], ["cap-0", 500]] as const) {
        await page.click(`${row(cue)} .caption-time`);
        await page.waitForFunction(
          (id) => document.querySelector("#captionsList li.is-current")?.getAttribute("data-cue-id") === id,
          { timeout: 15_000 },
          cue,
        );
        const now = await page.evaluate(() => {
          const view = (document.getElementById("player") as HTMLIFrameElement).contentWindow as unknown as { __ff: { now(): number; playing(): boolean } };
          return { now: view.__ff.now(), playing: view.__ff.playing() };
        });
        assert.deepEqual(now, { now: ms, playing: false }, cue);
        assert.deepEqual(await currentRow(), [cue]);
      }

      // 6) Tela de celular: campo e botões grandes, sem estourar a largura do painel.
      await page.setViewport({ width: 375, height: 812 });
      const sizes = await page.evaluate(() => {
        const section = document.getElementById("captionsSection")!;
        const list = document.getElementById("captionsList")!;
        return {
          heights: Array.from(list.querySelector("li")!.querySelectorAll("button, input"), (el) => el.getBoundingClientRect().height),
          font: parseFloat(getComputedStyle(list.querySelector("input")!).fontSize),
          scroll: getComputedStyle(list).overflowY,
          overflow: section.scrollWidth - section.clientWidth,
        };
      });
      assert.ok(sizes.heights.length === 3 && sizes.heights.every((height) => height >= 44), JSON.stringify(sizes));
      assert.ok(sizes.font >= 16, "abaixo de 16px o celular dá zoom ao focar");
      assert.equal(sizes.scroll, "auto");
      assert.ok(sizes.overflow <= 0, JSON.stringify(sizes));
    } finally {
      await browser.close();
    }
  });
});
