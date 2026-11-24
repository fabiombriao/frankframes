// FrankFrames — proprietário. Ver LICENSE na raiz.
import { rm } from "node:fs/promises";

/** Texto do aviso quando um temporário não saiu: sempre com o caminho e o motivo. */
export function cleanupWarning(path: string, error: unknown): string {
  return `não consegui remover ${path}: ${error instanceof Error ? error.message : String(error)}`;
}

/** Aviso visível no stderr, para quem não tem uma lista de `warnings` para devolver. */
export function warnCleanup(path: string, error: unknown): void {
  process.stderr.write(`[frankframes] ${cleanupWarning(path, error)}\n`);
}

/**
 * Remove `path` (diretório inteiro por padrão) e devolve a falha em vez de engolir: quem chama decide se vira
 * `warnings`, stderr ou erro. Sem `force`: um caminho que sumiu também é falha. Quem espera ENOENT
 * (arquivo que pode não existir) passa `missingOk` e diz por quê no ponto de chamada.
 */
export async function removeTree(path: string, options: { recursive?: boolean; missingOk?: boolean } = {}): Promise<Error | undefined> {
  try {
    await rm(path, { recursive: options.recursive ?? true, force: options.missingOk ?? false });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** `removeTree` + `warnCleanup`: o atalho para limpeza em `finally`, onde o erro original não pode ser trocado. */
export async function removeOrWarn(path: string, options: { recursive?: boolean; missingOk?: boolean } = {}): Promise<boolean> {
  const failure = await removeTree(path, options);
  if (failure !== undefined) warnCleanup(path, failure);
  return failure === undefined;
}
