// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Executa tarefas assíncronas com concorrência limitada, preservando a ordem dos resultados. */
export async function mapPool<T, R>(items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Concorrência padrão para trabalho que abre um browser por tarefa. */
export function defaultConcurrency(): number {
  return Math.max(1, Math.min(4, Math.floor((Number(process.env.FRANKFRAMES_GOLDENS_CONCURRENCY) || 4))));
}
