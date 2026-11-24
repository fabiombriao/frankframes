// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { ffmpegBuildFor } from "@frankframes/encode";
import type { FfmpegBuild } from "@frankframes/encode";
import { ensureFfmpeg, ensureFonts } from "../src/setup.ts";
import { withTempDir } from "../../../scripts/test-support/temp.ts";

const exec = promisify(execFile);

function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  return withTempDir("ff-home-", async (home) => {
    const previous = process.env.FRANKFRAMES_HOME;
    process.env.FRANKFRAMES_HOME = home;
    try {
      return await run(home);
    } finally {
      if (previous === undefined) delete process.env.FRANKFRAMES_HOME;
      else process.env.FRANKFRAMES_HOME = previous;
    }
  });
}

test("ffmpeg com digest diferente do manifesto é detectado", async () => {
  await withHome(async (home) => {
    const bin = join(home, "ffmpeg", "bin");
    await mkdir(bin, { recursive: true });
    const binary = join(bin, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    await writeFile(binary, "binario adulterado");

    await writeFile(join(home, "ffmpeg", "manifest.json"), JSON.stringify({ ffmpegSha256: "0".repeat(64) }));
    const bad = await ensureFfmpeg({ check: true });
    assert.equal(bad.state, "falhou", "digest diferente precisa reprovar");

    const digest = createHash("sha256").update(await readFile(binary)).digest("hex");
    await writeFile(join(home, "ffmpeg", "manifest.json"), JSON.stringify({ ffmpegSha256: digest, sha256: ffmpegBuildFor().sha256 }));
    const good = await ensureFfmpeg({ check: true });
    assert.equal(good.state, "ok");
  });
});

test("ffmpeg instalado a partir de outro arquivo que o do pin é desatualizado (pin novo reinstala)", async () => {
  await withHome(async (home) => {
    const bin = join(home, "ffmpeg", "bin");
    await mkdir(bin, { recursive: true });
    const binary = join(bin, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    await writeFile(binary, "binario antigo, íntegro");
    const digest = createHash("sha256").update(await readFile(binary)).digest("hex");

    // Binário confere com o manifesto, mas o manifesto veio de um arquivo que o pin de hoje não manda.
    await writeFile(join(home, "ffmpeg", "manifest.json"), JSON.stringify({ ffmpegSha256: digest, sha256: "e".repeat(64) }));
    const stale = await ensureFfmpeg({ check: true });
    assert.equal(stale.state, "falhou");
    assert.match(stale.detail, /outro arquivo/);

    // Manifesto antigo sem o digest do arquivo (formato anterior ao EDT-13) também é desatualizado.
    await writeFile(join(home, "ffmpeg", "manifest.json"), JSON.stringify({ ffmpegSha256: digest }));
    assert.equal((await ensureFfmpeg({ check: true })).state, "falhou");
  });
});

/** Cria um arquivo de FFmpeg falso, pequeno, no formato pedido, e devolve o `build` que o descreve. */
async function fakeBuild(workDir: string, format: FfmpegBuild["format"], platform: FfmpegBuild["platform"]): Promise<{ build: FfmpegBuild; bytes: Buffer }> {
  const root = `ffmpeg-teste-${platform}-lgpl-8.1`;
  const exe = platform === "win64" ? ".exe" : "";
  const tree = join(workDir, "tree");
  await mkdir(join(tree, root, "bin"), { recursive: true });
  await writeFile(join(tree, root, "bin", `ffmpeg${exe}`), `ffmpeg ${platform}`);
  await writeFile(join(tree, root, "bin", `ffprobe${exe}`), `ffprobe ${platform}`);
  await writeFile(join(tree, root, "LICENSE.txt"), "LGPL de teste");
  const archive = `${root}.${format}`;
  // Caminhos relativos ao cwd: o `tar` do GNU lê `C:\…` como host remoto.
  if (format === "tar.xz") await exec("tar", ["-cJf", join("..", archive), root], { cwd: tree });
  else await exec("powershell", ["-NoProfile", "-Command", `Compress-Archive -LiteralPath '${join(tree, root)}' -DestinationPath '${join(workDir, archive)}'`]);
  const bytes = await readFile(join(workDir, archive));
  const build: FfmpegBuild = {
    platform,
    version: "teste",
    tag: "autobuild-2000-01-01-00-00",
    archive,
    url: `https://exemplo.invalid/${archive}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    root,
    format,
  };
  return { build, bytes };
}

async function withFfmpegFetch<T>(url: string, body: Buffer, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const requested = String(input instanceof Request ? input.url : input);
    assert.equal(requested, url, "o setup só pode baixar a URL do pin");
    return new Response(new Uint8Array(body), { status: 200 });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("ffmpeg: instala de um tar.xz (Linux) por tar -xJf, com SHA-256 conferido e manifesto com o digest do arquivo", async () => {
  await withHome(async (home) => {
    await withTempDir("ff-arch-", async (work) => {
      const { build, bytes } = await fakeBuild(work, "tar.xz", "linux64");
      const step = await withFfmpegFetch(build.url, bytes, () => ensureFfmpeg({ build }));
      assert.equal(step.state, "instalado", step.detail);
      assert.match(step.detail, /linux64/);

      assert.equal(await readFile(join(home, "ffmpeg", "bin", "ffmpeg"), "utf8"), "ffmpeg linux64");
      assert.equal(await readFile(join(home, "ffmpeg", "bin", "ffprobe"), "utf8"), "ffprobe linux64");
      assert.equal(await readFile(join(home, "ffmpeg", "LICENSE.txt"), "utf8"), "LGPL de teste");
      const manifest = JSON.parse(await readFile(join(home, "ffmpeg", "manifest.json"), "utf8")) as { sha256: string; tag: string; platform: string };
      assert.equal(manifest.sha256, build.sha256);
      assert.equal(manifest.tag, build.tag);
      assert.equal(manifest.platform, "linux64");
      assert.match(await readFile(join(home, "ffmpeg", "SOURCE.txt"), "utf8"), /tag: +autobuild-2000-01-01-00-00/);

      // Segunda rodada: nada a fazer (o manifesto casa com o pin).
      assert.equal((await ensureFfmpeg({ build, check: true })).state, "ok");
    });
  });
});

test("ffmpeg: arquivo com SHA-256 diferente do pin é recusado e nada é instalado", async () => {
  await withHome(async (home) => {
    await withTempDir("ff-arch-", async (work) => {
      const { build, bytes } = await fakeBuild(work, "tar.xz", "linux64");
      const adulterado = { ...build, sha256: "0".repeat(64) };
      await assert.rejects(withFfmpegFetch(build.url, bytes, () => ensureFfmpeg({ build: adulterado })), /SHA-256 do arquivo não confere/);
      assert.equal(await readFile(join(home, "ffmpeg", "bin", "ffmpeg")).then(() => true, () => false), false);
    });
  });
});

test("ffmpeg: manifesto de outro arquivo é reinstalado pelo setup", async () => {
  await withHome(async (home) => {
    await withTempDir("ff-arch-", async (work) => {
      const { build, bytes } = await fakeBuild(work, "tar.xz", "linux64");
      await mkdir(join(home, "ffmpeg", "bin"), { recursive: true });
      await writeFile(join(home, "ffmpeg", "bin", "ffmpeg"), "antigo");
      const digest = createHash("sha256").update("antigo").digest("hex");
      await writeFile(join(home, "ffmpeg", "manifest.json"), JSON.stringify({ ffmpegSha256: digest, sha256: "a".repeat(64) }));

      const step = await withFfmpegFetch(build.url, bytes, () => ensureFfmpeg({ build }));
      assert.equal(step.state, "instalado", step.detail);
      assert.equal(await readFile(join(home, "ffmpeg", "bin", "ffmpeg"), "utf8"), "ffmpeg linux64");
    });
  });
});

test("ffmpeg: instala de um zip (Windows)", { skip: process.platform === "win32" ? false : "criar o zip de teste usa Compress-Archive (só Windows)" }, async () => {
  await withHome(async (home) => {
    await withTempDir("ff-arch-", async (work) => {
      const { build, bytes } = await fakeBuild(work, "zip", "win64");
      const step = await withFfmpegFetch(build.url, bytes, () => ensureFfmpeg({ build }));
      assert.equal(step.state, "instalado", step.detail);
      assert.equal(await readFile(join(home, "ffmpeg", "bin", "ffmpeg.exe"), "utf8"), "ffmpeg win64");
      assert.equal(await readFile(join(home, "ffmpeg", "bin", "ffprobe.exe"), "utf8"), "ffprobe win64");
    });
  });
});

/** PSModulePath de um PowerShell 7 (o que um `pwsh` pai entrega ao `powershell` 5.1 filho); `undefined` sem pwsh. */
async function pwshModulePath(): Promise<string | undefined> {
  try {
    const { stdout } = await exec("pwsh", ["-NoProfile", "-Command", "$env:PSModulePath"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

test(
  "ffmpeg: zip extrai mesmo com o PSModulePath de um PowerShell 7 herdado (Expand-Archive falhava sem erro e sem extrair)",
  { skip: process.platform === "win32" ? false : "Expand-Archive só no Windows" },
  async (t) => {
    const modules = await pwshModulePath();
    if (modules === undefined) {
      t.skip("sem pwsh (PowerShell 7) instalado: não há PSModulePath de PS7 para herdar");
      return;
    }
    const previous = process.env.PSModulePath;
    await withHome(async (home) => {
      await withTempDir("ff-arch-", async (work) => {
        const { build, bytes } = await fakeBuild(work, "zip", "win64");
        process.env.PSModulePath = modules;
        try {
          const step = await withFfmpegFetch(build.url, bytes, () => ensureFfmpeg({ build }));
          assert.equal(step.state, "instalado", step.detail);
          assert.equal(await readFile(join(home, "ffmpeg", "bin", "ffmpeg.exe"), "utf8"), "ffmpeg win64");
        } finally {
          if (previous === undefined) delete process.env.PSModulePath;
          else process.env.PSModulePath = previous;
        }
      });
    });
  },
);

test("ffmpeg: arquivo que extrai sem criar a pasta do pin falha com a pasta esperada, não com ENOENT no copyFile", async () => {
  await withHome(async (home) => {
    await withTempDir("ff-arch-", async (work) => {
      const { build, bytes } = await fakeBuild(work, "tar.xz", "linux64");
      const errado = { ...build, root: "pasta-que-o-arquivo-nao-cria" };
      await assert.rejects(
        withFfmpegFetch(build.url, bytes, () => ensureFfmpeg({ build: errado })),
        /pasta-que-o-arquivo-nao-cria não apareceu/,
      );
      assert.equal(await readFile(join(home, "ffmpeg", "bin", "ffmpeg")).then(() => true, () => false), false);
    });
  });
});

test("ffmpeg: plataforma sem pin vira passo 'falhou' com o código, nunca instala o de outra", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    await withHome(async () => {
      const step = await ensureFfmpeg({ check: true });
      assert.equal(step.state, "falhou");
      assert.match(step.detail, /E_FFMPEG_PLATFORM_UNSUPPORTED/);
      assert.match(step.detail, /darwin\//);
    });
  } finally {
    if (platform !== undefined) Object.defineProperty(process, "platform", platform);
  }
});

test("home vazio reporta fontes e ffmpeg ausentes, sem baixar", async () => {
  await withHome(async () => {
    const fonts = await ensureFonts({ check: true });
    assert.equal(fonts.state, "ausente");
    const ffmpeg = await ensureFfmpeg({ check: true });
    assert.equal(ffmpeg.state, "ausente");
  });
});

/** Troca o `fetch` global: licença (URL .../LICENSE) responde `license`; fonte responde um woff2 mínimo. */
async function withFetch<T>(license: (url: string) => Response, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/LICENSE")) return license(url);
    return new Response(Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(16)]), { status: 200 });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("fontes: falha ao baixar a licença OFL não derruba o setup, mas aparece no detail com o nome e o motivo", async () => {
  await withHome(async () => {
    const step = await withFetch(() => new Response("indisponível", { status: 503 }), () => ensureFonts());
    assert.equal(step.state, "instalado");
    assert.match(step.detail, /aviso: \d+ licença\(s\) OFL não baixada\(s\)/);
    assert.match(step.detail, /OFL-[\w-]+\.txt: .*HTTP 503/);
  });
});

test("fontes: com todas as licenças baixadas o detail não traz aviso", async () => {
  await withHome(async () => {
    const step = await withFetch(() => new Response("licença", { status: 200 }), () => ensureFonts());
    assert.equal(step.state, "instalado");
    assert.ok(!step.detail.includes("aviso"), step.detail);
  });
});
