// FrankFrames — proprietário. Ver LICENSE na raiz.
// Inspetor de clip (EDT-85): lógica pura, sem DOM. ESM servido ao navegador e importado pelo Node nos testes.

/** Texto que o inspetor mostra para um número: arredondado a milissegundo, só para exibição (nunca vai para o HTML). */
export function displayNumber(value) {
  if (value === null || value === undefined) return "";
  return String(Math.round(value * 1000) / 1000);
}

/**
 * Atributos numéricos que o usuário mudou. Cada entrada traz `shown` (o texto que o inspetor exibiu ao preencher),
 * `text` (o que está no campo agora) e `original` (o valor real da fonte, `null` se o atributo não existe).
 * Campo cujo texto é o exibido não foi tocado: fica de fora e o HTML não é regravado, mesmo que o valor exibido
 * seja uma versão arredondada do original (`68.165` para `68.164583`).
 * Devolve `{ attributes, errors }`; `attributes[chave] = null` remove o atributo.
 */
export function numericChanges(entries) {
  const attributes = {};
  const errors = [];
  for (const { key, shown, text, original } of entries) {
    const raw = String(text).trim();
    if (raw === String(shown).trim()) continue;
    if (raw === "") {
      if (original !== null) attributes[key] = null;
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      errors.push(key + " precisa ser um número.");
      continue;
    }
    if (original === null || Math.abs(value - original) > 1e-9) attributes[key] = String(value);
  }
  return { attributes, errors };
}
