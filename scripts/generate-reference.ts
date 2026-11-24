// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Gera `docs/reference/diagnostics.md` a partir dos códigos do código. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODES } from "@frankframes/contract";
import { EDIT_ERROR_CODES, FRAMES_ERROR_CODES, PREVIEW_AUDIO_ERROR_CODES, RENDER_ERROR_CODES } from "@frankframes/producer";
import { FAILURE_ERROR_CODES } from "@frankframes/engine";
import { TRANSCRIBE_ERROR_CODES } from "@frankframes/transcribe";
import { POLICY_CODES } from "@frankframes/encode";
import { CLI_ERROR_CODES, STUDIO_ERROR_CODES } from "../packages/cli/src/cli-errors.ts";
import { GENERATE_ERROR_CODES, GENERATE_REPAIR_CODES } from "../packages/cli/src/generate-errors.ts";

const target = fileURLToPath(new URL("../docs/reference/diagnostics.md", import.meta.url));

export function renderReference(): string {
  const rows: Array<[string, string]> = [
    ...Object.values(CODES).map((code): [string, string] => [code, "contrato"]),
    ...RENDER_ERROR_CODES.map((code): [string, string] => [code, "render"]),
    ...FRAMES_ERROR_CODES.map((code): [string, string] => [code, "frames"]),
    ...[...GENERATE_ERROR_CODES, ...GENERATE_REPAIR_CODES].map((code): [string, string] => [code, "geração"]),
    ...FAILURE_ERROR_CODES.map((code): [string, string] => [code, "render"]),
    ...EDIT_ERROR_CODES.map((code): [string, string] => [code, "edição"]),
    ...PREVIEW_AUDIO_ERROR_CODES.map((code): [string, string] => [code, "preview"]),
    ...STUDIO_ERROR_CODES.map((code): [string, string] => [code, "studio"]),
    ...CLI_ERROR_CODES.map((code): [string, string] => [code, "cli"]),
    ...POLICY_CODES.map((code): [string, string] => [code, "licença/encode"]),
    ...TRANSCRIBE_ERROR_CODES.map((code): [string, string] => [code, "transcrição"]),
  ];
  rows.sort((a, b) => a[0].localeCompare(b[0]));

  const unique = new Map(rows);
  const lines = [
    "# Diagnósticos",
    "",
    "Gerado por `node scripts/generate-reference.ts` a partir do código. Não edite à mão.",
    "",
    "| Código | Severidade | Origem |",
    "|---|---|---|",
    ...[...unique.entries()].map(([code, source]) => {
      const severity = code.startsWith("E_") ? "erro" : "aviso";
      return `| \`${code}\` | ${severity} | ${source} |`;
    }),
    "",
  ];
  return lines.join("\n");
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("generate-reference.ts")) {
  await mkdir(fileURLToPath(new URL("../docs/reference/", import.meta.url)), { recursive: true });
  const text = renderReference();
  await writeFile(target, text);
  process.stdout.write(`docs/reference/diagnostics.md · ${text.split("\n").length - 6} códigos\n`);
}
