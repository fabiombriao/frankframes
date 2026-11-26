// FrankFrames — proprietário. Ver LICENSE na raiz.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { startServer } from "../../packages/engine/src/index.ts";
import { layeredPage } from "../../packages/producer/src/compile.ts";
import { inspectFrame } from "../../packages/producer/src/layered-capture.ts";
import { prepare } from "../../packages/producer/src/render.ts";

const [binary, entry, frameLimit] = process.argv.slice(2);
if (process.platform !== "win32" || binary === undefined || entry === undefined || process.argv.length > 5) {
  console.error("uso (Windows): node scripts/cef-probe/run.mjs <ff-cef-probe.exe> <entrada.html> [frames]");
  process.exit(2);
}

const composition = await prepare({ entry, layered: true });
const frames = frameLimit === undefined ? composition.totalFrames : Number(frameLimit);
if (!Number.isInteger(frames) || frames < 1 || frames > Math.min(composition.totalFrames, 16_384)) {
  console.error("O número de frames deve caber na duração da composição e no contador de 14 bits da sonda.");
  process.exit(2);
}

const { compiledHtml, entryDir, fps, layeredSources, viewport } = composition;
const page = layeredPage(compiledHtml);
const inspect = `<script>window.__ffCefProbeInspect = () => (${inspectFrame.toString()})(${!page.scripted});</script>`;
const html = page.html.replace("</head>", () => inspect + "</head>");
const wrapperName = "__ff_cef_probe.html";
const wrapperPath = resolve(entryDir, wrapperName);
const wrapper = Buffer.from(`<!doctype html><meta charset="utf-8"><title>FrankFrames CEF</title>
<style>html,body{margin:0;overflow:hidden;background:transparent}iframe{display:block;border:0}</style>
<iframe id="composition" src="/index.html" width="${viewport.width}" height="${viewport.height}"></iframe>`);
const server = await startServer(entryDir, {
  page: { path: "index.html", html },
  manifest: { layered: true, fps, clips: layeredSources.map(({ timing }) => timing) },
  readFile: (path) => path === wrapperPath ? Promise.resolve(wrapper) : readFile(path),
});
try {
  const executable = resolve(binary);
  const url = new URL(wrapperName, server.url).href;
  const args = [url, viewport.width, viewport.height, frames, fps.num, fps.den].map(String);
  const child = spawn(executable, args, { cwd: dirname(executable), windowsHide: true, stdio: "inherit" });
  process.exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => {
      if (code === null) rejectExit(new Error(`A sonda CEF terminou com o sinal ${signal}.`));
      else resolveExit(code);
    });
  });
} finally {
  await server.close();
}
