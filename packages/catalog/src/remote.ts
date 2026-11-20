// FrankFrames — proprietário. Ver LICENSE na raiz.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadComposition } from "@frankframes/contract";

export interface InstalledBlock {
  slug: string;
  destination: string;
  bytes: number;
  sha256: string;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Instala um bloco publicado por URL (`<url>/meta.json` + `<url>/index.html`).
 * O `meta.json` precisa declarar `sha256` do HTML; sem hash, a instalação é recusada.
 */
export async function installBlockFromUrl(url: string, destination: string): Promise<InstalledBlock> {
  const base = url.replace(/\/+$/, "");

  const metaResponse = await fetch(`${base}/meta.json`);
  if (!metaResponse.ok) throw new Error(`meta.json: HTTP ${metaResponse.status} em ${base}`);
  const meta = (await metaResponse.json()) as { name?: string; sha256?: string; slug?: string; durationSeconds?: number };
  if (typeof meta.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(meta.sha256)) {
    throw new Error(`${base}/meta.json não declara sha256 do index.html; instalação recusada`);
  }

  const htmlResponse = await fetch(`${base}/index.html`);
  if (!htmlResponse.ok) throw new Error(`index.html: HTTP ${htmlResponse.status} em ${base}`);
  const html = Buffer.from(await htmlResponse.arrayBuffer());

  const digest = sha256(html);
  if (digest !== meta.sha256.toLowerCase()) {
    throw new Error(`sha256 não confere: esperado ${meta.sha256.slice(0, 16)}…, obtido ${digest.slice(0, 16)}…`);
  }

  const composition = loadComposition(html.toString("utf8"));
  if (!composition.ok) {
    const first = composition.diagnostics.find((item) => item.severity === "error");
    throw new Error(`bloco inválido (${first?.code ?? "E_CONTRACT"}): ${first?.message ?? "contrato reprovado"}`);
  }

  const slug = (meta.slug ?? base.split("/").pop() ?? "bloco").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const target = resolve(destination);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "index.html"), html);
  await writeFile(
    join(target, "meta.json"),
    `${JSON.stringify({ ...meta, slug, sha256: digest }, null, 2)}\n`,
  );

  return { slug, destination: target, bytes: html.byteLength, sha256: digest };
}

/** Lê o HTML de um bloco local já validado pelo catálogo. */
export async function readBlockHtml(dir: string): Promise<Buffer> {
  return readFile(join(dir, "index.html"));
}
