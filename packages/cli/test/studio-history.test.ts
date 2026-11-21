// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_LIMIT, HistoryStaleError, StudioHistory } from "../src/studio-history.ts";

test("histórico desfaz e refaz em ordem e descarta o futuro ao gravar", () => {
  const history = new StudioHistory();
  history.record("1", "a", "b");
  history.record("2", "b", "c");
  assert.equal(history.undo("c"), "b");
  assert.equal(history.undo("b"), "a");
  assert.equal(history.undo("a"), undefined);
  assert.equal(history.redo("a"), "b");
  history.record("3", "b", "d");
  assert.equal(history.redo("d"), undefined, "gravar depois de desfazer descarta o refazer");
  assert.deepEqual(history.state(), { canUndo: true, canRedo: false, undo: "3", redo: null });
});

test("histórico detecta arquivo alterado fora e não encadeia errado", () => {
  const history = new StudioHistory();
  history.record("1", "a", "b");
  assert.throws(() => history.undo("x"), HistoryStaleError);
  assert.equal(history.state().canUndo, false);

  history.record("1", "a", "b");
  history.record("2", "externo", "c");
  assert.equal(history.undo("c"), "externo");
  assert.equal(history.undo("externo"), undefined, "passo anterior à mudança externa foi descartado");
});

test("histórico guarda no máximo o teto", () => {
  const history = new StudioHistory();
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) history.record(String(i), String(i), String(i + 1));
  let current = String(HISTORY_LIMIT + 10);
  let steps = 0;
  for (let next = history.undo(current); next !== undefined; next = history.undo(current)) {
    current = next;
    steps++;
  }
  assert.equal(steps, HISTORY_LIMIT);
});
