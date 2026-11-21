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
