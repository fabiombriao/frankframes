// FrankFrames — proprietário. Ver LICENSE na raiz.
// Codex falso para os testes: nenhum teste chama o Codex de verdade nem toca na conta de ninguém.
//   --version           → codex-cli 0.0.0-fake
//   login status        → FAKE_CODEX_LOGIN: chatgpt (padrão) | apikey | none; como o Codex real, escreve no stderr
//   exec ...            → lê o prompt do stdin, anota a chamada em FAKE_CODEX_TRACE (uma linha JSON por chamada),
//                         e grava em `-o` a n-ésima resposta de FAKE_CODEX_REPLIES (arquivo JSON com uma lista;
//                         texto = resposta crua, objeto = JSON.stringify). FAKE_CODEX_SLEEP_MS simula demora.
//                         FAKE_CODEX_EXIT=N faz o exec sair com N sem responder.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);

if (argv[0] === "--version") {
  process.stdout.write("codex-cli 0.0.0-fake\n");
  process.exit(0);
}

if (argv[0] === "login" && argv[1] === "status") {
  const login = process.env.FAKE_CODEX_LOGIN ?? "chatgpt";
  if (login === "chatgpt") {
    process.stderr.write("Logged in using ChatGPT\n");
    process.exit(0);
  }
  if (login === "apikey") {
    process.stderr.write("Logged in using an API key - sk-fake***\n");
    process.exit(0);
  }
  process.stderr.write("Not logged in\n");
  process.exit(1);
}

if (argv[0] !== "exec") {
  process.stderr.write(`fake-codex: comando não suportado: ${argv.join(" ")}\n`);
  process.exit(64);
}

const option = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;

const contextDir = option("-C");
const outPath = option("-o");
const files = contextDir !== undefined && existsSync(contextDir) ? readdirSync(contextDir, { recursive: true }).map(String).sort() : [];
if (process.env.FAKE_CODEX_TRACE !== undefined) {
  appendFileSync(
    process.env.FAKE_CODEX_TRACE,
    `${JSON.stringify({
      pid: process.pid,
      argv,
      stdin,
      cwd: process.cwd(),
      contextDir,
      files,
      hasOpenAiKey: process.env.OPENAI_API_KEY !== undefined,
      hasCodexKey: process.env.CODEX_API_KEY !== undefined,
      hasFrankframesVar: Object.keys(process.env).some((key) => key.startsWith("FRANKFRAMES_")),
    })}\n`,
  );
}

if (process.env.FAKE_CODEX_SLEEP_MS !== undefined) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CODEX_SLEEP_MS)));
if (process.env.FAKE_CODEX_EXIT !== undefined) {
  process.stderr.write("fake-codex: falha pedida\n");
  process.exit(Number(process.env.FAKE_CODEX_EXIT));
}

const repliesFile = process.env.FAKE_CODEX_REPLIES;
if (repliesFile === undefined || outPath === undefined) {
  process.stderr.write("fake-codex: faltam FAKE_CODEX_REPLIES e/ou -o\n");
  process.exit(65);
}
const replies = JSON.parse(readFileSync(repliesFile, "utf8"));
const counter = `${repliesFile}.count`;
const call = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, String(call + 1));
const reply = replies[Math.min(call, replies.length - 1)];
writeFileSync(outPath, typeof reply === "string" ? reply : JSON.stringify(reply));
process.stdout.write("fake-codex: ok\n");
