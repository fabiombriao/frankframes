// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Roda um comando com N laços de CPU em processos separados (o "10 loops" do laboratório do EDT-77) e mata os laços
 * ao fim. Uso: `node scripts/bench/with-load.ts <laços> <comando> [args...]`. Só diagnóstico e auto-prova sob carga.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";

const [count, command, ...args] = process.argv.slice(2);
if (count === undefined || command === undefined) {
  process.stderr.write("uso: node scripts/bench/with-load.ts <laços> <comando> [args...]\n");
  process.exit(2);
}
const burners = Array.from({ length: Number(count) }, () => spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
const child = spawn(command, args, { stdio: "inherit" });
const [code] = (await once(child, "exit")) as [number | null];
const exits = burners.map((b) => (b.exitCode === null ? once(b, "exit") : Promise.resolve()));
for (const b of burners) b.kill("SIGKILL");
await Promise.all(exits);
process.exit(code ?? 1);
