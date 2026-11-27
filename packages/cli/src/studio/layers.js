// FrankFrames — proprietário. Ver LICENSE na raiz.
const MARKER = "data-ff-studio-layer";
const PROPERTIES = [
  ["font-size", "Tamanho da fonte", "px"],
  ["color", "Cor do texto"],
  ["background-color", "Cor de fundo"],
  ["opacity", "Opacidade (0 a 1)"],
  ["width", "Largura", "px"],
  ["height", "Altura", "px"],
  ["transform", "Transformação (CSS)"],
  ["font-family", "Fonte"],
  ["font-weight", "Peso da fonte"],
  ["border", "Borda"],
  ["border-radius", "Raio da borda", "px"],
];

function declarations(value) {
  const element = document.createElement("span");
  element.style.cssText = value;
  return element.style;
}

function px(value) {
  return Math.round(value * 100) / 100 + "px";
}

function styleProperty(property, element) {
  if (property === "opacity" && /"p":"opacity"/.test(element?.getAttribute("data-ff-motion") ?? "")) {
    return "--ff-layer-opacity";
  }
  return property;
}

export function createLayerEditor({ player, button, panel, overlay, outline, save, dirtyChanged, showDiagnostics }) {
  const picker = panel.querySelector("#layerPicker");
  const fields = panel.querySelector("#layerProperties");
  const textFields = panel.querySelector("#layerTextFields");
  const raw = panel.querySelector("#layerCss");
  const apply = panel.querySelector("#layerApply");
  const inputs = new Map();
  let active = false;
  let dirty = false;
  let saving = false;
  let request = 0;
  let layers = [];
  let selected = null;
  let clipId = null;
  let drag = null;

  for (const [property, title, unit] of PROPERTIES) {
    const label = document.createElement("label");
    label.textContent = title;
    const input = document.createElement("input");
    input.type = "text";
    input.spellcheck = false;
    input.dataset.layerProperty = property;
    label.append(input);
    fields.append(label);
    inputs.set(property, { input, unit });
  }

  function setDirty(value) {
    dirty = value;
    apply.disabled = !dirty || saving;
    panel.querySelector("#layerReset").disabled = !dirty || saving;
    dirtyChanged();
  }

  function elementFor(layer) {
    return layer === null ? null : player.contentDocument?.querySelector("[" + MARKER + '="' + CSS.escape(layer.id) + '"]') ?? null;
  }

  function hasPaint(element) {
    const css = player.contentWindow.getComputedStyle(element);
    if (css.visibility === "hidden" || Number(css.opacity) === 0) return false;
    const layer = layers.find((candidate) => candidate.id === element.getAttribute(MARKER));
    return Boolean(layer?.text.some((part) => part.text.trim())) ||
      element.matches("img,video,canvas,path,rect,circle,ellipse,line,polygon,polyline,text,use") ||
      css.backgroundImage !== "none" || css.backgroundColor !== "rgba(0, 0, 0, 0)" ||
      css.boxShadow !== "none" || parseFloat(css.borderTopWidth) > 0 || parseFloat(css.borderRightWidth) > 0 ||
      parseFloat(css.borderBottomWidth) > 0 || parseFloat(css.borderLeftWidth) > 0;
  }

  function updatePlaceholders() {
    const element = elementFor(selected);
    const computed = element ? player.contentWindow.getComputedStyle(element) : null;
    for (const [property, { input }] of inputs) {
      input.placeholder = computed?.getPropertyValue(property) ?? "";
    }
  }

  function renderFields() {
    const element = elementFor(selected);
    const style = declarations(selected?.style ?? "");
    fields.hidden = selected === null;
    textFields.replaceChildren(...(selected?.text ?? []).map(({ index, text }) => {
      const label = document.createElement("label");
      label.className = "text-field";
      label.textContent = "Texto";
      const field = document.createElement("textarea");
      field.rows = 2;
      field.dataset.index = String(index);
      field.defaultValue = text;
      label.append(field);
      return label;
    }));
    for (const [property, { input }] of inputs) {
      input.defaultValue = style.getPropertyValue(styleProperty(property, element));
      input.value = input.defaultValue;
    }
    raw.defaultValue = selected?.style ?? "";
    raw.value = raw.defaultValue;
    raw.disabled = selected === null;
    updatePlaceholders();
    paint();
  }

  function pick(id) {
    selected = layers.find((layer) => layer.id === id) ?? null;
    picker.value = selected?.id ?? "";
    showDiagnostics([]);
    setDirty(false);
    renderFields();
  }

  async function refresh() {
    if (!active || dirty || drag || saving) return;
    const latest = ++request;
    try {
      const response = await fetch("/api/layers", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const payload = await response.json();
      if (request !== latest || !active || dirty || drag || saving) return;
      const next = payload.layers;
      const changed = next.length !== layers.length || next.some((layer, index) =>
        layer.id !== layers[index].id || layer.label !== layers[index].label || layer.depth !== layers[index].depth);
      layers = next;
      if (changed || picker.options.length === 0) {
        const options = layers.map((layer) => new Option("— ".repeat(layer.depth) + layer.label, layer.id));
        picker.replaceChildren(new Option("Selecione uma camada", ""), ...options);
      }
      const old = selected;
      const match = old === null ? null : layers.find((layer) => layer.id === old.id && layer.sourceId === old.sourceId);
      if (match && old !== null && old.style === match.style && old.text.length === match.text.length &&
        old.text.every((part, index) => part.index === match.text[index].index && part.text === match.text[index].text)) {
        // O preview também recarrega depois de uma edição em outra camada: não substitua campos em uso.
        selected = match;
        picker.value = match.id;
        updatePlaceholders();
        paint();
      } else {
        pick(match?.id ?? layers.find((layer) => clipId !== null && layer.clipId === clipId)?.id ?? "");
      }
    } catch (error) {
      if (request === latest && active) showDiagnostics([{ severity: "error", message: "Camadas indisponíveis: " + error.message }]);
    }
  }

  function sync(id) {
    const changed = clipId !== id;
    clipId = id;
    if (!active || !changed || dirty || saving) return;
    pick(layers.find((layer) => id !== null && layer.clipId === id)?.id ?? "");
    refresh();
  }

  function scale() {
    const area = overlay.getBoundingClientRect();
    return { area, x: area.width / player.offsetWidth, y: player.getBoundingClientRect().height / player.offsetHeight };
  }

  function paint() {
    if (!active) return;
    const element = elementFor(selected);
    const rect = element?.getBoundingClientRect();
    const { x, y } = scale();
    const bar = player.contentDocument?.querySelector("[data-ff-ui]");
    if (bar) overlay.style.bottom = (bar.getBoundingClientRect().height * y) + "px";
    outline.hidden = !rect || rect.width <= 0 || rect.height <= 0;
    if (!outline.hidden) {
      outline.style.left = rect.left * x + "px";
      outline.style.top = rect.top * y + "px";
      outline.style.width = rect.width * x + "px";
      outline.style.height = rect.height * y + "px";
    }
  }

  async function persist(style, text = []) {
    if (saving || selected === null) return false;
    saving = true;
    apply.disabled = true;
    panel.setAttribute("aria-busy", "true");
    try {
      const changes = { id: selected.id, revision: selected.revision };
      if (style !== undefined) changes.style = style;
      if (text.length > 0) changes.text = text;
      const revision = await save(changes);
      if (revision === null) return false;
      for (const layer of layers) {
        if (layer.sourceId === selected.sourceId) layer.revision = revision;
        if (layer.id === selected.id) {
          if (style !== undefined) layer.style = style;
          if (text.length > 0) layer.text = layer.text.map((part) => text.find((edit) => edit.index === part.index) ?? part);
        }
      }
      setDirty(false);
      renderFields();
    } finally {
      saving = false;
      apply.disabled = !dirty;
      panel.removeAttribute("aria-busy");
    }
    await refresh();
    return true;
  }

  function submit(event) {
    event.preventDefault();
    if (!dirty || !selected) return;
    const rawChanged = raw.value !== raw.defaultValue;
    const style = declarations(raw.value);
    const element = elementFor(selected);
    const invalid = [];
    let editedStyle = false;
    for (const [property, { input, unit }] of inputs) {
      if (input.value === input.defaultValue) continue;
      let value = input.value.trim();
      if (unit && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && value !== "0") value += unit;
      const name = styleProperty(property, element);
      const invalidOpacity = name === "--ff-layer-opacity" && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1);
      if (value !== "" && (!CSS.supports(property, value) || invalidOpacity)) {
        invalid.push({ severity: "error", message: input.parentElement.textContent + ": valor CSS inválido." });
        continue;
      }
      const priority = style.getPropertyPriority(name);
      style.removeProperty(name);
      if (value !== "") style.setProperty(name, value, priority);
      editedStyle = true;
    }
    if (invalid.length) {
      showDiagnostics(invalid);
      return;
    }
    const text = [...textFields.querySelectorAll("textarea")].filter((field) => field.value !== field.defaultValue)
      .map((field) => ({ index: Number(field.dataset.index), original: field.defaultValue, text: field.value }));
    if (!editedStyle && !rawChanged && text.length === 0) {
      setDirty(false);
      return;
    }
    persist(editedStyle ? style.cssText : rawChanged ? raw.value : undefined, text);
  }

  function pointerDown(event) {
    if (event.button !== 0 || saving || dirty) return;
    const { area, x, y } = scale();
    if (!(x > 0 && y > 0)) return;
    const corner = event.altKey ? null : event.target.closest("[data-corner]")?.dataset.corner ?? null;
    const hits = player.contentDocument?.elementsFromPoint((event.clientX - area.left) / x, (event.clientY - area.top) / y)
      .map((element) => element.closest("[" + MARKER + "]")).filter(Boolean) ?? [];
    const distinct = [...new Set(hits)];
    const behind = event.altKey ? distinct.indexOf(elementFor(selected)) + 1 : 0;
    const hit = event.altKey ? distinct[behind % distinct.length] : distinct.find(hasPaint) ?? distinct[0];
    const id = corner === null ? hit?.getAttribute(MARKER) : selected?.id;
    if (!id) return;
    if (selected?.id !== id) pick(id);
    if (event.altKey) return;
    const element = elementFor(selected);
    if (!element?.style) return;
    const computed = player.contentWindow.getComputedStyle(element);
    const base = declarations(selected.style).transform || computed.transform;
    const shift = /^translate\(([+\d.-]+)px,\s*([+\d.-]+)px\)\s*/.exec(base);
    drag = {
      element, corner, x, y, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      tx: shift ? Number(shift[1]) : 0, ty: shift ? Number(shift[2]) : 0,
      transform: shift ? base.slice(shift[0].length) : base === "none" ? "" : base,
      width: parseFloat(computed.width) || element.getBoundingClientRect().width,
      height: parseFloat(computed.height) || element.getBoundingClientRect().height,
      inline: computed.display === "inline", saved: new Map(), changes: {},
    };
    event.preventDefault();
    overlay.setPointerCapture(event.pointerId);
  }

  function pointerMove(event) {
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const sx = event.clientX - drag.clientX;
    const sy = event.clientY - drag.clientY;
    if (Math.hypot(sx, sy) < 2 && Object.keys(drag.changes).length === 0) return;
    const dx = sx / drag.x;
    const dy = sy / drag.y;
    const changes = {};
    if (drag.inline) changes.display = "inline-block";
    let tx = dx;
    let ty = dy;
    if (drag.corner !== null) {
      const west = drag.corner.includes("w");
      const north = drag.corner.includes("n");
      const width = Math.max(1, drag.width + (west ? -dx : dx));
      const height = Math.max(1, drag.height + (north ? -dy : dy));
      changes.width = px(width);
      changes.height = px(height);
      tx = west ? drag.width - width : 0;
      ty = north ? drag.height - height : 0;
    }
    if (tx !== 0 || ty !== 0 || Object.hasOwn(drag.changes, "transform")) {
      changes.transform = `translate(${px(drag.tx + tx)}, ${px(drag.ty + ty)})${drag.transform ? " " + drag.transform : ""}`;
    }
    const style = drag.element.style;
    for (const [name, value] of Object.entries(changes)) {
      if (!drag.saved.has(name)) drag.saved.set(name, [style.getPropertyValue(name), style.getPropertyPriority(name)]);
      style.setProperty(name, value, drag.saved.get(name)[1]);
    }
    drag.changes = changes;
    paint();
  }

  function pointerEnd(event) {
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const { element, saved, changes } = drag;
    drag = null;
    const restore = () => {
      for (const [name, [value, priority]] of saved) {
        if (value === "") element.style.removeProperty(name);
        else element.style.setProperty(name, value, priority);
      }
      paint();
    };
    if (event.type === "pointerup" && saved.size > 0 && selected !== null) {
      const style = declarations(selected.style);
      for (const [name, value] of Object.entries(changes)) style.setProperty(name, value, style.getPropertyPriority(name));
      persist(style.cssText).then((ok) => { if (!ok) restore(); });
    } else restore();
  }

  button.addEventListener("click", () => {
    if (saving || dirty || drag) return;
    active = !active;
    button.setAttribute("aria-pressed", String(active));
    overlay.hidden = !active;
    panel.hidden = !active;
    if (active) {
      panel.parentElement.scrollTop = 0;
      const play = player.contentDocument?.querySelector("[data-ff-play]");
      if (play?.textContent === "pause") play.click();
      refresh();
    }
  });
  picker.addEventListener("change", () => {
    if (dirty || saving) {
      picker.value = selected?.id ?? "";
      return;
    }
    pick(picker.value);
  });
  panel.addEventListener("input", (event) => {
    if (event.target.matches("input, textarea")) setDirty(true);
  });
  panel.addEventListener("submit", submit);
  panel.querySelector("#layerReset").addEventListener("click", () => {
    if (!saving) pick(selected?.id ?? "");
  });
  overlay.addEventListener("pointerdown", pointerDown);
  overlay.addEventListener("pointermove", pointerMove);
  overlay.addEventListener("pointerup", pointerEnd);
  overlay.addEventListener("pointercancel", pointerEnd);
  player.addEventListener("load", refresh);
  return { sync, refresh, paint, dirty: () => dirty };
}
