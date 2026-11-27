// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { assetPath, resolveChrome } from "@frankframes/engine";
import puppeteer from "puppeteer-core";
import type { FaceSample } from "./face-tracks.ts";

const MODEL = "blaze_face_full_range.tflite";
const MODEL_URL = "https://huggingface.co/litert-community/MediaPipe-FaceDetector-BlazeFace-Full-Range/resolve/6bc74b6a14695b84caafcfb763b14ee633f02f60/" + MODEL;
const MODEL_SHA256 = "3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b";
const hash = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
type FaceApi = Pick<typeof import("@mediapipe/tasks-vision"), "FaceDetector" | "FilesetResolver">;

const ANALYSIS_HTML = `<!doctype html><title>FrankFrames</title>
<script type="module">
import { FaceDetector, FilesetResolver } from "/vision.mjs";
globalThis.__ffFaceApi = { FaceDetector, FilesetResolver };
</script>`;

async function loadModel(): Promise<Buffer> {
  const file = assetPath("models", "face", MODEL);
  try {
    const data = await readFile(file);
    if (hash(data) === MODEL_SHA256) return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const response = await fetch(MODEL_URL, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error("modelo BlazeFace: HTTP " + response.status);
  const data = Buffer.from(await response.arrayBuffer());
  if (hash(data) !== MODEL_SHA256) throw new Error("SHA-256 do modelo BlazeFace não confere");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  return data;
}

async function serveAnalysis(input: string, model: Buffer) {
  const module = createRequire(import.meta.url).resolve("@mediapipe/tasks-vision");
  const base = dirname(module);
  const wasm = join(base, "wasm");
  const routes = new Map((await readdir(wasm)).map((name) => ["/wasm/" + name, join(wasm, name)]));
  routes.set("/vision.mjs", join(base, "vision_bundle.mjs"));
  routes.set("/video", input);
  const files = new Map(await Promise.all([...routes].map(async ([key, path]) => [key, {
    path,
    size: (await stat(path)).size,
    mime: key === "/video" ? (extname(path).toLowerCase() === ".webm" ? "video/webm" : "video/mp4")
      : path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
  }] as const)));
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(ANALYSIS_HTML);
      return;
    }
    if (request.url === "/model") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" }).end(model);
      return;
    }
    const file = files.get(request.url ?? "");
    if (file === undefined) { response.writeHead(404).end(); return; }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    const start = range === null ? 0 : Number(range[1]);
    const end = range === null || !range[2] ? file.size - 1 : Math.min(file.size - 1, Number(range[2]));
    if (start > end || (request.headers.range !== undefined && range === null)) {
      response.writeHead(416, { "Content-Range": "bytes */" + file.size }).end();
      return;
    }
    response.writeHead(range === null ? 200 : 206, {
      "Content-Type": file.mime, "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
      ...(range === null ? {} : { "Content-Range": "bytes " + start + "-" + end + "/" + file.size }),
    });
    if (request.method === "HEAD") { response.end(); return; }
    const stream = createReadStream(file.path, { start, end });
    response.on("close", () => stream.destroy());
    stream.on("error", (error) => response.destroy(error));
    stream.pipe(response);
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("servidor de análise sem porta");
  return {
    url: "http://127.0.0.1:" + address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((accept, reject) => server.close((error) => error == null ? accept() : reject(error)));
    },
  };
}

export interface FaceAnalysis {
  aspect: number;
  duration: number;
  adapter: string;
  samples: FaceSample[];
}

export async function analyzeFaces(input: string, start: number, requestedDuration?: number): Promise<FaceAnalysis> {
  const chrome = await resolveChrome();
  const server = await serveAnalysis(input, await loadModel());
  try {
    const browser = await puppeteer.launch({
      executablePath: chrome.path, headless: "shell",
      args: ["--disable-software-rasterizer", "--disable-background-networking",
        ...(process.platform === "win32" ? ["--use-angle=d3d11"] : ["--enable-gpu"])],
    });
    try {
      const page = await browser.newPage();
      await page.goto(server.url);
      return await page.evaluate(async (start, requestedDuration) => {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2");
        const debug = gl?.getExtension("WEBGL_debug_renderer_info");
        const adapter = debug === null || debug === undefined ? "" : String(gl?.getParameter(debug.UNMASKED_RENDERER_WEBGL));
        if (!adapter || /swiftshader|llvmpipe|software|basic render/i.test(adapter)) {
          throw new Error("rastreio precisa de WebGL2 com GPU de hardware");
        }
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
        const video = document.createElement("video");
        video.preload = "auto";
        video.muted = true;
        const wait = (event: string): Promise<void> => new Promise((accept, reject) => {
          const finish = (error?: Error) => {
            clearTimeout(timeout);
            video.removeEventListener(event, success);
            video.removeEventListener("error", failure);
            if (error === undefined) accept();
            else reject(error);
          };
          const success = () => finish();
          const failure = () => finish(new Error("o navegador não abriu o vídeo: " + (video.error?.message || "formato incompatível")));
          const timeout = setTimeout(() => finish(new Error("tempo esgotado ao ler o vídeo")), 20_000);
          video.addEventListener(event, success, { once: true });
          video.addEventListener("error", failure, { once: true });
        });
        const loaded = wait("loadeddata");
        video.src = "/video";
        await loaded;
        if (!Number.isFinite(video.duration) || start >= video.duration || video.videoWidth <= video.videoHeight) {
          throw new Error("use uma gravação horizontal e um início dentro do vídeo");
        }
        const available = video.duration - start;
        if (requestedDuration !== undefined && requestedDuration > available + 0.001) throw new Error("o trecho ultrapassa o fim do vídeo");
        const duration = Math.floor(Math.min(available, requestedDuration ?? available) * 1000) / 1000;
        if (duration <= 0) throw new Error("o trecho precisa durar pelo menos 1 ms");
        const api = (globalThis as typeof globalThis & { __ffFaceApi?: FaceApi }).__ffFaceApi;
        if (api === undefined) throw new Error("não foi possível carregar o módulo local de detecção");
        const { FaceDetector, FilesetResolver } = api;
        const detector = await FaceDetector.createFromOptions(await FilesetResolver.forVisionTasks("/wasm"), {
          baseOptions: { delegate: "GPU", modelAssetPath: "/model" },
          runningMode: "VIDEO", minDetectionConfidence: 0.45, minSuppressionThreshold: 0.3,
        });
        try {
          const samples: FaceSample[] = [];
          for (let index = 0; index * 0.25 < duration; index++) {
            const time = index * 0.25;
            if (Math.abs(video.currentTime - (start + time)) > 0.0001) {
              const sought = wait("seeked");
              video.currentTime = start + time;
              await sought;
            }
            const detections = detector.detectForVideo(video, index * 250).detections;
            const faces = detections.flatMap(({ boundingBox: box, categories }) => box === undefined ? [] : [{
              x: box.originX / video.videoWidth, y: box.originY / video.videoHeight,
              width: box.width / video.videoWidth, height: box.height / video.videoHeight,
              score: categories[0]?.score ?? 0,
            }]);
            samples.push({ time, faces });
          }
          return { duration, aspect: video.videoWidth / video.videoHeight, adapter, samples };
        } finally {
          detector.close();
        }
      }, start, requestedDuration);
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}
