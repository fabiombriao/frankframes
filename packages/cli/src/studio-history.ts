// FrankFrames — proprietário. Ver LICENSE na raiz.

/** Teto de passos guardados; o mais antigo sai primeiro. */
export const HISTORY_LIMIT = 200;

interface Entry {
  label: string;
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
 * Pilha de versões completas do arquivo. Guardar o texto inteiro custa memória,
 * mas torna desfazer exato e independente do tipo de edição.
 */
export class StudioHistory {
  private entries: Entry[] = [];
  /** Quantos passos estão aplicados; `entries.slice(cursor)` é o que dá para refazer. */
  private cursor = 0;

  /** Conteúdo que o Studio espera no disco, ou `undefined` sem histórico. */
  private expected(): string | undefined {
    if (this.cursor > 0) return this.entries[this.cursor - 1]!.after;
    if (this.entries.length > 0) return this.entries[0]!.before;
    return undefined;
  }

  /** Registra uma escrita. Mudança externa anterior zera o histórico em vez de encadear errado. */
  record(label: string, before: string, after: string): void {
    const expected = this.expected();
    if (expected !== undefined && expected !== before) this.clear();
    this.entries = this.entries.slice(0, this.cursor);
    this.entries.push({ label, before, after });
    if (this.entries.length > HISTORY_LIMIT) this.entries.shift();
    this.cursor = this.entries.length;
  }

  /** Devolve o conteúdo a gravar para desfazer; `current` é o que está no disco. */
  undo(current: string): string | undefined {
    if (this.cursor === 0) return undefined;
    this.assertFresh(current);
    this.cursor -= 1;
    return this.entries[this.cursor]!.before;
  }

  redo(current: string): string | undefined {
    if (this.cursor >= this.entries.length) return undefined;
    this.assertFresh(current);
    const entry = this.entries[this.cursor]!;
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

  private assertFresh(current: string): void {
    if (current !== this.expected()) {
      this.clear();
      throw new HistoryStaleError();
    }
  }
}
