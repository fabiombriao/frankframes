// FrankFrames — proprietário. Ver LICENSE na raiz.
// Inspetor de Composição (EDT-84): lógica pura, sem DOM. ESM servido ao navegador e importado pelo Node nos testes.

/** Código do contrato para clip de topo que termina depois do fim autoral da raiz (docs/contract.md §7). */
export const PAST_END_CODE = "W_CLIP_PAST_END";

function numberText(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : "";
}

/** `30` ou `30000/1001`, o mesmo formato que `data-fps` aceita. */
export function fpsText(fps) {
  if (typeof fps === "number" && Number.isFinite(fps)) return String(fps);
  if (fps && typeof fps === "object" && Number.isFinite(fps.num) && fps.num > 0) {
    const den = Number.isFinite(fps.den) && fps.den > 0 ? fps.den : 1;
    return den === 1 ? String(fps.num) : fps.num + "/" + den;
  }
  return "";
}

/**
 * Valores do formulário a partir de `GET /api/composition`. `derived` vale quando a raiz não tem `data-duration`
 * (duração derivada dos clips ou ainda não resolvida).
 */
export function compositionFields(data) {
  const authored = data.durationKind === "authored";
  return {
    duration: authored ? numberText(data.duration) : "",
    derived: !authored,
    width: numberText(data.width),
    height: numberText(data.height),
    fps: fpsText(data.fps),
  };
}

/**
 * Corpo do `POST /api/composition`: só o que mudou em relação ao arquivo. `{ body: null, error: null }` quando nada mudou;
 * `error` com a primeira entrada ilegível. Faixa e formato finais são do contrato, no servidor.
 */
export function compositionPatch(data, fields) {
  const base = compositionFields(data);
  const body = {};

  if (fields.derived) {
    if (!base.derived) body.duration = null;
  } else {
    const text = String(fields.duration ?? "").trim();
    if (text === "") return { body: null, error: 'informe a duração em segundos ou marque "derivada"' };
    const seconds = Number(text);
    if (!Number.isFinite(seconds) || seconds <= 0) return { body: null, error: "a duração precisa ser um número de segundos maior que 0" };
    if (base.derived || seconds !== Number(base.duration)) body.duration = seconds;
  }

  for (const key of ["width", "height"]) {
    const text = String(fields[key] ?? "").trim();
    if (text === base[key]) continue;
    const value = Number(text);
    if (text === "" || !Number.isFinite(value)) return { body: null, error: key + " precisa ser um número inteiro de pixels" };
    body[key] = value;
  }

  const fps = String(fields.fps ?? "").trim();
  if (fps === "") return { body: null, error: 'fps não pode ficar vazio (use "30" ou "30000/1001")' };
  if (fps !== base.fps) body.fps = fps;

  return { body: Object.keys(body).length === 0 ? null : body, error: null };
}

/**
 * Aviso da faixa sobre a timeline: existe quando algum clip de topo passa do fim autoral. `null` sem o diagnóstico.
 * `ids` são os clips afetados, na ordem do contrato.
 */
export function pastEndNotice(diagnostics) {
  const found = (Array.isArray(diagnostics) ? diagnostics : []).filter((item) => item && item.code === PAST_END_CODE);
  if (found.length === 0) return null;
  return {
    count: found.length,
    ids: found.map((item) => item.clipId).filter((id) => typeof id === "string"),
    message: found[0].message,
    hint: typeof found[0].hint === "string" ? found[0].hint : "",
  };
}
