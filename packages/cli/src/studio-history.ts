// FrankFrames — proprietário. Ver LICENSE na raiz.

/** Teto de passos guardados; o mais antigo sai primeiro. */
export const HISTORY_LIMIT = 200;

interface Entry {
  label: string;
  /** Arquivo escrito: a entrada ou uma sub-composição (legendas). */
  file: string;
  before: string;
  after: string;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /** Rótulo do passo que o próximo desfazer reverte. */
  undo: string | null;
  redo: string | null;
}

/** Histórico inválido: o arquivo mudou fora do Studio depois da última escrita. */
export class HistoryStaleError extends Error {
  readonly code = "E_HISTORY_STALE";

  constructor() {
    super("o arquivo mudou fora do Studio; o histórico foi descartado para não sobrescrever essa mudança");
    this.name = "HistoryStaleError";
  }
}

/**
 * Pilha de versões completas dos arquivos escritos. Guardar o texto inteiro custa memória,
 * mas torna desfazer exato e independente do tipo de edição.
 */
export class StudioHistory {
  private entries: Entry[] = [];
  /** Quantos passos estão aplicados; `entries.slice(cursor)` é o que dá para refazer. */
  private cursor = 0;

  /** Conteúdo que o Studio espera no disco para `file`, ou `undefined` sem passo desse arquivo. */
  private expected(file: string): string | undefined {
    for (let i = this.cursor - 1; i >= 0; i--) if (this.entries[i]!.file === file) return this.entries[i]!.after;
    return this.entries.find((entry) => entry.file === file)?.before;
  }

  /** Registra uma escrita. Mudança externa anterior zera o histórico em vez de encadear errado. */
  record(label: string, file: string, before: string, after: string): void {
    const expected = this.expected(file);
    if (expected !== undefined && expected !== before) this.clear();
    this.entries = this.entries.slice(0, this.cursor);
    this.entries.push({ label, file, before, after });
    if (this.entries.length > HISTORY_LIMIT) this.entries.shift();
    this.cursor = this.entries.length;
  }

  /** Arquivo que o próximo desfazer/refazer grava; `undefined` sem passo nessa direção. */
  target(direction: "undo" | "redo"): string | undefined {
    return this.entries[direction === "undo" ? this.cursor - 1 : this.cursor]?.file;
  }

  /** Devolve o conteúdo a gravar para desfazer; `current` é o que está no disco em `target("undo")`. */
  undo(current: string | undefined): string | undefined {
    if (this.cursor === 0) return undefined;
    const entry = this.entries[this.cursor - 1]!;
    this.assertFresh(entry.file, current);
    this.cursor -= 1;
    return entry.before;
  }

  /** Como `undo`, com `current` lido de `target("redo")`; `undefined` = o arquivo sumiu. */
  redo(current: string | undefined): string | undefined {
    if (this.cursor >= this.entries.length) return undefined;
    const entry = this.entries[this.cursor]!;
    this.assertFresh(entry.file, current);
    this.cursor += 1;
    return entry.after;
  }

  /** Volta o cursor quando a escrita do desfazer/refazer falhou. */
  revert(direction: "undo" | "redo"): void {
    this.cursor += direction === "undo" ? 1 : -1;
  }

  clear(): void {
    this.entries = [];
    this.cursor = 0;
  }

  state(): HistoryState {
    const canUndo = this.cursor > 0;
    const canRedo = this.cursor < this.entries.length;
    return {
      canUndo,
      canRedo,
      undo: canUndo ? this.entries[this.cursor - 1]!.label : null,
      redo: canRedo ? this.entries[this.cursor]!.label : null,
    };
  }

  private assertFresh(file: string, current: string | undefined): void {
    if (current !== this.expected(file)) {
      this.clear();
      throw new HistoryStaleError();
    }
  }
}
