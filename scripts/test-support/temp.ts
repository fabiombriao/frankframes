// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Diretórios temporários dos testes (EDT-82).
 *
 * Todo diretório criado em os.tmpdir() por um teste nasce aqui e morre aqui. A remoção usa
 * `force: false` de propósito: EBUSY/ENOTEMPTY (processo filho ou servidor ainda segurando arquivo)
 * é defeito do teste e tem de aparecer, não ser engolido. Conserte a causa (espere o processo sair,
 * feche o servidor), não a remoção.
 *
 * Escolha pelo lugar onde o diretório é criado:
 *   - dentro de um teste              -> `tempDir(t, prefixo)`        (limpa em `t.after`)
 *   - helper `withX(run)` sem contexto -> `withTempDir(prefixo, run)`  (limpa ao fim de `run`)
 *   - hook before/after ou módulo     -> `makeTempDir(prefixo)`       (você chama `remove()`)
 */
import type { TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Todo temporário do projeto começa assim; é o que o gate (`temp-leaks.ts`) vigia. */
export const TEMP_PREFIX = "ff-";

function checkPrefix(prefix: string): void {
  if (!prefix.startsWith(TEMP_PREFIX)) {
    throw new Error(`prefixo de diretório temporário precisa começar com "${TEMP_PREFIX}" (recebido: "${prefix}")`);
  }
}

const removeDir = (dir: string): Promise<void> => rm(dir, { recursive: true, force: false });

/** Cria o diretório e o remove quando o teste `t` termina, passando ou falhando. */
export async function tempDir(t: Pick<TestContext, "after">, prefix: string): Promise<string> {
  checkPrefix(prefix);
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => removeDir(dir));
  return dir;
}

/** Cria o diretório e devolve quem o remove; fora de teste (before/after, módulo). */
export async function makeTempDir(prefix: string): Promise<{ dir: string; remove: () => Promise<void> }> {
  checkPrefix(prefix);
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, remove: () => removeDir(dir) };
}

/** Cria o diretório, roda `run` e remove. Se `run` e a remoção falharem, as duas falhas sobem juntas. */
export async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const { dir, remove } = await makeTempDir(prefix);
  let result: T;
  try {
    result = await run(dir);
  } catch (error) {
    try {
      await remove();
    } catch (removeError) {
      throw new AggregateError([error, removeError], `falha no teste e na remoção de ${dir}`);
    }
    throw error;
  }
  await remove();
  return result;
}
