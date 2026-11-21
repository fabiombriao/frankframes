// FrankFrames — proprietário. Ver LICENSE na raiz.
// Inspetor de presets de motion (docs/contract.md §9d). ESM puro, servido ao navegador e importado pelo
// Node nos testes: as funções de texto não tocam o DOM; as de DOM só usam `document` quando chamadas.
// Sem estado global: tudo vem por argumento. Quem valida é o servidor (POST /api/clips/<id>).

/** Chaves comuns, nesta ordem; as próprias do preset vêm depois, em ordem alfabética. */
const LEADING_KEYS = ["dur", "at", "curve"];
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const DISTANCE = /^(-?\d+(?:\.\d+)?)(?:px)?$/;

/** Os tipos de movimento que o inspetor edita, na ordem das linhas. Câmera só em imagem e vídeo. */
const ROWS = [
  { kind: "enter", label: "Entrada" },
  { kind: "exit", label: "Saída" },
  { kind: "emphasis", label: "Ênfase" },
  { kind: "camera", label: "Câmera" },
];

function infoOf(name, presets) {
  const info = presets.find((preset) => preset.name === name);
  if (info === undefined) throw new Error(`preset desconhecido: ${JSON.stringify(name)}`);
  return info;
}

/** `true` quando `text` vale o padrão da chave (então o atributo fica mais curto sem mudar o resultado). */
function isDefault(spec, text) {
  if (spec === undefined || spec.default === null) return false;
  switch (spec.type) {
    case "seconds":
    case "number":
    case "int":
      return NUMBER.test(text) && Number(text) === spec.default;
    case "distance": {
      const match = DISTANCE.exec(text);
      return match !== null && Number(match[1]) === spec.default;
    }
    case "anchor":
      return text === spec.default || (NUMBER.test(text) && NUMBER.test(String(spec.default)) && Number(text) === Number(spec.default));
    default:
      return text === spec.default;
  }
}

/**
 * `preset chave=valor ...`: `dur`, `at`, `curve` e depois as demais em ordem alfabética.
 * Valor vazio ou igual ao padrão do preset é omitido. `presets` é a lista do tipo (`/api/motion/presets`).
 */
export function formatMotionAttr(preset, params, presets) {
  const info = infoOf(preset, presets);
  const keys = Object.keys(params).filter((key) => {
    const value = params[key];
    return typeof value === "string" && value !== "" && !isDefault(info.keys[key], value);
  });
  const rank = (key) => {
    const at = LEADING_KEYS.indexOf(key);
    return at < 0 ? LEADING_KEYS.length : at;
  };
  keys.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return [preset, ...keys.map((key) => `${key}=${params[key]}`)].join(" ");
}

/** Lê `preset chave=valor ...`. Falha alto: o texto vem do servidor, já com a sintaxe conferida. */
function parseAttr(text) {
  const tokens = text.trim().split(/\s+/).filter((token) => token !== "");
  if (tokens.length === 0) throw new Error("atributo de motion vazio");
  const params = {};
  for (const token of tokens.slice(1)) {
    const at = token.indexOf("=");
    if (at < 1) throw new Error(`parâmetro sem "=": ${JSON.stringify(token)}`);
    params[token.slice(0, at)] = token.slice(at + 1);
  }
  return { preset: tokens[0], params };
}

/**
 * Troca o preset mantendo `dur`, `at` e `curve` e largando as chaves que o novo preset não aceita
 * (transição não tem `dur` nem `at`). `current` é o texto do atributo, ou `null` se não há nenhum;
 * `nextPreset` `null` remove o movimento e devolve `null`.
 */
export function swapPreset(current, nextPreset, presets) {
  if (nextPreset === null) return null;
  const next = infoOf(nextPreset, presets);
  const kept = {};
  if (current !== null && current !== undefined && current.trim() !== "") {
    const { params } = parseAttr(current);
    for (const key of LEADING_KEYS) {
      if (params[key] !== undefined && next.keys[key] !== undefined) kept[key] = params[key];
    }
  }
  return formatMotionAttr(nextPreset, kept, presets);
}

/* ------------------------------ DOM ------------------------------ */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const POPOVER_WIDTH = 240;
const POPOVER_MARGIN = 8;

/**
 * Seletor de preset: botão com o nome atual que abre uma lista (`role="listbox"`). Passar o mouse ou as
 * setas por um item mostra o GIF dele num popover fixo; Enter ou clique escolhe, Esc fecha.
 * `value` é o nome do preset atual ou `null`; `onPick(nome | null)` recebe a escolha.
 */
export function createPresetPicker(kind, presets, value, onPick, options = {}) {
  const root = element("div", "motion-picker");
  root.dataset.kind = kind;
  const button = element("button", "motion-picker-button");
  button.type = "button";
  button.dataset.motionPicker = kind;
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.disabled = options.disabled === true;
  const known = value === null ? undefined : presets.find((preset) => preset.name === value);
  button.textContent = value === null ? "Nenhum" : known !== undefined ? known.label : `${value} (desconhecido)`;

  const list = element("ul", "motion-picker-list");
  list.id = `motion-list-${kind}`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", options.label ?? kind);
  list.tabIndex = -1;
  list.hidden = true;
  button.setAttribute("aria-controls", list.id);

  const popover = element("div", "motion-popover");
  popover.hidden = true;
  popover.setAttribute("aria-hidden", "true");
  const preview = element("img", "motion-popover-img");
  preview.width = POPOVER_WIDTH;
  preview.alt = "";
  const caption = element("p", "motion-popover-caption");
  popover.append(preview, caption);

  const choices = [{ name: null, label: "Nenhum" }, ...presets];
  const items = choices.map((choice, index) => {
    const item = element("li", "motion-picker-item", choice.label);
    item.id = `motion-opt-${kind}-${index}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(choice.name === value));
    item.dataset.preset = choice.name ?? "";
    return item;
  });
  list.append(...items);

  let active = -1;

  function hidePopover() {
    popover.hidden = true;
    preview.removeAttribute("src");
  }

  function showPopover(item, choice) {
    if (choice.name === null) {
      hidePopover();
      return;
    }
    preview.src = `/__ff_motion/${choice.name}.gif`;
    preview.alt = `Prévia de ${choice.label}`;
    caption.textContent = choice.label;
    popover.hidden = false;
    const listBox = list.getBoundingClientRect();
    const itemBox = item.getBoundingClientRect();
    let left = listBox.right + POPOVER_MARGIN;
    if (left + POPOVER_WIDTH > window.innerWidth - POPOVER_MARGIN) left = listBox.left - POPOVER_MARGIN - POPOVER_WIDTH;
    popover.style.left = `${Math.max(POPOVER_MARGIN, left)}px`;
    popover.style.top = `${Math.max(POPOVER_MARGIN, Math.min(itemBox.top, window.innerHeight - 260))}px`;
  }

  function highlight(index) {
    if (index < 0 || index >= items.length) return;
    active = index;
    items.forEach((item, at) => item.classList.toggle("is-active", at === index));
    list.setAttribute("aria-activedescendant", items[index].id);
    items[index].scrollIntoView({ block: "nearest" });
    showPopover(items[index], choices[index]);
  }

  function onOutside(event) {
    if (!root.contains(event.target)) close(false);
  }

  function close(refocus) {
    if (list.hidden) return;
    list.hidden = true;
    hidePopover();
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    if (refocus) button.focus();
  }

  function open() {
    if (!list.hidden || button.disabled) return;
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    list.focus();
    const current = choices.findIndex((choice) => choice.name === value);
    highlight(current < 0 ? 0 : current);
  }

  function pick(index) {
    const choice = choices[index];
    close(true);
    if (choice.name !== value) onPick(choice.name);
  }

  button.addEventListener("click", () => (list.hidden ? open() : close(true)));
  button.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      // O Studio usa Espaço e setas como atalhos globais; aqui eles abrem a lista.
      event.preventDefault();
      event.stopPropagation();
      open();
    }
  });

  list.addEventListener("keydown", (event) => {
    const handled = {
      ArrowDown: () => highlight(Math.min(active + 1, items.length - 1)),
      ArrowUp: () => highlight(Math.max(active - 1, 0)),
      Home: () => highlight(0),
      End: () => highlight(items.length - 1),
      Enter: () => pick(active < 0 ? 0 : active),
      " ": () => pick(active < 0 ? 0 : active),
      Escape: () => close(true),
      Tab: () => close(false),
    }[event.key];
    if (handled === undefined) return;
    if (event.key !== "Tab") event.preventDefault();
    event.stopPropagation();
    handled();
  });
  list.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget)) close(false);
  });
  items.forEach((item, index) => {
    item.addEventListener("mouseenter", () => highlight(index));
    item.addEventListener("click", () => pick(index));
  });

  root.append(button, list, popover);
  return root;
}

/** Campo de texto que grava ao confirmar (Enter ou sair do campo); `commit(texto)` recebe o valor limpo. */
function textField(label, value, placeholder, disabled, commit, clean = (text) => text) {
  const wrap = element("label", "motion-field");
  wrap.append(element("span", undefined, label));
  const input = element("input");
  input.type = "text";
  input.value = value;
  input.dataset.committed = value;
  input.placeholder = placeholder;
  input.disabled = disabled;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    } else if (event.key === "Escape") {
      input.value = input.dataset.committed ?? "";
      input.blur();
    }
  });
  input.addEventListener("change", () => {
    const next = clean(input.value.trim());
    input.value = next;
    if (next === input.dataset.committed) return;
    input.dataset.committed = next;
    commit(next);
  });
  wrap.append(input);
  return wrap;
}

/** Há uma edição em andamento neste campo? Então o Studio não pode reescrever a seção por cima. */
function editingIn(container) {
  const focused = document.activeElement;
  return (
    focused instanceof HTMLInputElement &&
    container.contains(focused) &&
    focused.dataset.committed !== undefined &&
    focused.value !== focused.dataset.committed
  );
}

/**
 * Seção "Movimento" do inspetor: uma linha por tipo (Entrada, Saída, Ênfase e, em imagem ou vídeo, Câmera)
 * com o seletor de preset e os campos `dur` e `curve`. Cada mudança chama
 * `onChange({ attribute: "data-enter", value: "subir dur=0.8" | null })`; o servidor valida e grava.
 * `presets` é o corpo de `GET /api/motion/presets`. Áudio não tem imagem e esconde a seção.
 */
export function renderMotionSection(container, clip, presets, onChange) {
  container.hidden = clip.tag === "audio";
  if (container.hidden || editingIn(container)) return;
  const refocus = container.contains(document.activeElement) ? document.activeElement.dataset.motionPicker : undefined;
  container.dataset.clipId = clip.id;
  container.replaceChildren(element("h3", "motion-heading", "Movimento"));
  const locked = clip.editable !== true;
  const motion = clip.motion ?? {};

  for (const { kind, label } of ROWS) {
    if (kind === "camera" && clip.tag !== "img" && clip.tag !== "video") continue;
    const list = presets[kind] ?? [];
    const entry = motion[kind] ?? null;
    const preset = entry === null ? null : entry.preset;
    const info = preset === null ? undefined : list.find((item) => item.name === preset);
    const row = element("div", "motion-row");
    row.dataset.kind = kind;
    row.append(element("span", "motion-row-label", label));
    row.append(
      createPresetPicker(
        kind,
        list,
        preset,
        (next) => onChange({ attribute: `data-${kind}`, value: swapPreset(entry === null || preset === null ? null : entry.raw, next, list) }),
        { disabled: locked, label },
      ),
    );

    // Campos só para preset conhecido: com texto inválido o autor corrige no HTML (o contrato aponta o erro).
    if (entry !== null && info !== undefined) {
      const params = entry.params;
      const write = (key, value) => {
        const next = { ...params };
        if (value === "") delete next[key];
        else next[key] = value;
        const text = formatMotionAttr(preset, next, list);
        if (text !== formatMotionAttr(preset, params, list)) onChange({ attribute: `data-${kind}`, value: text });
      };
      const fields = element("div", "motion-fields");
      if (info.keys.dur !== undefined) {
        const dur = info.keys.dur.default;
        fields.append(textField("dur", params.dur ?? "", dur === null ? "até o fim" : String(dur), locked, (text) => write("dur", text)));
      }
      fields.append(textField("curve", params.curve ?? "", info.keys.curve.default, locked, (text) => write("curve", text), (text) => text.replace(/\s+/g, "")));
      row.append(fields);
    }
    if (entry !== null) row.append(element("code", "motion-raw", entry.raw));
    container.append(row);
  }
  if (locked) container.append(element("p", "motion-note", "Clip sem data-clip-id explícito: edite o movimento no HTML."));

  if (refocus !== undefined) container.querySelector(`[data-motion-picker="${refocus}"]`)?.focus();
}

/* ------------------------- Transição (EDT-54) ------------------------- */

/** Sobreposição inicial ao criar uma transição, em segundos. */
export const DEFAULT_TRANSITION_DUR = 0.5;
const ADJACENT_EPS = 1e-6;

/**
 * Clip A com o qual `clip` (B) pode ter transição: o parceiro já declarado (`motion.transition.partner`)
 * ou o irmão anterior que termina exatamente onde B começa. `null` quando não há. Só olha a raiz
 * (`parentId` igual) e exige A antes de B; quem decide de verdade é o servidor (`E_TRANSITION_GAP`).
 */
export function transitionPartner(clips, clip) {
  const declared = clip.motion?.transition?.partner ?? null;
  if (declared !== null) return clips.find((item) => item.id === declared) ?? null;
  if (clip.start === null || clip.parentId !== null) return null;
  const before = clips.filter(
    (item) =>
      item.id !== clip.id &&
      item.parentId === null &&
      item.start !== null &&
      item.end !== null &&
      item.start < clip.start &&
      Math.abs(item.end - clip.start) <= ADJACENT_EPS,
  );
  return before.length === 0 ? null : before[before.length - 1];
}

/**
 * Parâmetros que sobram ao trocar de preset (só os que o novo aceita, com valor permitido) sem os vazios
 * e sem os iguais ao padrão. `presets` é a lista do tipo `transition`.
 */
export function transitionParams(preset, params, presets) {
  const info = infoOf(preset, presets);
  const kept = {};
  for (const [key, value] of Object.entries(params)) {
    const spec = info.keys[key];
    if (spec === undefined || typeof value !== "string" || value === "" || isDefault(spec, value)) continue;
    if (Array.isArray(spec.values) && !spec.values.includes(value)) continue;
    kept[key] = value;
  }
  return kept;
}

/**
 * Seção "Transição": seletor de preset (só os do tipo `transition`), `dur` (a sobreposição com A, em
 * segundos) e `dir` quando o preset aceita. Aparece só se B já tem transição ou há um irmão anterior
 * encostado nele. `onChange({ preset: nome | null, dur?, params? })` vira `POST /api/clips/<id>/transition`.
 */
export function renderTransitionSection(container, clip, clips, presets, onChange) {
  const partner = clip.tag === "audio" ? null : transitionPartner(clips, clip);
  const entry = clip.motion?.transition ?? null;
  container.hidden = partner === null && entry === null;
  if (container.hidden || editingIn(container)) return;
  const refocus = container.contains(document.activeElement) ? document.activeElement.dataset.motionPicker : undefined;
  container.dataset.clipId = clip.id;
  container.replaceChildren(element("h3", "motion-heading", "Transição"));
  const locked = clip.editable !== true;
  const list = presets.transition ?? [];
  const preset = entry === null ? null : entry.preset;
  const info = preset === null ? undefined : list.find((item) => item.name === preset);
  const dur = entry !== null && typeof entry.dur === "number" ? entry.dur : DEFAULT_TRANSITION_DUR;

  const row = element("div", "motion-row");
  row.dataset.kind = "transition";
  row.append(element("span", "motion-row-label", partner === null ? "Com o clip anterior" : `Com ${partner.id}`));
  row.append(
    createPresetPicker(
      "transition",
      list,
      preset,
      (next) => {
        if (next === null) onChange({ preset: null });
        else onChange({ preset: next, dur, params: transitionParams(next, entry === null ? {} : entry.params, list) });
      },
      { disabled: locked, label: "Transição" },
    ),
  );

  if (entry !== null && info !== undefined) {
    const params = entry.params;
    const fields = element("div", "motion-fields");
    fields.append(
      textField("dur", String(dur), String(DEFAULT_TRANSITION_DUR), locked, (text) => onChange({ preset, dur: Number(text), params })),
    );
    if (info.keys.dir !== undefined) {
      fields.append(
        textField("dir", params.dir ?? "", String(info.keys.dir.default), locked, (text) => {
          const next = { ...params };
          if (text === "") delete next.dir;
          else next.dir = text;
          onChange({ preset, dur, params: transitionParams(preset, next, list) });
        }, (text) => text.replace(/\s+/g, "")),
      );
    }
    row.append(fields);
    row.append(element("code", "motion-raw", entry.raw));
  }
  container.append(row);
  if (locked) container.append(element("p", "motion-note", "Clip sem data-clip-id explícito: edite a transição no HTML."));
  if (refocus !== undefined) container.querySelector(`[data-motion-picker="${refocus}"]`)?.focus();
}

/* ------------------------- Keyframes (EDT-47) ------------------------- */

/** Propriedades que o inspetor deixa animar por keyframe, na ordem do seletor. */
export const KEYFRAME_PROPS = [
  { prop: "opacity", label: "Opacidade" },
  { prop: "x", label: "Posição X" },
  { prop: "y", label: "Posição Y" },
  { prop: "scale", label: "Escala" },
  { prop: "rotate", label: "Rotação" },
  { prop: "blur", label: "Desfoque" },
  { prop: "clip", label: "Recorte" },
  { prop: "volume", label: "Volume" },
  { prop: "zoom", label: "Zoom", camera: true },
  { prop: "focusX", label: "Foco X", camera: true },
  { prop: "focusY", label: "Foco Y", camera: true },
];

/** Sugestões do campo de curva (as mesmas que o contrato aceita por nome). */
export const KEYFRAME_CURVES = ["linear", "suave", "freio", "arranque", "vaivem", "mola", "mola-firme"];

const SAME_TIME = 0.0005;
const POINT_META = new Set(["time", "curve"]);

/** Propriedades que valem para `clip`: volume só com áudio; zoom e foco só em imagem e vídeo. */
export function keyframePropsFor(clip) {
  const camera = clip.tag === "img" || clip.tag === "video";
  return KEYFRAME_PROPS.filter((item) => (item.prop === "volume" ? clip.hasAudio === true : item.camera === true ? camera : true));
}

/** Rótulo curto da propriedade para a lista de pontos. */
function propLabel(prop) {
  if (prop === "scaleX") return "Escala X";
  if (prop === "scaleY") return "Escala Y";
  return KEYFRAME_PROPS.find((item) => item.prop === prop)?.label ?? prop;
}

/**
 * Valor digitado → valor do keyframe: `clip` fica texto, o resto vira número. `null` quando não é número
 * (o campo volta ao valor anterior em vez de mandar lixo ao servidor).
 */
export function parseKeyframeValue(prop, text) {
  if (prop === "clip") return text === "" ? null : text;
  if (text === "" || !NUMBER.test(text)) return null;
  return Number(text);
}

/**
 * Marcas dos keyframes de um clip para a timeline: uma por tempo distinto, com as propriedades do ponto.
 * `timeToX(tempoLocal)` é a régua da timeline (o chamador decide a unidade); só as marcas do próprio clip
 * (`clip.keyframes`) são editáveis, as dos descendentes (`clip.descendantKeyframeTimes`) vêm `readOnly`.
 * Ordem por tempo; descendente que cai no mesmo tempo de um ponto próprio não ganha marca extra.
 */
export function keyframeMarks(clip, timeToX) {
  const marks = [];
  for (const point of clip.keyframes ?? []) {
    const props = Object.keys(point).filter((key) => !POINT_META.has(key) && point[key] !== undefined);
    const same = marks.find((mark) => Math.abs(mark.time - point.time) <= SAME_TIME);
    if (same !== undefined) {
      for (const prop of props) if (!same.props.includes(prop)) same.props.push(prop);
      if (same.curve === null && typeof point.curve === "string") same.curve = point.curve;
      continue;
    }
    marks.push({ time: point.time, x: timeToX(point.time), props, curve: typeof point.curve === "string" ? point.curve : null, readOnly: false });
  }
  for (const time of clip.descendantKeyframeTimes ?? []) {
    if (marks.some((mark) => Math.abs(mark.time - time) <= SAME_TIME)) continue;
    marks.push({ time, x: timeToX(time), props: [], curve: null, readOnly: true });
  }
  return marks.sort((a, b) => a.time - b.time);
}

function formatTime(time) {
  return `${Math.round(time * 1000) / 1000}s`;
}

/**
 * Seção "Keyframes": seletor de propriedade, "Adicionar no playhead" e, com um ponto selecionado, os campos
 * de valor e de curva e o botão Remover. Só o clip tem keyframes editáveis; os dos descendentes aparecem
 * como marcas cinzas na timeline. `options`: `{ playhead, selected, prop, onProp, onAdd, onSelect, onEdit,
 * onRemove }`. `playhead` é o tempo da composição (s); `selected` é o tempo local do ponto ou `null`.
 */
export function renderKeyframeSection(container, clip, options) {
  container.hidden = clip.start === null;
  if (container.hidden || editingIn(container)) return;
  container.dataset.clipId = clip.id;
  container.replaceChildren(element("h3", "motion-heading", "Keyframes"));
  const locked = clip.editable !== true;
  const props = keyframePropsFor(clip);
  const chosen = props.some((item) => item.prop === options.prop) ? options.prop : props[0].prop;
  const local = options.playhead - clip.start;
  const inside = clip.duration !== null && local >= -SAME_TIME && local <= clip.duration + SAME_TIME;

  const row = element("div", "kf-add");
  const select = element("select", "kf-prop");
  select.setAttribute("aria-label", "Propriedade do keyframe");
  select.disabled = locked;
  for (const item of props) {
    const option = element("option", undefined, item.label);
    option.value = item.prop;
    option.selected = item.prop === chosen;
    select.append(option);
  }
  select.addEventListener("change", () => options.onProp(select.value));
  // O Studio usa Espaço e setas como atalhos globais; no seletor eles pertencem a ele.
  select.addEventListener("keydown", (event) => event.stopPropagation());
  const add = element("button", "kf-add-button", "Adicionar no playhead");
  add.type = "button";
  add.disabled = locked || !inside;
  add.title = inside ? "Atalho: K" : "Posicione o playhead dentro do clip";
  add.addEventListener("click", () => options.onAdd(chosen));
  row.append(select, add);
  container.append(row);

  const points = clip.keyframes ?? [];
  const list = element("div", "kf-list");
  for (const point of points) {
    const item = element("button", "kf-item");
    item.type = "button";
    item.dataset.time = String(point.time);
    const selected = options.selected !== null && Math.abs(options.selected - point.time) <= SAME_TIME;
    item.classList.toggle("is-selected", selected);
    const names = Object.keys(point).filter((key) => !POINT_META.has(key) && point[key] !== undefined);
    item.textContent = `${formatTime(point.time)} · ${names.map(propLabel).join(", ")}`;
    item.addEventListener("click", () => options.onSelect(selected ? null : point.time));
    list.append(item);
  }
  if (points.length === 0) list.append(element("p", "motion-note", "Nenhum keyframe. Posicione o playhead e use Adicionar."));
  container.append(list);

  const point = options.selected === null ? undefined : points.find((item) => Math.abs(item.time - options.selected) <= SAME_TIME);
  if (point !== undefined) {
    const detail = element("div", "kf-detail");
    const fields = element("div", "motion-fields");
    for (const key of Object.keys(point)) {
      if (POINT_META.has(key) || point[key] === undefined) continue;
      fields.append(
        textField(propLabel(key), String(point[key]), "", locked, (text) => {
          const value = parseKeyframeValue(key, text);
          if (value !== null) options.onEdit({ time: point.time, prop: key, value });
        }),
      );
    }
    const curveField = textField("Curva", point.curve ?? "", "linear", locked, (text) =>
      options.onEdit({ time: point.time, curve: text === "" ? null : text }), (text) => text.replace(/\s+/g, ""));
    curveField.querySelector("input").setAttribute("list", "ffKeyframeCurves");
    fields.append(curveField);
    const curves = element("datalist");
    curves.id = "ffKeyframeCurves";
    for (const name of KEYFRAME_CURVES) {
      const option = element("option");
      option.value = name;
      curves.append(option);
    }
    const remove = element("button", "kf-remove-button", "Remover keyframe");
    remove.type = "button";
    remove.disabled = locked;
    remove.title = "Atalho: Delete";
    remove.addEventListener("click", () => options.onRemove(point.time));
    detail.append(fields, curves, remove);
    container.append(detail);
  }

  if ((clip.descendantKeyframeTimes ?? []).length > 0) {
    container.append(element("p", "motion-note", "Marcas cinzas na timeline: keyframes de elementos internos, só leitura."));
  }
  if (locked) container.append(element("p", "motion-note", "Clip sem data-clip-id explícito: edite os keyframes no HTML."));
}
