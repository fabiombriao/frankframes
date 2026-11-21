import { lastFrameTime, percentSpan } from "/timeline-math.js";
import { renderMotionSection, renderTransitionSection } from "/motion.js";

(() => {
  "use strict";

  const SNAP = 0.05;
  const MIN_DURATION = 0.1;
  const FRAME_POLL_MS = 100;
  const PLAYER_WIDTH = 1920;
  const PLAYER_HEIGHT = 1080;

  const fileNameEl = document.getElementById("fileName");
  const totalDurationEl = document.getElementById("totalDuration");
  const compositionFpsEl = document.getElementById("compositionFps");
  const connectionEl = document.getElementById("connection");
  const player = document.getElementById("player");
  const playerFrame = document.getElementById("playerFrame");
  const inspector = document.getElementById("inspector");
  const inspectorEmpty = document.getElementById("inspectorEmpty");
  const clipTagEl = document.getElementById("clipTag");
  const clipIdEl = document.getElementById("clipId");
  const fieldStart = document.getElementById("fieldStart");
  const fieldDuration = document.getElementById("fieldDuration");
  const fieldOffset = document.getElementById("fieldOffset");
  const fieldVolume = document.getElementById("fieldVolume");
  const fieldRole = document.getElementById("fieldRole");
  const fieldRate = document.getElementById("fieldRate");
  const fieldText = document.getElementById("fieldText");
  const applyButton = document.getElementById("applyButton");
  const compositionDiagnostics = document.getElementById("compositionDiagnostics");
  const inspectorDiagnostics = document.getElementById("inspectorDiagnostics");
  const motionSection = document.getElementById("motionSection");
  const transitionSection = document.getElementById("transitionSection");
  const blocksStatus = document.getElementById("blocksStatus");
  const blocksList = document.getElementById("blocksList");
  const blocksDiagnostics = document.getElementById("blocksDiagnostics");
  const ruler = document.getElementById("ruler");
  const timelinePanel = document.querySelector(".timeline-panel");
  const timelineBody = document.getElementById("timelineBody");
  const timelineRows = document.getElementById("timelineRows");
  const timelineEmpty = document.getElementById("timelineEmpty");
  const playheadEl = document.getElementById("playhead");
  const playheadTrack = document.querySelector(".playhead-track");
  const importButton = document.getElementById("importButton");
  const importInput = document.getElementById("importInput");
  const splitButton = document.getElementById("splitButton");
  const undoButton = document.getElementById("undoButton");
  const redoButton = document.getElementById("redoButton");
  const dropOverlay = document.getElementById("dropOverlay");
  const toolDiagnostics = document.getElementById("toolDiagnostics");
  /* Mesma folga do servidor: corte colado na borda geraria um pedaço vazio. */
  const MIN_SPLIT_PIECE = 0.001;

  const state = {
    clips: [],
    total: 0,
    fps: 30,
    fileName: "index.html",
    selectedId: null,
    inspectorDirty: false,
    playhead: 0,
    history: { canUndo: false, canRedo: false, undo: null, redo: null },
    busy: false,
    motionPresets: null,
  };

  let drag = null;
  let mutationQueue = Promise.resolve();

  /* Helpers */

  function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function snap(value) {
    return Math.round(value / SNAP) * SNAP;
  }

  function formatNumber(value) {
    if (value === null || value === undefined) return "";
    return String(Math.round(value * 1000) / 1000);
  }

  function formatSeconds(value) {
    return Math.round(value * 100) / 100 + "s";
  }

  function baseName(path) {
    const parts = String(path ?? "").split(/[\\/]/);
    return parts[parts.length - 1] || "index.html";
  }

  function normalizeFps(fps) {
    if (asNumber(fps)) return fps;
    if (fps && typeof fps === "object") {
      const num = asNumber(fps.num);
      const den = asNumber(fps.den);
      if (num !== null && num > 0) return num / (den !== null && den > 0 ? den : 1);
    }
    return 30;
  }

  function normalizeClip(raw, index) {
    const start = asNumber(raw.start);
    let duration = asNumber(raw.duration) ?? asNumber(raw.authoredDuration);
    const end = asNumber(raw.end);
    if (duration === null && start !== null && end !== null) duration = Math.max(0, end - start);
    const role = raw.role ?? raw.audioRole;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : "clip-" + index,
      tag: typeof raw.tag === "string" && raw.tag ? raw.tag : "div",
      start,
      duration,
      end: end !== null ? end : start !== null && duration !== null ? start + duration : null,
      offset: asNumber(raw.offset) ?? 0,
      volume: asNumber(raw.volume),
      role: role === "voice" || role === "music" || role === "sfx" ? role : null,
      playbackRate: asNumber(raw.playbackRate) ?? 1,
      text: typeof raw.text === "string" ? raw.text : null,
      track: asNumber(raw.track) ?? 0,
      kind: raw.kind === "audio" || raw.kind === "video" ? raw.kind : "text",
      hasAudio: raw.hasAudio === true,
      mediaSrc: typeof raw.mediaSrc === "string" ? raw.mediaSrc : null,
      fadeIn: asNumber(raw.fadeIn),
      fadeOut: asNumber(raw.fadeOut),
      hasKeyframes: raw.hasKeyframes === true,
      motion: raw.motion !== null && typeof raw.motion === "object" ? raw.motion : {},
      keyframes: Array.isArray(raw.keyframes) ? raw.keyframes : null,
      hasChildren: raw.hasChildren === true,
      parentId: typeof raw.parentId === "string" ? raw.parentId : null,
      editable: raw.editable === true,
    };
  }

  /* O playhead vai de 0 ao início do último frame, não ao fim da composição. */
  function maxPlayhead() {
    return state.total > 0 ? lastFrameTime(state.total, state.fps) : 0;
  }

  function findClip(id) {
    return state.clips.find((clip) => clip.id === id) ?? null;
  }

  function setConnection(text, isError) {
    connectionEl.textContent = text;
    connectionEl.classList.toggle("is-error", Boolean(isError));
    connectionEl.classList.toggle("is-live", !isError);
  }

  function renderDiagnostics(container, diagnostics) {
    container.replaceChildren();
    for (const diagnostic of diagnostics) {
      const item = document.createElement("p");
      const severity = diagnostic.severity === "warning" ? "warning" : diagnostic.severity === "info" ? "info" : "error";
      item.className = "diagnostic " + severity;
      item.textContent = diagnostic.message;
      if (diagnostic.hint) {
        const hint = document.createElement("span");
        hint.className = "hint";
        hint.textContent = diagnostic.hint;
        item.append(hint);
      }
      container.append(item);
    }
  }

  function normalizeDiagnostics(payload) {
    const output = [];
    const add = (value, forced) => {
      if (!value) return;
      if (typeof value === "string") {
        output.push({ severity: forced || "error", message: value });
        return;
      }
      if (typeof value !== "object" || typeof value.message !== "string") return;
      const severity = value.severity === "warning" ? "warning" : value.severity === "info" ? "info" : forced || "error";
      output.push({ severity, message: value.message, hint: typeof value.hint === "string" ? value.hint : undefined });
    };
    if (Array.isArray(payload)) {
      for (const entry of payload) add(entry);
    } else if (payload && typeof payload === "object") {
      for (const entry of Array.isArray(payload.diagnostics) ? payload.diagnostics : []) add(entry);
      for (const entry of Array.isArray(payload.errors) ? payload.errors : []) add(entry, "error");
      for (const entry of Array.isArray(payload.warnings) ? payload.warnings : []) add(entry, "warning");
      if (payload.ok === false) add(payload.message, "error");
    }
    return output;
  }

  async function readJson(response) {
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error("resposta inválida do servidor (HTTP " + response.status + ")");
    }
  }

  /* Composição */

  function applyComposition(payload) {
    const data = payload && typeof payload.composition === "object" && payload.composition !== null ? payload.composition : payload;
    if (!data || typeof data !== "object") throw new Error("composição inválida");

    state.fileName = baseName(data.entry ?? data.file ?? data.fileName ?? data.id);
    state.fps = normalizeFps(data.fps);
    state.clips = (Array.isArray(data.clips) ? data.clips : []).map(normalizeClip);

    const declared = asNumber(data.duration) ?? asNumber(data.seconds);
    const maxEnd = state.clips.reduce((max, clip) => (clip.end !== null && clip.end > max ? clip.end : max), 0);
    state.total = Math.max(0, declared !== null ? declared : maxEnd);
    state.playhead = clamp(state.playhead, 0, maxPlayhead());

    renderTop();
    renderTimeline();
    paintPlayhead();

    if (state.selectedId !== null && !findClip(state.selectedId)) {
      clearInspector();
    } else if (state.selectedId !== null) {
      updateSelectionStyles();
      if (!state.inspectorDirty) fillInspector();
    }
  }

  async function refreshComposition() {
    try {
      const response = await fetch("/api/composition", { cache: "no-store", headers: { accept: "application/json" } });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(payload.message || "HTTP " + response.status);
      applyComposition(payload);
      const diagnostics = arrayOrEmpty(payload.diagnostics).length
        ? normalizeDiagnostics(payload.diagnostics)
        : normalizeDiagnostics(payload.composition ? payload.composition.diagnostics : []);
      renderDiagnostics(compositionDiagnostics, diagnostics);
      setConnection("ao vivo", false);
    } catch (error) {
      setConnection("desconectado", true);
      renderDiagnostics(compositionDiagnostics, [
        { severity: "error", message: "Não foi possível carregar a composição: " + error.message },
      ]);
    }
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function renderTop() {
    fileNameEl.textContent = state.fileName;
    totalDurationEl.textContent = state.total > 0 ? formatSeconds(state.total) : "--";
    const fps = state.fps;
    compositionFpsEl.textContent = Number.isInteger(fps) ? fps + " fps" : fps.toFixed(2) + " fps";
  }

  /* Inspector */

  function clearInspector() {
    state.selectedId = null;
    state.inspectorDirty = false;
    inspector.hidden = true;
    motionSection.hidden = true;
    transitionSection.hidden = true;
    inspectorEmpty.hidden = false;
    renderDiagnostics(inspectorDiagnostics, []);
    updateSelectionStyles();
  }

  function fillInspector() {
    const clip = state.selectedId === null ? null : findClip(state.selectedId);
    if (!clip) {
      clearInspector();
      return;
    }
    inspector.hidden = false;
    inspectorEmpty.hidden = true;
    clipTagEl.textContent = clip.tag;
    clipIdEl.textContent = clip.id;
    fieldStart.value = formatNumber(clip.start);
    fieldDuration.value = formatNumber(clip.duration);
    fieldOffset.value = formatNumber(clip.offset);
    fieldVolume.value = formatNumber(clip.volume);
    fieldRole.value = clip.role ?? "";
    fieldRate.value = formatNumber(clip.playbackRate);
    fieldText.value = clip.text ?? "";
    state.inspectorDirty = false;
    renderDiagnostics(inspectorDiagnostics, []);
    if (state.motionPresets === null) {
      motionSection.hidden = true;
      transitionSection.hidden = true;
    } else {
      renderMotionSection(motionSection, clip, state.motionPresets, ({ attribute, value }) => queuePatch(clip.id, { [attribute]: value }));
      renderTransitionSection(transitionSection, clip, state.clips, state.motionPresets, (change) => queueTransition(clip.id, change));
    }
  }

  async function loadMotionPresets() {
    try {
      const response = await fetch("/api/motion/presets", { cache: "no-store", headers: { accept: "application/json" } });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(payload.message || "HTTP " + response.status);
      state.motionPresets = payload;
      if (state.selectedId !== null && !state.inspectorDirty) fillInspector();
    } catch (error) {
      renderDiagnostics(toolDiagnostics, [
        { severity: "error", message: "Não foi possível carregar os presets de movimento: " + error.message },
      ]);
    }
  }

  function selectClip(id) {
    if (!findClip(id)) return;
    state.selectedId = id;
    state.inspectorDirty = false;
    updateSelectionStyles();
    fillInspector();
  }

  function updateSelectionStyles() {
    for (const bar of timelineRows.querySelectorAll(".clip-bar")) {
      bar.classList.toggle("is-selected", bar.dataset.clipId === state.selectedId);
    }
    for (const strip of timelineRows.querySelectorAll(".ff-transition")) {
      strip.classList.toggle("is-selected", strip.dataset.clipId === state.selectedId);
    }
    updateToolbar();
  }

  /* Ferramentas: importar, dividir, desfazer/refazer */

  function splittable() {
    const clip = state.selectedId === null ? null : findClip(state.selectedId);
    if (!clip || clip.start === null || clip.end === null) return null;
    const at = state.playhead;
    if (at <= clip.start + MIN_SPLIT_PIECE || at >= clip.end - MIN_SPLIT_PIECE) return null;
    return { clip, at };
  }

  function updateToolbar() {
    const history = state.history;
    undoButton.disabled = state.busy || !history.canUndo;
    redoButton.disabled = state.busy || !history.canRedo;
    undoButton.title = history.undo ? "Desfazer: " + history.undo + " (Ctrl+Z)" : "Nada para desfazer (Ctrl+Z)";
    redoButton.title = history.redo ? "Refazer: " + history.redo + " (Ctrl+Shift+Z)" : "Nada para refazer (Ctrl+Shift+Z)";
    splitButton.disabled = state.busy || splittable() === null;
    importButton.disabled = state.busy;
  }

  function applyHistory(value) {
    if (!value || typeof value !== "object") return;
    state.history = {
      canUndo: value.canUndo === true,
      canRedo: value.canRedo === true,
      undo: typeof value.undo === "string" ? value.undo : null,
      redo: typeof value.redo === "string" ? value.redo : null,
    };
    updateToolbar();
  }

  async function refreshHistory() {
    try {
      const response = await fetch("/api/history", { cache: "no-store", headers: { accept: "application/json" } });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(payload.message || "HTTP " + response.status);
      applyHistory(payload);
    } catch (error) {
      renderDiagnostics(toolDiagnostics, [
        { severity: "error", message: "Não foi possível ler o histórico: " + error.message },
      ]);
    }
  }

  /** Enfileira atrás das edições pendentes e trava as ferramentas enquanto roda. */
  function runTool(task) {
    mutationQueue = mutationQueue
      .then(async () => {
        state.busy = true;
        updateToolbar();
        try {
          await task();
        } finally {
          state.busy = false;
          updateToolbar();
        }
      })
      .catch((error) => {
        renderDiagnostics(toolDiagnostics, [{ severity: "error", message: "Falha na edição: " + error.message }]);
      });
    return mutationQueue;
  }

  function travel(direction) {
    return runTool(async () => {
      const result = await mutate("POST", "/api/" + direction, {});
      if (result.payload && result.payload.history) applyHistory(result.payload.history);
      if (!result.ok) {
        renderDiagnostics(toolDiagnostics, result.diagnostics);
        if (result.payload && result.payload.code === "E_HISTORY_STALE") await refreshHistory();
        return;
      }
      if (result.payload.changed === false) return;
      state.inspectorDirty = false;
      await refreshComposition();
    });
  }

  function splitSelected() {
    const target = splittable();
    if (target === null) {
      renderDiagnostics(toolDiagnostics, [
        {
          severity: "info",
          message: "Selecione um clip e posicione o playhead dentro dele para dividir.",
        },
      ]);
      return mutationQueue;
    }
    return runTool(async () => {
      const result = await mutate("POST", "/api/clips/" + encodeURIComponent(target.clip.id) + "/split", { at: target.at });
      if (result.payload && result.payload.history) applyHistory(result.payload.history);
      if (!result.ok) {
        renderDiagnostics(toolDiagnostics, result.diagnostics);
        return;
      }
      state.inspectorDirty = false;
      await refreshComposition();
      if (typeof result.payload.id === "string" && findClip(result.payload.id)) selectClip(result.payload.id);
      renderDiagnostics(toolDiagnostics, [
        { severity: "info", message: target.clip.id + " dividido em " + formatSeconds(target.at) + "." },
      ]);
    });
  }

  function importFiles(files) {
    const list = Array.from(files);
    if (!list.length) return mutationQueue;
    return runTool(async () => {
      let start = snap(Math.max(0, state.playhead));
      const notes = [];
      let lastId = null;
      for (const file of list) {
        notes.push({ severity: "info", message: "Enviando " + file.name + "…" });
        renderDiagnostics(toolDiagnostics, notes);
        let payload;
        let response;
        try {
          response = await fetch(
            "/api/media?name=" + encodeURIComponent(file.name) + "&start=" + encodeURIComponent(formatNumber(start)),
            { method: "POST", cache: "no-store", body: file, headers: { accept: "application/json" } },
          );
          payload = await readJson(response);
        } catch (error) {
          notes[notes.length - 1] = { severity: "error", message: file.name + ": falha de rede: " + error.message };
          break;
        }
        if (payload.history) applyHistory(payload.history);
        if (!response.ok || payload.ok === false) {
          const diagnostics = normalizeDiagnostics(payload);
          notes[notes.length - 1] = diagnostics.length
            ? { ...diagnostics[0], message: file.name + ": " + diagnostics[0].message }
            : { severity: "error", message: file.name + ": " + (payload.message || "HTTP " + response.status) };
          break;
        }
        const duration = asNumber(payload.duration) ?? 0;
        notes[notes.length - 1] = {
          severity: "info",
          message:
            file.name + " → " + payload.src + " em " + formatSeconds(start) + " (" + formatSeconds(duration) + ")" +
            (payload.reused ? ", arquivo idêntico reaproveitado" : ""),
        };
        lastId = typeof payload.id === "string" ? payload.id : lastId;
        // Vários arquivos de uma vez entram em sequência, um depois do outro.
        start = Math.round((start + duration) * 1e6) / 1e6;
      }
      state.inspectorDirty = false;
      await refreshComposition();
      if (lastId && findClip(lastId)) selectClip(lastId);
      renderDiagnostics(toolDiagnostics, notes);
    });
  }

  function hasFiles(event) {
    return Boolean(event.dataTransfer) && Array.from(event.dataTransfer.types).includes("Files");
  }

  let dragDepth = 0;

  function setDropOverlay(visible) {
    dropOverlay.hidden = !visible;
  }

  function originalFor(clip, key) {
    switch (key) {
      case "data-start":
        return clip.start;
      case "data-duration":
        return clip.duration;
      case "data-offset":
        return clip.offset;
      case "data-volume":
        return clip.volume;
      case "data-audio-role":
        return clip.role;
      case "data-playback-rate":
        return clip.playbackRate;
      default:
        return null;
    }
  }

  async function applyChanges() {
    const clip = state.selectedId === null ? null : findClip(state.selectedId);
    if (!clip) return;

    const attributes = {};
    const errors = [];
    const numericFields = [
      [fieldStart, "data-start"],
      [fieldDuration, "data-duration"],
      [fieldOffset, "data-offset"],
      [fieldVolume, "data-volume"],
      [fieldRate, "data-playback-rate"],
    ];

    for (const [element, key] of numericFields) {
      const raw = element.value.trim();
      const original = originalFor(clip, key);
      if (raw === "") {
        if (original !== null) attributes[key] = null;
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        errors.push({ severity: "error", message: key + " precisa ser um número." });
        continue;
      }
      if (original === null || Math.abs(value - original) > 1e-9) attributes[key] = String(value);
    }

    const role = fieldRole.value;
    if (role === "") {
      if (clip.role !== null) attributes["data-audio-role"] = null;
    } else if (role !== clip.role) {
      attributes["data-audio-role"] = role;
    }

    if (errors.length) {
      renderDiagnostics(inspectorDiagnostics, errors);
      return;
    }

    const textChanged = fieldText.value !== (clip.text ?? "");
    if (!Object.keys(attributes).length && !textChanged) {
      renderDiagnostics(inspectorDiagnostics, [{ severity: "info", message: "Nenhuma alteração para aplicar." }]);
      return;
    }

    const body = { attributes };
    if (textChanged) body.text = fieldText.value;

    applyButton.disabled = true;
    try {
      const result = await mutate("POST", "/api/clips/" + encodeURIComponent(clip.id), body);
      if (!result.ok) {
        renderDiagnostics(inspectorDiagnostics, result.diagnostics);
        return;
      }
      state.inspectorDirty = false;
      await refreshComposition();
      if (findClip(clip.id)) {
        state.selectedId = clip.id;
        fillInspector();
      }
      const diagnostics = result.diagnostics.length
        ? result.diagnostics
        : [{ severity: "info", message: "Alterações aplicadas." }];
      renderDiagnostics(inspectorDiagnostics, diagnostics);
    } finally {
      applyButton.disabled = false;
    }
  }

  /* Timeline */

  function chooseStep(total) {
    if (total <= 10) return 1;
    if (total <= 30) return 2;
    if (total <= 60) return 5;
    if (total <= 120) return 10;
    return Math.ceil(total / 12);
  }

  function renderRuler() {
    ruler.replaceChildren();
    if (state.total <= 0) {
      timelinePanel.style.setProperty("--tick-size", "100%");
      return;
    }
    const step = chooseStep(state.total);
    timelinePanel.style.setProperty("--tick-size", (step / state.total) * 100 + "%");
    for (let time = 0; time <= state.total + 1e-9; time += step) {
      const tick = document.createElement("div");
      tick.className = "tick";
      tick.style.left = clamp((time / state.total) * 100, 0, 100) + "%";
      const label = document.createElement("span");
      label.textContent = formatSeconds(time);
      tick.append(label);
      ruler.append(tick);
    }
  }

  function renderTimeline() {
    const scrollTop = timelineBody.scrollTop;
    timelineRows.replaceChildren();
    renderRuler();

    if (!state.clips.length) {
      timelineEmpty.hidden = false;
      timelineBody.scrollTop = 0;
      playheadTrack.style.height = "";
      return;
    }
    timelineEmpty.hidden = true;

    const ordered = [...state.clips].sort((a, b) => {
      const delta = (a.start ?? 0) - (b.start ?? 0);
      return delta !== 0 ? delta : a.id.localeCompare(b.id);
    });

    for (const clip of ordered) {
      const row = document.createElement("div");
      row.className = "timeline-row";

      const label = document.createElement("div");
      label.className = "row-label";
      const tag = document.createElement("span");
      tag.className = "row-tag";
      tag.textContent = clip.tag;
      const name = document.createElement("span");
      name.className = "row-name";
      name.textContent = clip.id;
      label.append(tag, name);

      const lane = document.createElement("div");
      lane.className = "lane";

      const bar = document.createElement("button");
      bar.type = "button";
      bar.className = "clip-bar";
      bar.dataset.clipId = clip.id;
      if (clip.start === null) bar.classList.add("is-unresolved");
      if (clip.id === state.selectedId) bar.classList.add("is-selected");
      bar.dataset.start = formatNumber(clip.start);
      bar.dataset.duration = formatNumber(clip.duration);
      positionBar(bar, clip);
      bar.addEventListener("pointerdown", onBarPointerDown);
      bar.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          selectClip(clip.id);
        }
      });

      if (clip.start !== null) {
        const handle = document.createElement("span");
        handle.className = "resize-handle";
        handle.dataset.handle = "resize";
        handle.setAttribute("aria-hidden", "true");
        bar.append(handle);
      }

      lane.append(bar);
      const strip = transitionStrip(clip);
      if (strip !== null) lane.append(strip);
      row.append(label, lane);
      timelineRows.append(row);
    }

    timelineBody.scrollTop = scrollTop;
    playheadTrack.style.height = Math.max(timelineBody.clientHeight, timelineRows.scrollHeight) + "px";
  }

  /* Faixa hachurada da transição: largura = sobreposição (dur), no começo da barra de B. */
  function transitionStrip(clip) {
    const entry = clip.motion.transition;
    if (!entry || typeof entry.dur !== "number" || entry.dur <= 0 || clip.start === null) return null;
    const strip = document.createElement("button");
    strip.type = "button";
    strip.className = "ff-transition";
    strip.dataset.clipId = clip.id;
    if (clip.id === state.selectedId) strip.classList.add("is-selected");
    positionStrip(strip, clip);
    strip.addEventListener("click", () => {
      selectClip(clip.id);
      transitionSection.scrollIntoView({ block: "nearest", behavior: "smooth" });
      transitionSection.querySelector("[data-motion-picker]")?.focus();
    });
    return strip;
  }

  function positionStrip(strip, clip) {
    const entry = clip.motion.transition;
    const span = percentSpan(clip.start ?? 0, entry.dur, state.total);
    strip.style.left = span.left + "%";
    strip.style.width = span.width + "%";
    strip.title = "Transição " + (entry.preset ?? "") + " com " + (entry.partner ?? "?") + ", " + formatNumber(entry.dur) + "s";
    strip.setAttribute("aria-label", strip.title + ". Abre a seção Transição.");
  }

  function barLabel(clip) {
    const start = clip.start === null ? "início não resolvido" : "início " + formatNumber(clip.start) + "s";
    const duration = clip.duration === null ? "duração não definida" : "duração " + formatNumber(clip.duration) + "s";
    return "Clip " + clip.id + " (" + clip.tag + "), " + start + ", " + duration;
  }

  function positionBar(bar, clip) {
    const start = clip.start ?? 0;
    const duration = clip.duration ?? 0;
    bar.style.left = state.total > 0 ? clamp((start / state.total) * 100, 0, 100) + "%" : "0%";
    bar.style.width = state.total > 0 ? clamp((duration / state.total) * 100, 0, 100) + "%" : "0%";
    bar.dataset.start = formatNumber(clip.start);
    bar.dataset.duration = formatNumber(clip.duration);
    bar.setAttribute("aria-label", barLabel(clip));
  }

  function updateBarGeometry(clip, bar) {
    const target = bar ?? findBar(clip.id);
    if (target) positionBar(target, clip);
    const strip = timelineRows.querySelector('.ff-transition[data-clip-id="' + CSS.escape(clip.id) + '"]');
    if (strip) positionStrip(strip, clip);
    if (!state.inspectorDirty) {
      if (clip.start !== null) fieldStart.value = formatNumber(clip.start);
      if (clip.duration !== null) fieldDuration.value = formatNumber(clip.duration);
      clipIdEl.textContent = clip.id;
    }
  }

  function findBar(id) {
    for (const bar of timelineRows.querySelectorAll(".clip-bar")) {
      if (bar.dataset.clipId === id) return bar;
    }
    return null;
  }

  function paintPlayhead() {
    const ratio = state.total > 0 ? clamp(state.playhead / state.total, 0, 1) : 0;
    playheadEl.style.left = ratio * 100 + "%";
    playheadEl.hidden = state.total <= 0;
  }

  /* Arrasto */

  function onBarPointerDown(event) {
    if (event.button !== 0) return;
    const bar = event.currentTarget;
    const clip = findClip(bar.dataset.clipId);
    if (!clip) return;
    selectClip(clip.id);
    if (clip.start === null || state.total <= 0) return;

    const lane = bar.parentElement;
    const laneWidth = lane.getBoundingClientRect().width;
    if (laneWidth <= 0) return;

    const handle = event.target instanceof Element ? event.target.closest(".resize-handle") : null;
    drag = {
      bar,
      clip,
      mode: handle ? "resize" : "move",
      pointerId: event.pointerId,
      originX: event.clientX,
      originStart: clip.start,
      originDuration: clip.duration ?? 0,
      laneWidth,
      moved: false,
    };
    event.preventDefault();
    try {
      bar.setPointerCapture(event.pointerId);
    } catch (error) {
      /* captura indisponível: listeners na window continuam o arrasto */
    }
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    window.addEventListener("pointercancel", onDragEnd);
  }

  function onDragMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaPx = event.clientX - drag.originX;
    if (Math.abs(deltaPx) >= 2) drag.moved = true;
    const deltaSeconds = (deltaPx / drag.laneWidth) * state.total;

    if (drag.mode === "move") {
      drag.clip.start = snap(Math.max(0, drag.originStart + deltaSeconds));
      if (drag.clip.duration !== null) drag.clip.end = drag.clip.start + drag.clip.duration;
    } else {
      drag.clip.duration = snap(Math.max(MIN_DURATION, drag.originDuration + deltaSeconds));
      drag.clip.end = drag.clip.start === null ? null : drag.clip.start + drag.clip.duration;
    }
    updateBarGeometry(drag.clip, drag.bar);
  }

  function onDragEnd(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const finished = drag;
    drag = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("pointercancel", onDragEnd);
    try {
      finished.bar.releasePointerCapture(finished.pointerId);
    } catch (error) {
      /* o ponteiro já pode ter sido liberado */
    }
    if (!finished.moved) return;

    if (finished.mode === "move" && finished.clip.start !== finished.originStart) {
      queuePatch(finished.clip.id, { "data-start": formatNumber(finished.clip.start) });
    } else if (finished.mode === "resize" && finished.clip.duration !== finished.originDuration) {
      queuePatch(finished.clip.id, { "data-duration": formatNumber(finished.clip.duration) });
    }
  }

  function nudgeSelected(direction) {
    const clip = state.selectedId === null ? null : findClip(state.selectedId);
    if (!clip || clip.start === null) return;
    const next = snap(Math.max(0, clip.start + direction * SNAP));
    if (next === clip.start) return;
    clip.start = next;
    if (clip.duration !== null) clip.end = next + clip.duration;
    updateBarGeometry(clip);
    queuePatch(clip.id, { "data-start": formatNumber(clip.start) });
  }

  function queuePatch(id, attributes) {
    mutationQueue = mutationQueue
      .then(async () => {
        const result = await mutate("POST", "/api/clips/" + encodeURIComponent(id), { attributes });
        if (result.payload && result.payload.history) applyHistory(result.payload.history);
        if (!result.ok) {
          // Recarrega antes: o refresh repinta o inspetor e apagaria o diagnóstico recém-mostrado.
          await refreshComposition();
          renderDiagnostics(inspectorDiagnostics, result.diagnostics);
          return;
        }
        if (asNumber(result.payload.duration) !== null) {
          state.total = Math.max(0, result.payload.duration);
          renderTop();
          renderTimeline();
          paintPlayhead();
        }
      })
      .catch((error) => {
        renderDiagnostics(inspectorDiagnostics, [
          { severity: "error", message: "Falha ao salvar a edição: " + error.message },
        ]);
      });
    return mutationQueue;
  }

  /** `POST /api/clips/<id>/transition`; o início de B muda, então recarrega a composição inteira. */
  function queueTransition(id, change) {
    mutationQueue = mutationQueue
      .then(async () => {
        const result = await mutate("POST", "/api/clips/" + encodeURIComponent(id) + "/transition", change);
        if (result.payload && result.payload.history) applyHistory(result.payload.history);
        state.inspectorDirty = false;
        await refreshComposition();
        if (!result.ok) renderDiagnostics(inspectorDiagnostics, result.diagnostics);
      })
      .catch((error) => {
        renderDiagnostics(inspectorDiagnostics, [{ severity: "error", message: "Falha ao salvar a transição: " + error.message }]);
      });
    return mutationQueue;
  }

  /* Blocos */

  async function loadBlocks() {
    try {
      const response = await fetch("/api/blocks", { cache: "no-store", headers: { accept: "application/json" } });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(payload.message || "HTTP " + response.status);
      const blocks = Array.isArray(payload) ? payload : arrayOrEmpty(payload.blocks);
      renderBlocks(blocks);
      blocksStatus.hidden = blocks.length > 0;
      blocksStatus.textContent = blocks.length ? "" : "Nenhum bloco disponível.";
    } catch (error) {
      blocksStatus.hidden = false;
      blocksStatus.textContent = "Falha ao carregar blocos.";
      renderDiagnostics(blocksDiagnostics, [
        { severity: "error", message: "Não foi possível carregar os blocos: " + error.message },
      ]);
    }
  }

  function renderBlocks(blocks) {
    blocksList.replaceChildren();
    for (const block of blocks) {
      const slug = typeof block.slug === "string" ? block.slug : "";
      const name = typeof block.name === "string" && block.name ? block.name : slug || "bloco";
      const duration = asNumber(block.durationSeconds) ?? asNumber(block.duration) ?? 0;
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "block-button";
      button.setAttribute("aria-label", "Inserir bloco " + name + ", " + formatSeconds(duration) + ", no tempo atual");
      const nameEl = document.createElement("span");
      nameEl.className = "block-name";
      nameEl.textContent = name;
      const durationEl = document.createElement("span");
      durationEl.className = "block-duration";
      durationEl.textContent = formatSeconds(duration);
      button.append(nameEl, durationEl);
      button.addEventListener("click", () => insertBlock(block, button));
      item.append(button);
      blocksList.append(item);
    }
  }

  async function insertBlock(block, button) {
    const name = String(block.name ?? block.slug ?? "");
    const template = /subt[ií]tulo|subtitle/i.test(name + " " + String(block.slug ?? "")) ? "subtitle" : "title";
    const duration = asNumber(block.durationSeconds);
    if (duration === null || duration <= 0) {
      renderDiagnostics(blocksDiagnostics, [{ severity: "error", message: "Bloco sem duração válida: " + name }]);
      return;
    }
    const start = snap(Math.max(0, state.playhead));
    button.disabled = true;
    try {
      const result = await mutate("POST", "/api/clips", { template, start, duration });
      if (result.payload && result.payload.history) applyHistory(result.payload.history);
      if (!result.ok) {
        renderDiagnostics(blocksDiagnostics, result.diagnostics);
        return;
      }
      await refreshComposition();
      const id = typeof result.payload.id === "string" ? result.payload.id : null;
      if (id && findClip(id)) {
        selectClip(id);
      }
      const diagnostics = result.diagnostics.length
        ? result.diagnostics
        : [{ severity: "info", message: "Bloco inserido em " + formatSeconds(start) + "." }];
      renderDiagnostics(blocksDiagnostics, diagnostics);
    } finally {
      button.disabled = false;
    }
  }

  /* Mutação */

  async function mutate(method, url, body) {
    try {
      const response = await fetch(url, {
        method,
        cache: "no-store",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      const diagnostics = normalizeDiagnostics(payload);
      if (!response.ok || payload.ok === false) {
        if (typeof payload.message === "string" && payload.message.trim() && !diagnostics.some((item) => item.message === payload.message)) {
          diagnostics.unshift({ severity: "error", message: payload.message });
        }
        if (!diagnostics.length) {
          diagnostics.push({ severity: "error", message: "HTTP " + response.status });
        }
        return { ok: false, payload, diagnostics };
      }
      return { ok: true, payload, diagnostics };
    } catch (error) {
      return {
        ok: false,
        payload: null,
        diagnostics: [{ severity: "error", message: "Falha de rede: " + error.message }],
      };
    }
  }

  /* Player, eventos e atalhos */

  let lastPlayerWidth = -1;

  function fitPlayer() {
    const width = playerFrame.clientWidth;
    if (width <= 0) return;
    if (width === lastPlayerWidth) return;
    lastPlayerWidth = width;
    const scale = width / PLAYER_WIDTH;
    player.style.transform = "scale(" + scale + ")";
    playerFrame.style.height = PLAYER_HEIGHT * scale + "px";
  }

  function observePlayerSize() {
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => fitPlayer());
    observer.observe(playerFrame);
  }

  function readPlayerTime() {
    try {
      const win = player.contentWindow;
      if (win && win.__ff && typeof win.__ff.now === "function") {
        const value = Number(win.__ff.now());
        return Number.isFinite(value) ? value : null;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function reloadPreview() {
    const timeMs = readPlayerTime();
    if (timeMs !== null) {
      try {
        sessionStorage.setItem("__ffTime", String(Math.round(timeMs)));
      } catch (error) {
        /* sessionStorage indisponível: o preview começa do zero */
      }
    }
    try {
      if (player.contentWindow) player.contentWindow.location.reload();
      else player.src = "/preview";
    } catch (error) {
      player.src = "/preview";
    }
  }

  function connectEvents() {
    let source;
    try {
      source = new EventSource("/api/events");
    } catch (error) {
      setConnection("sem eventos", true);
      return;
    }
    source.onopen = () => setConnection("ao vivo", false);
    source.onerror = () => setConnection("reconectando", true);
    const onChange = () => {
      reloadPreview();
      refreshComposition();
    };
    source.addEventListener("change", onChange);
    source.onmessage = (event) => {
      if (String(event.data).trim() === "change") onChange();
    };
  }

  /* Clica num botão da barra de controle do preview; falha alto se a barra não existe. */
  function clickPlayerControl(selector) {
    let button = null;
    try {
      const doc = player.contentDocument;
      button = doc ? doc.querySelector(selector) : null;
    } catch (error) {
      setConnection("preview inacessível: " + error.message, true);
      return;
    }
    if (button === null) {
      setConnection("preview sem barra de controle", true);
      return;
    }
    button.click();
  }

  function togglePlayback() {
    clickPlayerControl("[data-ff-play]");
  }

  /* Atalhos não disparam enquanto o foco está num campo de edição. */
  function isTyping(event) {
    const target = event.target;
    return (
      target instanceof HTMLElement &&
      (target.matches("input, textarea, select") || target.isContentEditable || target.closest("[contenteditable]") !== null)
    );
  }

  document.addEventListener("keydown", (event) => {
    if (event.code === "Space" && !isTyping(event)) {
      event.preventDefault();
      togglePlayback();
      return;
    }
    if (event.defaultPrevented || isTyping(event)) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (!mod && !event.altKey && key === "l") {
      event.preventDefault();
      clickPlayerControl("[data-ff-loop]");
      return;
    }
    if (mod && !event.altKey && key === "z") {
      event.preventDefault();
      travel(event.shiftKey ? "redo" : "undo");
      return;
    }
    if (mod && !event.altKey && !event.shiftKey && key === "y") {
      event.preventDefault();
      travel("redo");
      return;
    }
    if (!mod && !event.altKey && key === "s") {
      event.preventDefault();
      splitSelected();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (state.selectedId === null) return;
    event.preventDefault();
    nudgeSelected(event.key === "ArrowRight" ? 1 : -1);
  });

  importButton.addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", () => {
    const files = Array.from(importInput.files ?? []);
    importInput.value = "";
    importFiles(files);
  });
  splitButton.addEventListener("click", () => splitSelected());
  undoButton.addEventListener("click", () => travel("undo"));
  redoButton.addEventListener("click", () => travel("redo"));

  /* Arrastar arquivo para qualquer ponto da janela importa no playhead. */
  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    setDropOverlay(true);
  });
  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDropOverlay(false);
  });
  /* O iframe do preview engole eventos de arraste; o overlay cobre a janela assim que ele percebe um arquivo. */
  player.addEventListener("load", () => {
    const doc = player.contentDocument;
    if (!doc) return;
    doc.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 1;
      setDropOverlay(true);
    });
    doc.addEventListener("dragover", (event) => {
      if (hasFiles(event)) event.preventDefault();
    });
  });
  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    setDropOverlay(false);
    importFiles(event.dataTransfer.files);
  });

  inspector.addEventListener("submit", (event) => {
    event.preventDefault();
    applyChanges();
  });

  inspector.addEventListener("input", () => {
    state.inspectorDirty = true;
  });

  inspector.addEventListener("change", () => {
    state.inspectorDirty = true;
  });

  window.addEventListener("resize", () => {
    fitPlayer();
    playheadTrack.style.height = Math.max(timelineBody.clientHeight, timelineRows.scrollHeight) + "px";
    paintPlayhead();
  });

  setInterval(() => {
    const timeMs = readPlayerTime();
    if (timeMs === null) return;
    state.playhead = state.total > 0 ? clamp(timeMs / 1000, 0, maxPlayhead()) : Math.max(0, timeMs / 1000);
    paintPlayhead();
    updateToolbar();
  }, FRAME_POLL_MS);

  renderTop();
  renderTimeline();
  fitPlayer();
  observePlayerSize();
  refreshComposition();
  refreshHistory();
  loadMotionPresets();
  loadBlocks();
  connectEvents();
})();
