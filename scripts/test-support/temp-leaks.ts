// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Vigia de sobras em os.tmpdir() para o gate (EDT-82): compara os `ff-*` de antes e de depois de uma
 * etapa de testes. Só contam os NOVOS; o que já existia (de execuções antigas) é tolerado e nunca apagado.
 *
 * Limitação aceita: se outro processo do usuário criar `ff-*` durante a etapa (outro gate, um render
 * à mão), a etapa reprova por engano; rode de novo com a máquina sem outro FrankFrames em execução.
 */
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { TEMP_PREFIX } from "./temp.ts";

/** Quantos nomes a mensagem lista antes de resumir. */
export const LEAK_LIST_LIMIT = 20;

/** Nomes `ff-*` presentes agora em `dir`. */
export async function snapshotTemp(dir: string = tmpdir()): Promise<Set<string>> {
  return new Set((await readdir(dir)).filter((name) => name.startsWith(TEMP_PREFIX)));
}

/** Nomes `ff-*` de `dir` que não estavam em `before`, em ordem alfabética. */
export async function newTempEntries(before: ReadonlySet<string>, dir: string = tmpdir()): Promise<string[]> {
  return [...(await snapshotTemp(dir))].filter((name) => !before.has(name)).sort();
}

/** Mensagem acionável (pt-BR) para a etapa que deixou diretório para trás. */
export function formatLeaks(stage: string, leaked: readonly string[], dir: string = tmpdir()): string {
  const shown = leaked.slice(0, LEAK_LIST_LIMIT).map((name) => `  - ${name}`);
  const rest = leaked.length > shown.length ? [`  … e mais ${leaked.length - shown.length}`] : [];
  return [
    `${stage}: ${leaked.length} diretório(s) ff-* novo(s) ficaram em ${dir}:`,
    ...shown,
    ...rest,
    "Ache o teste pelo prefixo e crie o diretório com tempDir/withTempDir/makeTempDir de scripts/test-support/temp.ts.",
    "Se foi outro processo FrankFrames rodando ao mesmo tempo, rode o gate de novo sem ele.",
  ].join("\n");
}

interface Guardable {
  ok: boolean;
  detail?: string;
}

/**
 * Roda `run` e reprova o resultado se surgiu `ff-*` novo em `dir`. Etapa já reprovada continua
 * reprovada, e a sobra é somada ao detalhe. `report` recebe a mensagem completa (padrão: stderr).
 */
export async function guardTempLeaks<T extends Guardable>(
  stage: string,
  run: () => Promise<T>,
  options: { dir?: string; report?: (text: string) => void } = {},
): Promise<T> {
  const dir = options.dir ?? tmpdir();
  const report = options.report ?? ((text: string) => void process.stderr.write(text));
  const before = await snapshotTemp(dir);
  const result = await run();
  const leaked = await newTempEntries(before, dir);
  if (leaked.length === 0) return result;
  report(`\n✖ ${formatLeaks(stage, leaked, dir)}\n`);
  const note = `${leaked.length} ff-* novo(s) em ${dir}`;
  return { ...result, ok: false, detail: result.detail === undefined ? note : `${result.detail}; ${note}` };
}
