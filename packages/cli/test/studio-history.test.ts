// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_LIMIT, HistoryStaleError, StudioHistory } from "../src/studio-history.ts";

test("histórico desfaz e refaz em ordem e descarta o futuro ao gravar", () => {
  const history = new StudioHistory();
  history.record("1", "f", "a", "b");
  history.record("2", "f", "b", "c");
  assert.equal(history.undo("c"), "b");
  assert.equal(history.undo("b"), "a");
  assert.equal(history.undo("a"), undefined);
  assert.equal(history.redo("a"), "b");
  history.record("3", "f", "b", "d");
  assert.equal(history.redo("d"), undefined, "gravar depois de desfazer descarta o refazer");
  assert.deepEqual(history.state(), { canUndo: true, canRedo: false, undo: "3", redo: null });
});

test("histórico detecta arquivo alterado fora e não encadeia errado", () => {
  const history = new StudioHistory();
  history.record("1", "f", "a", "b");
  assert.throws(() => history.undo("x"), HistoryStaleError);
  assert.equal(history.state().canUndo, false);

  history.record("1", "f", "a", "b");
  history.record("2", "f", "externo", "c");
  assert.equal(history.undo("c"), "externo");
  assert.equal(history.undo("externo"), undefined, "passo anterior à mudança externa foi descartado");
});

test("histórico guarda no máximo o teto", () => {
  const history = new StudioHistory();
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) history.record(String(i), "f", String(i), String(i + 1));
  let current = String(HISTORY_LIMIT + 10);
  let steps = 0;
  for (let next = history.undo(current); next !== undefined; next = history.undo(current)) {
    current = next;
    steps++;
  }
  assert.equal(steps, HISTORY_LIMIT);
});

test("cada passo é do seu arquivo: stale e encadeamento valem por arquivo (EDT-97)", () => {
  const history = new StudioHistory();
  history.record("entrada", "index.html", "i0", "i1");
  history.record("legenda", "legendas.html", "l0", "l1");
  history.record("entrada 2", "index.html", "i1", "i2");

  assert.equal(history.target("undo"), "index.html");
  assert.equal(history.undo("i2"), "i1");
  assert.equal(history.target("undo"), "legendas.html");
  assert.equal(history.undo("l1"), "l0");
  assert.equal(history.target("redo"), "legendas.html");
  assert.equal(history.redo("l0"), "l1");
  assert.equal(history.redo("i1"), "i2");

  // A legenda mudada fora não impede desfazer a entrada, mas para o passo dela.
  assert.equal(history.undo("i2"), "i1");
  assert.throws(() => history.undo("mexida fora"), HistoryStaleError);
  assert.equal(history.state().canUndo, false);

  // Arquivo que sumiu também é stale.
  history.record("legenda", "legendas.html", "l0", "l1");
  assert.throws(() => history.undo(undefined), HistoryStaleError);
});

test("escrita nova sobre arquivo mudado fora descarta o histórico, mesmo com passo de outro arquivo no meio (EDT-97)", () => {
  const history = new StudioHistory();
  history.record("legenda", "legendas.html", "l0", "l1");
  history.record("entrada", "index.html", "i0", "i1");
  history.record("legenda de novo", "legendas.html", "externo", "l2");
  assert.equal(history.undo("l2"), "externo");
  assert.equal(history.state().canUndo, false);
});
