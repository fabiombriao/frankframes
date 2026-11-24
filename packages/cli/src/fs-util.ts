// FrankFrames — proprietário. Ver LICENSE na raiz.
import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";

/**
 * `stat` que devolve `undefined` só quando o caminho não existe (ENOENT) ou passa "por dentro" de um arquivo
 * (ENOTDIR). Qualquer outra falha (EACCES, EIO, caminho inválido…) sobe: "não consegui ler" não é "não existe".
 */
export async function statIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}
