#!/usr/bin/env node
// FrankFrames — proprietário. Ver LICENSE na raiz.
import { readFileSync } from "node:fs";
import { loadComposition } from "@frankframes/contract";

interface Args {
  command: string;
  file?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "help", json: false };
  const rest: string[] = [];
  for (const arg of argv) {
    if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.command = "help";
    else rest.push(arg);
  }
  if (rest.length > 0) args.command = rest[0]!;
  if (rest.length > 1) args.file = rest[1]!;
  return args;
}

const HELP = `frankframes — vídeo determinístico a partir de HTML

uso:
  frankframes lint <arquivo.html> [--json]

lint sai com código 1 quando existe diagnóstico de severidade "error".
O contrato está em docs/contract.md.`;

const args = parseArgs(process.argv.slice(2));

if (args.command === "help" || args.command === "") {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

if (args.command !== "lint" || !args.file) {
  process.stderr.write(`comando desconhecido ou arquivo ausente\n\n${HELP}\n`);
  process.exit(2);
}

const composition = loadComposition(readFileSync(args.file, "utf8"));

if (args.json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        file: args.file,
        ok: composition.ok,
        id: composition.id,
        fps: composition.fps,
        duration: composition.duration,
        clips: composition.clips.map((c) => ({ id: c.id, start: c.start, end: c.end, media: c.isMedia, sub: c.isSubComposition })),
        diagnostics: composition.diagnostics,
      },
      null,
      2,
    )}\n`,
  );
} else {
  const { duration } = composition;
  const seconds = duration.kind === "unresolved" ? "não resolvida" : `${duration.seconds.toFixed(3)}s`;
  process.stdout.write(`${args.file}: ${composition.id || "(sem id)"} · ${composition.fps.num}/${composition.fps.den} fps · ${seconds}\n`);
  for (const clip of composition.clips) {
    process.stdout.write(`  ${clip.id.padEnd(20)} start=${clip.start ?? "?"} end=${clip.end ?? "?"}\n`);
  }
  for (const d of composition.diagnostics) {
    process.stdout.write(`${d.severity === "error" ? "erro" : "aviso"} ${d.code}${d.clipId ? ` [${d.clipId}]` : ""}: ${d.message}\n`);
    if (d.hint) process.stdout.write(`  → ${d.hint}\n`);
  }
}

process.exit(composition.ok ? 0 : 1);
