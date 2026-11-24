// FrankFrames — proprietário. Ver LICENSE na raiz.

/**
 * Por padrão o Puppeteer trata SIGINT/SIGTERM/SIGHUP: no SIGINT mata o Chrome e chama `process.exit(130)` na hora.
 * Quem precisa de um cancelamento gracioso (o lote: parar a fila, cancelar os renders, gravar o relatório) assume
 * os sinais e liga isto antes de abrir qualquer browser. O `exit` do processo continua matando o Chrome.
 */
let hostOwnsSignals = false;

export function setHostOwnsSignals(value: boolean): void {
  hostOwnsSignals = value;
}

/** Opções de `puppeteer.launch` para o tratamento de sinais escolhido. */
export function browserSignalOptions(): { handleSIGINT: boolean; handleSIGTERM: boolean; handleSIGHUP: boolean } {
  const handled = !hostOwnsSignals;
  return { handleSIGINT: handled, handleSIGTERM: handled, handleSIGHUP: handled };
}
