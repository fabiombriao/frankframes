import { MAX_PX_PER_FRAME, chooseStep, clampZoom, isFrameLevel, lastFrameTime, peakSlice, pxSpan, roundToFrame, tickLabel, zoomAround } from "/timeline-math.js";
import { keyframeMarks, keyframePropsFor, renderKeyframeSection, renderMotionSection, renderTransitionSection } from "/motion.js";

(() => {
  "use strict";

  const SNAP = 0.05;
  const MIN_DURATION = 0.1;
  /* Passo do zoom da timeline. */
  const ZOOM_STEP = 1.15;
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
  const keyframeSection = document.getElementById("keyframeSection");
  const blocksStatus = document.getElementById("blocksStatus");
  const blocksList = document.getElementById("blocksList");
  const blocksDiagnostics = document.getElementById("blocksDiagnostics");
  const ruler = document.getElementById("ruler");
  const timelineScroll = document.getElementById("timelineScroll");
  const timelineCanvas = document.getElementById("timelineCanvas");
  const timelineGutter = document.querySelector(".timeline-gutter");
  const zoomOutButton = document.getElementById("zoomOut");
  const zoomInButton = document.getElementById("zoomIn");
  const zoomFitButton = document.getElementById("zoomFit");
  const zoomLevelEl = document.getElementById("zoomLevel");
  const timelineRows = document.getElementById("timelineRows");
  const timelineEmpty = document.getElementById("timelineEmpty");
  const playheadEl = document.getElementById("playhead");
  const importButton = document.getElementById("importButton");
  const importInput = document.getElementById("importInput");
  const splitButton = document.getElementById("splitButton");
  const deleteButton = document.getElementById("deleteButton");
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
    /* Área de transferência por referência: o id do clip copiado, não o conteúdo. */
    clipboard: null,
    inspectorDirty: false,
    playhead: 0,
    history: { canUndo: false, canRedo: false, undo: null, redo: null },
    busy: false,
    motionPresets: null,
    /* Keyframe selecionado: { clipId, time } com o tempo local ao clip, em segundos. */
    selectedKeyframe: null,
    keyframeProp: "opacity",
    /* Escala da timeline (EDT-45): px por segundo. Em "ajustar" (zoomFit) o valor acompanha a largura visível. */
    pxPerSecond: 1,
    zoomFit: true,
    /* Waveform por fonte (mediaSrc): a promessa é buscada uma vez; o resultado fica em waveformResults. */
    waveforms: new Map(),
    waveformResults: new Map(),
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

  /* Alinhamento do arrasto: no nível de frame da régua (>= 8 px/frame) vai de frame em frame, senão de 0,05 s. */
  function snapTime(value) {
    if (!isFrameLevel(state.pxPerSecond, state.fps)) return snap(value);
    /* Trunca em ms: 2/30 vira 0,066 e o frame 2 (0,0667 s) continua dentro do clip; arredondar para cima o cortaria. */
    return Math.floor((Math.round(value * state.fps) / state.fps) * 1000 + 1e-6) / 1000;
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
      /* Um ponto por tempo: { time, volume?, <propriedades visuais>, curve? } (docs/contract.md §9d). */
      keyframes: Array.isArray(raw.keyframes) ? raw.keyframes : [],
      descendantKeyframeTimes: Array.isArray(raw.descendantKeyframeTimes) ? raw.descendantKeyframeTimes : [],
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
    keepKeyframeSelection();

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
    keyframeSection.hidden = true;
    state.selectedKeyframe = null;
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
    renderKeyframes(clip);
  }

  /* Keyframes (EDT-47) */

  function renderKeyframes(clip) {
    renderKeyframeSection(keyframeSection, clip, {
      playhead: state.playhead,
      selected: state.selectedKeyframe === null ? null : state.selectedKeyframe.time,
      prop: state.keyframeProp,
      onProp: (prop) => {
        state.keyframeProp = prop;
      },
      onAdd: (prop) => addKeyframe(prop),
      onSelect: (time) => selectKeyframe(clip.id, time),
      onEdit: (change) => queueKeyframe(clip.id, { op: "edit", ...change }),
      onRemove: (time) => queueKeyframe(clip.id, { op: "remove", time }),
    });
  }

  function sameKeyframeTime(a, b) {
    return Math.abs(a - b) <= 0.0005;
  }

  function roundMs(value) {
    return Math.round(value * 1000) / 1000;
  }

  /* Depois de recarregar (edição, undo, redo): a seleção só sobrevive se o ponto ainda existe. */
  function keepKeyframeSelection() {
    const selected = state.selectedKeyframe;
    if (selected === null) return;
    const clip = findClip(selected.clipId);
    if (!clip || !clip.keyframes.some((point) => sameKeyframeTime(point.time, selected.time))) state.selectedKeyframe = null;
  }

  function selectKeyframe(clipId, time) {
    state.selectedKeyframe = time === null ? null : { clipId, time };
    paintKeyframeSelection();
    const clip = findClip(clipId);
    if (clip && clip.id === state.selectedId) renderKeyframes(clip);
  }

  function paintKeyframeSelection() {
    const selected = state.selectedKeyframe;
    for (const mark of timelineRows.querySelectorAll(".kf-mark")) {
      const on = selected !== null && mark.dataset.clipId === selected.clipId && sameKeyframeTime(Number(mark.dataset.time), selected.time);
      mark.classList.toggle("is-selected", on);
    }
  }

  /* "Adicionar no playhead" só vale com o playhead dentro do clip. */
  function refreshKeyframeAddState() {
    const clip = state.selectedId === null ? null : findClip(state.selectedId);
    const add = keyframeSection.querySelector(".kf-add-button");
    if (!clip || !add || clip.start === null || clip.duration === null) return;
    const local = state.playhead - clip.start;
    const inside = local >= -0.0005 && local <= clip.duration + 0.0005;
    add.disabled = clip.editable !== true || !inside;
    add.title = inside ? "Atalho: K" : "Posicione o playhead dentro do clip";
  }

  function addKeyframe(requestedProp) {
    const clip = state.selectedId === null ? null : findClip(state.selectedId);
    if (!clip || clip.start === null || clip.duration === null) return mutationQueue;
    const local = roundMs(roundToFrame(state.playhead, state.fps) - clip.start);
    if (clip.editable !== true || local < -0.0005 || local > clip.duration + 0.0005) {
      renderDiagnostics(inspectorDiagnostics, [
        { severity: "info", message: "Selecione um clip editável e posicione o playhead dentro dele para adicionar um keyframe." },
      ]);
      return mutationQueue;
    }
    const allowed = keyframePropsFor(clip);
    const prop = allowed.some((item) => item.prop === requestedProp) ? requestedProp : allowed[0].prop;
    state.keyframeProp = prop;
    return queueKeyframe(clip.id, { op: "add", time: clamp(local, 0, roundMs(clip.duration)), prop });
  }

  function removeSelectedKeyframe() {
    const selected = state.selectedKeyframe;
    if (selected === null) return mutationQueue;
    return queueKeyframe(selected.clipId, { op: "remove", time: selected.time });
  }

  /* POST /api/clips/<id>/keyframes; a seleção acompanha o ponto (add/move) ou some (remove). */
  function queueKeyframe(id, body) {
    mutationQueue = mutationQueue
      .then(async () => {
        const result = await mutate("POST", "/api/clips/" + encodeURIComponent(id) + "/keyframes", body);
        if (result.payload && result.payload.history) applyHistory(result.payload.history);
        if (result.ok) {
          if (body.op === "add") state.selectedKeyframe = { clipId: id, time: roundMs(body.time) };
          else if (body.op === "move") state.selectedKeyframe = { clipId: id, time: roundMs(body.to) };
          else if (body.op === "remove") state.selectedKeyframe = null;
        }
        state.inspectorDirty = false;
        await refreshComposition();
        if (!result.ok) renderDiagnostics(inspectorDiagnostics, result.diagnostics);
      })
      .catch((error) => {
        renderDiagnostics(inspectorDiagnostics, [{ severity: "error", message: "Falha ao salvar o keyframe: " + error.message }]);
      });
    return mutationQueue;
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
    if (state.selectedKeyframe !== null && state.selectedKeyframe.clipId !== id) state.selectedKeyframe = null;
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

  /** Clip selecionado que dá para excluir (da raiz, com data-clip-id explícito), ou null. */
  function deletable() {
    const clip = state.selectedId === null ? null : findClip(state.selectedId);
    return clip && clip.editable === true ? clip : null;
  }

  function updateToolbar() {
    const history = state.history;
    undoButton.disabled = state.busy || !history.canUndo;
    redoButton.disabled = state.busy || !history.canRedo;
    undoButton.title = history.undo ? "Desfazer: " + history.undo + " (Ctrl+Z)" : "Nada para desfazer (Ctrl+Z)";
    redoButton.title = history.redo ? "Refazer: " + history.redo + " (Ctrl+Shift+Z)" : "Nada para refazer (Ctrl+Shift+Z)";
    splitButton.disabled = state.busy || splittable() === null;
    deleteButton.disabled = state.busy || deletable() === null;
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

  function deleteSelected() {
    const clip = deletable();
    if (clip === null) {
      renderDiagnostics(toolDiagnostics, [{ severity: "info", message: "Selecione um clip editável para excluir." }]);
      return mutationQueue;
    }
    return runTool(async () => {
      const result = await mutate("POST", "/api/clips/" + encodeURIComponent(clip.id) + "/delete", {});
      if (result.payload && result.payload.history) applyHistory(result.payload.history);
      if (!result.ok) {
        renderDiagnostics(toolDiagnostics, result.diagnostics);
        return;
      }
      clearInspector();
      await refreshComposition();
      renderDiagnostics(toolDiagnostics, [{ severity: "info", message: clip.id + " excluído; o resto da timeline não se moveu." }]);
    });
  }

  /** Ctrl+C: guarda a referência do clip selecionado; nada muda no arquivo. */
  function copySelected() {
    const clip = deletable();
    if (clip === null) {
      renderDiagnostics(toolDiagnostics, [{ severity: "info", message: "Selecione um clip editável para copiar." }]);
      return;
    }
    state.clipboard = clip.id;
    renderDiagnostics(toolDiagnostics, [{ severity: "info", message: "copiado " + clip.id }]);
  }

  /** Cola (`paste`, no playhead) ou duplica (`duplicate`, logo depois do original); seleciona a cópia. */
  function copyClip(mode, id) {
    return runTool(async () => {
      const body = mode === "paste" ? { at: snap(Math.max(0, state.playhead)) } : {};
      const result = await mutate("POST", "/api/clips/" + encodeURIComponent(id) + "/" + mode, body);
      if (result.payload && result.payload.history) applyHistory(result.payload.history);
      if (!result.ok) {
        renderDiagnostics(toolDiagnostics, result.diagnostics);
        return;
      }
      state.inspectorDirty = false;
      await refreshComposition();
      if (typeof result.payload.id === "string" && findClip(result.payload.id)) selectClip(result.payload.id);
      const warnings = Array.isArray(result.payload.warnings) ? result.payload.warnings : [];
      renderDiagnostics(toolDiagnostics, [
        { severity: "info", message: (mode === "paste" ? "colado" : "duplicado") + " " + id + " como " + result.payload.id + "." },
        ...warnings.map((message) => ({ severity: "warning", message: String(message) })),
      ]);
    });
  }

  function pasteClipboard() {
    if (state.clipboard === null) return mutationQueue;
    return copyClip("paste", state.clipboard);
  }

  function duplicateSelected() {
    const clip = deletable();
    if (clip === null) {
      renderDiagnostics(toolDiagnostics, [{ severity: "info", message: "Selecione um clip editável para duplicar." }]);
      return mutationQueue;
    }
    return copyClip("duplicate", clip.id);
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

  /* Escala (EDT-45): tudo na timeline é px = segundos * state.pxPerSecond. */

  function gutterWidth() {
    return timelineGutter.offsetWidth;
  }

  /** Largura visível da pista (sem a coluna de rótulos), em px inteiros. */
  function laneViewWidth() {
    return Math.max(1, Math.floor(timelineScroll.clientWidth - gutterWidth()));
  }

  function fitPps() {
    return state.total > 0 ? laneViewWidth() / state.total : 1;
  }

  function maxPps() {
    return state.fps * MAX_PX_PER_FRAME;
  }

  function laneWidthPx() {
    return state.total * state.pxPerSecond;
  }

  /** Recalcula o pps (em "ajustar" acompanha a largura visível), a largura da pista e os controles de zoom. */
  function applyScale() {
    const fit = fitPps();
    state.pxPerSecond = state.zoomFit ? fit : clampZoom(state.pxPerSecond, { fitPps: fit, fps: state.fps });
    if (state.pxPerSecond <= fit + 1e-9) state.zoomFit = true;
    timelineCanvas.style.setProperty("--lane-width", laneWidthPx() + "px");
    const { major } = state.total > 0 ? chooseStep(state.pxPerSecond, state.fps) : { major: 1 };
    timelineCanvas.style.setProperty("--tick-size", Math.max(8, major * state.pxPerSecond) + "px");
    paintZoomControls(fit);
  }

  function paintZoomControls(fit) {
    const pps = state.pxPerSecond;
    zoomLevelEl.textContent =
      state.total <= 0
        ? ""
        : isFrameLevel(pps, state.fps)
          ? "1 frame = " + Math.round((pps / state.fps) * 10) / 10 + " px"
          : (pps < 10 ? Math.round(pps * 10) / 10 : Math.round(pps)) + " px/s";
    zoomOutButton.disabled = state.total <= 0 || pps <= fit + 1e-9;
    zoomInButton.disabled = state.total <= 0 || pps >= maxPps() - 1e-9;
    zoomFitButton.disabled = state.total <= 0 || state.zoomFit;
  }

  /**
   * Muda o zoom por `factor` mantendo parado o instante sob `pointerX` (px da pista a partir da borda
   * esquerda da área visível; padrão: o centro).
   */
  function zoomBy(factor, pointerX) {
    if (state.total <= 0) return;
    const anchorX = clamp(pointerX ?? laneViewWidth() / 2, 0, laneViewWidth());
    const fit = fitPps();
    const current = state.pxPerSecond;
    const target = clampZoom(current * factor, { fitPps: fit, fps: state.fps });
    if (Math.abs(target - current) < 1e-9) return;
    const anchorTime = (timelineScroll.scrollLeft + anchorX) / current;
    const next = zoomAround(current, target / current, anchorTime, anchorX);
    state.zoomFit = false;
    state.pxPerSecond = next.pps;
    applyScale();
    timelineScroll.scrollLeft = next.scrollLeft;
    redrawTimeline();
  }

  function zoomFitAll() {
    state.zoomFit = true;
    applyScale();
    timelineScroll.scrollLeft = 0;
    redrawTimeline();
  }

  /** Reposiciona tudo que depende da escala sem refazer as linhas. */
  function redrawTimeline() {
    for (const bar of timelineRows.querySelectorAll(".clip-bar")) {
      const clip = findClip(bar.dataset.clipId);
      if (!clip) continue;
      positionBar(bar, clip);
      const strip = timelineRows.querySelector('.ff-transition[data-clip-id="' + CSS.escape(clip.id) + '"]');
      if (strip) positionStrip(strip, clip);
      positionKeyframeMarks(clip);
    }
    paintPlayhead();
    scheduleRuler();
    scheduleWaveforms();
  }

  /* Régua: só os tiques da janela visível (mais uma tela de folga), redesenhados em rAF ao rolar ou dar zoom. */

  let rulerFrame = 0;

  function scheduleRuler() {
    if (rulerFrame !== 0) return;
    rulerFrame = requestAnimationFrame(() => {
      rulerFrame = 0;
      paintRuler();
    });
  }

  function paintRuler() {
    ruler.replaceChildren();
    if (state.total <= 0) return;
    const pps = state.pxPerSecond;
    const { major, minor } = chooseStep(pps, state.fps);
    const frameLevel = isFrameLevel(pps, state.fps);
    const viewWidth = laneViewWidth();
    const from = Math.max(0, (timelineScroll.scrollLeft - viewWidth) / pps);
    const to = Math.min(state.total, (timelineScroll.scrollLeft + viewWidth * 2) / pps);
    const first = Math.floor(from / minor + 1e-9);
    const fragment = document.createDocumentFragment();
    for (let index = first; index * minor <= to + 1e-9; index++) {
      const time = index * minor;
      const isMajor = Math.abs(time / major - Math.round(time / major)) < 1e-6;
      const tick = document.createElement("div");
      tick.className = "tick" + (isMajor ? "" : " is-minor");
      tick.style.left = time * pps + "px";
      if (isMajor) {
        const label = document.createElement("span");
        label.textContent = tickLabel(time, state.fps, frameLevel);
        tick.append(label);
      }
      fragment.append(tick);
    }
    ruler.append(fragment);
  }

  /* Waveform (EDT-45) */

  /** Clips que mostram forma de onda: mídia com som e posição resolvida. */
  function hasWave(clip) {
    return (clip.kind === "audio" || clip.kind === "video") && clip.hasAudio && clip.mediaSrc !== null && clip.start !== null && clip.duration !== null;
  }

  /** Busca a waveform da fonte uma vez; falha vira resultado `{ error }` e fica visível na faixa. */
  function ensureWaveform(clip) {
    const key = clip.mediaSrc;
    if (state.waveforms.has(key)) return;
    const promise = fetch("/api/waveform/" + encodeURIComponent(clip.id), { headers: { accept: "application/json" } })
      .then(async (response) => {
        const payload = await readJson(response);
        if (!response.ok) {
          const code = typeof payload.code === "string" ? payload.code : "E_WAVEFORM_FAILED";
          throw Object.assign(new Error(typeof payload.message === "string" ? payload.message : "HTTP " + response.status), { code });
        }
        if (!Array.isArray(payload.peaks) || !(payload.peaksPerSecond > 0)) {
          throw Object.assign(new Error("resposta de waveform inválida"), { code: "E_WAVEFORM_FAILED" });
        }
        return payload;
      });
    state.waveforms.set(key, promise);
    promise.then(
      (waveform) => state.waveformResults.set(key, { waveform }),
      (error) => state.waveformResults.set(key, { error: typeof error.code === "string" ? error : Object.assign(error, { code: "E_WAVEFORM_FAILED" }) }),
    ).then(scheduleWaveforms);
  }

  let waveFrame = 0;

  function scheduleWaveforms() {
    if (waveFrame !== 0) return;
    waveFrame = requestAnimationFrame(() => {
      waveFrame = 0;
      paintWaveforms();
    });
  }

  function paintWaveforms() {
    const scroll = timelineScroll.scrollLeft;
    const viewWidth = laneViewWidth();
    const pps = state.pxPerSecond;
    const dpr = window.devicePixelRatio || 1;
    for (const bar of timelineRows.querySelectorAll(".clip-bar")) {
      const clip = findClip(bar.dataset.clipId);
      const canvas = bar.querySelector(".wave");
      const failed = bar.querySelector(".wave-error");
      if (!clip || !canvas || !failed) continue;
      const result = state.waveformResults.get(clip.mediaSrc ?? "");
      failed.hidden = result === undefined || result.error === undefined;
      if (result !== undefined && result.error !== undefined) {
        failed.title = result.error.code;
        failed.setAttribute("aria-label", "Waveform indisponível: " + result.error.code);
      }
      const span = pxSpan(clip.start ?? 0, clip.duration ?? 0, state.total, pps);
      const left = Math.max(span.left, scroll);
      const right = Math.min(span.left + span.width, scroll + viewWidth);
      if (result === undefined || result.waveform === undefined || right - left < 1) {
        canvas.hidden = true;
        continue;
      }
      const width = Math.ceil(right - left);
      const height = Math.max(1, bar.clientHeight);
      /* O canvas fica dentro da borda da barra (1 px): o deslocamento desconta a borda. */
      canvas.hidden = false;
      canvas.style.left = left - span.left - 1 + "px";
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
      if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
      drawWave(canvas, result.waveform, clip, left, width, height, dpr);
    }
  }

  /** Desenha o máximo dos picos de cada coluna de px; a janela de picos sai de `peakSlice` (só a parte visível). */
  function drawWave(canvas, waveform, clip, left, width, height, dpr) {
    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const pps = state.pxPerSecond;
    const rate = clip.playbackRate > 0 ? clip.playbackRate : 1;
    const perSecond = waveform.peaksPerSecond;
    /* Tempo da fonte nas bordas da parte visível: offset + (tempo na timeline - início) * rate. */
    const sourceFrom = clip.offset + Math.max(0, left / pps - clip.start) * rate;
    const sourceSpan = (width / pps) * rate;
    const slice = peakSlice(waveform, sourceFrom, sourceSpan, 1);
    if (slice.length === 0) return;
    const base = Math.floor(sourceFrom * perSecond);
    context.fillStyle = clip.id === state.selectedId ? "rgba(23, 10, 13, 0.75)" : "rgba(142, 203, 255, 0.85)";
    const middle = height / 2;
    for (let column = 0; column < width; column++) {
      const t0 = sourceFrom + (column / pps) * rate;
      const t1 = sourceFrom + ((column + 1) / pps) * rate;
      const i0 = Math.floor(t0 * perSecond) - base;
      const i1 = Math.max(i0 + 1, Math.ceil(t1 * perSecond) - base);
      let peak = 0;
      for (let index = Math.max(0, i0); index < Math.min(slice.length, i1); index++) {
        if (slice[index] > peak) peak = slice[index];
      }
      if (peak === 0) continue;
      const half = Math.max(1, (peak / 255) * (middle - 1));
      context.fillRect(column, middle - half, 1, half * 2);
    }
  }

  function renderTimeline() {
    const scrollTop = timelineScroll.scrollTop;
    const scrollLeft = timelineScroll.scrollLeft;
    timelineRows.replaceChildren();
    applyScale();
    paintRuler();

    if (!state.clips.length) {
      timelineEmpty.hidden = false;
      timelineScroll.scrollTop = 0;
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

      if (hasWave(clip)) {
        ensureWaveform(clip);
        const canvas = document.createElement("canvas");
        canvas.className = "wave";
        canvas.hidden = true;
        canvas.setAttribute("aria-hidden", "true");
        const failed = document.createElement("span");
        failed.className = "wave-error";
        failed.hidden = true;
        bar.append(canvas, failed);
      }

      if (trimmable(clip)) {
        const startHandle = document.createElement("span");
        startHandle.className = "resize-handle-start";
        startHandle.dataset.handle = "trim-start";
        startHandle.setAttribute("aria-hidden", "true");
        bar.append(startHandle);
      }

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
      for (const mark of keyframeMarkElements(clip)) lane.append(mark);
      row.append(label, lane);
      timelineRows.append(row);
    }

    timelineScroll.scrollTop = scrollTop;
    timelineScroll.scrollLeft = scrollLeft;
    scheduleWaveforms();
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

  /* Losangos dos keyframes na faixa do clip: mesma régua da barra (px = segundos * pxPerSecond). */
  function keyframeMarkElements(clip) {
    if (clip.start === null || state.total <= 0) return [];
    const marks = keyframeMarks(clip, (time) => pxSpan(clip.start + time, 0, state.total, state.pxPerSecond).left);
    const selected = state.selectedKeyframe;
    return marks.map((mark) => {
      const node = document.createElement("span");
      node.className = "kf-mark" + (mark.readOnly ? " is-readonly" : "");
      if (!mark.readOnly && selected !== null && selected.clipId === clip.id && sameKeyframeTime(selected.time, mark.time)) {
        node.classList.add("is-selected");
      }
      node.dataset.clipId = clip.id;
      node.dataset.time = String(mark.time);
      node.style.left = mark.x + "px";
      node.title = mark.readOnly
        ? "Keyframe de elemento interno, " + formatNumber(mark.time) + "s (só leitura)"
        : "Keyframe em " + formatNumber(mark.time) + "s: " + mark.props.join(", ");
      node.addEventListener("pointerdown", onKeyframePointerDown);
      return node;
    });
  }

  function positionKeyframeMarks(clip) {
    if (clip.start === null || state.total <= 0) return;
    for (const mark of timelineRows.querySelectorAll(".kf-mark")) {
      if (mark.dataset.clipId !== clip.id) continue;
      mark.style.left = pxSpan(clip.start + Number(mark.dataset.time), 0, state.total, state.pxPerSecond).left + "px";
    }
  }

  function positionStrip(strip, clip) {
    const entry = clip.motion.transition;
    const span = pxSpan(clip.start ?? 0, entry.dur, state.total, state.pxPerSecond);
    strip.style.left = span.left + "px";
    strip.style.width = span.width + "px";
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
    const span = pxSpan(start, duration, state.total, state.pxPerSecond);
    bar.style.left = span.left + "px";
    bar.style.width = span.width + "px";
    bar.dataset.start = formatNumber(clip.start);
    bar.dataset.duration = formatNumber(clip.duration);
    bar.setAttribute("aria-label", barLabel(clip));
  }

  function updateBarGeometry(clip, bar) {
    const target = bar ?? findBar(clip.id);
    if (target) positionBar(target, clip);
    const strip = timelineRows.querySelector('.ff-transition[data-clip-id="' + CSS.escape(clip.id) + '"]');
    if (strip) positionStrip(strip, clip);
    positionKeyframeMarks(clip);
    scheduleWaveforms();
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

  /** Com o playhead andando (tocando ou arrastado no player), a timeline rola para mantê-lo visível. */
  function followPlayhead() {
    if (state.total <= 0 || drag !== null || keyframeDrag !== null) return;
    const x = state.playhead * state.pxPerSecond;
    const viewWidth = laneViewWidth();
    const left = timelineScroll.scrollLeft;
    if (x >= left && x <= left + viewWidth) return;
    timelineScroll.scrollLeft = Math.max(0, x - viewWidth * 0.1);
  }

  function paintPlayhead() {
    playheadEl.style.left = (state.total > 0 ? clamp(state.playhead, 0, state.total) * state.pxPerSecond : 0) + "px";
    playheadEl.hidden = state.total <= 0;
    refreshKeyframeAddState();
  }

  /* Arrasto */

  /** Borda esquerda só onde o servidor aceita aparar (EDT-42): sem filhos, keyframes nem transição. */
  function trimmable(clip) {
    return (
      clip.editable === true &&
      clip.start !== null &&
      clip.duration !== null &&
      !clip.hasChildren &&
      !clip.hasKeyframes &&
      clip.keyframes.length === 0 &&
      clip.motion.transition === undefined
    );
  }

  function onBarPointerDown(event) {
    if (event.button !== 0) return;
    const bar = event.currentTarget;
    const clip = findClip(bar.dataset.clipId);
    if (!clip) return;
    selectClip(clip.id);
    if (clip.start === null || state.total <= 0) return;

    const handle = event.target instanceof Element ? event.target.closest(".resize-handle") : null;
    const startHandle = event.target instanceof Element ? event.target.closest(".resize-handle-start") : null;
    drag = {
      bar,
      clip,
      mode: startHandle ? "trim-start" : handle ? "resize" : "move",
      originOffset: clip.offset,
      originEnd: clip.end ?? clip.start + (clip.duration ?? 0),
      pointerId: event.pointerId,
      originX: event.clientX,
      originStart: clip.start,
      originDuration: clip.duration ?? 0,
      pps: state.pxPerSecond,
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
    const deltaSeconds = deltaPx / drag.pps;

    if (drag.mode === "move") {
      drag.clip.start = snapTime(Math.max(0, drag.originStart + deltaSeconds));
      if (drag.clip.duration !== null) drag.clip.end = drag.clip.start + drag.clip.duration;
    } else if (drag.mode === "trim-start") {
      // O fim fica parado; o início para na borda da fonte (mídia), em 0 e a MIN_DURATION do fim.
      const media = drag.clip.kind === "video" || drag.clip.kind === "audio";
      const rate = drag.clip.playbackRate > 0 ? drag.clip.playbackRate : 1;
      const lowest = media ? Math.max(0, drag.originStart - drag.originOffset / rate) : 0;
      const highest = Math.max(lowest, drag.originEnd - MIN_DURATION);
      const start = clamp(roundToFrame(drag.originStart + deltaSeconds, state.fps), lowest, highest);
      drag.clip.start = start;
      drag.clip.duration = drag.originEnd - start;
      drag.clip.end = drag.originEnd;
      if (media) drag.clip.offset = drag.originOffset + (start - drag.originStart) * rate;
    } else {
      drag.clip.duration = snapTime(Math.max(MIN_DURATION, drag.originDuration + deltaSeconds));
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

    if (finished.mode === "trim-start") {
      if (finished.clip.start !== finished.originStart) trimClip(finished.clip.id, finished.clip.start);
    } else if (finished.mode === "move" && finished.clip.start !== finished.originStart) {
      queuePatch(finished.clip.id, { "data-start": formatNumber(finished.clip.start) });
    } else if (finished.mode === "resize" && finished.clip.duration !== finished.originDuration) {
      queuePatch(finished.clip.id, { "data-duration": formatNumber(finished.clip.duration) });
    }
  }

  /* Arrasto de um keyframe: acompanha o frame mais próximo e grava (op "move") ao soltar. */
  let keyframeDrag = null;

  function onKeyframePointerDown(event) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const mark = event.currentTarget;
    const clip = findClip(mark.dataset.clipId);
    if (!clip) return;
    selectClip(clip.id);
    const time = Number(mark.dataset.time);
    if (mark.classList.contains("is-readonly")) return;
    selectKeyframe(clip.id, time);
    if (clip.editable !== true || clip.start === null || clip.duration === null || state.total <= 0) return;
    keyframeDrag = { mark, clip, time, current: time, pointerId: event.pointerId, originX: event.clientX, pps: state.pxPerSecond, moved: false };
    event.preventDefault();
    try {
      mark.setPointerCapture(event.pointerId);
    } catch (error) {
      /* captura indisponível: listeners na window continuam o arrasto */
    }
    window.addEventListener("pointermove", onKeyframeDragMove);
    window.addEventListener("pointerup", onKeyframeDragEnd);
    window.addEventListener("pointercancel", onKeyframeDragEnd);
  }

  function onKeyframeDragMove(event) {
    if (!keyframeDrag || event.pointerId !== keyframeDrag.pointerId) return;
    const drag = keyframeDrag;
    const deltaPx = event.clientX - drag.originX;
    if (Math.abs(deltaPx) >= 2) drag.moved = true;
    if (!drag.moved) return;
    const absolute = drag.clip.start + drag.time + deltaPx / drag.pps;
    const local = roundMs(roundToFrame(absolute, state.fps) - drag.clip.start);
    drag.current = clamp(local, 0, roundMs(drag.clip.duration));
    drag.mark.style.left = pxSpan(drag.clip.start + drag.current, 0, state.total, drag.pps).left + "px";
  }

  function onKeyframeDragEnd(event) {
    if (!keyframeDrag || event.pointerId !== keyframeDrag.pointerId) return;
    const finished = keyframeDrag;
    keyframeDrag = null;
    window.removeEventListener("pointermove", onKeyframeDragMove);
    window.removeEventListener("pointerup", onKeyframeDragEnd);
    window.removeEventListener("pointercancel", onKeyframeDragEnd);
    try {
      finished.mark.releasePointerCapture(finished.pointerId);
    } catch (error) {
      /* o ponteiro já pode ter sido liberado */
    }
    if (!finished.moved || sameKeyframeTime(finished.current, finished.time)) {
      positionKeyframeMarks(finished.clip);
      return;
    }
    queueKeyframe(finished.clip.id, { op: "move", time: finished.time, to: finished.current });
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

  /** `POST /api/clips/<id>/trim`; o offset de mídia é calculado no servidor, então recarrega a composição. */
  function trimClip(id, start) {
    mutationQueue = mutationQueue
      .then(async () => {
        const result = await mutate("POST", "/api/clips/" + encodeURIComponent(id) + "/trim", { start });
        if (result.payload && result.payload.history) applyHistory(result.payload.history);
        state.inspectorDirty = false;
        await refreshComposition();
        if (!result.ok) renderDiagnostics(inspectorDiagnostics, result.diagnostics);
      })
      .catch((error) => {
        renderDiagnostics(inspectorDiagnostics, [{ severity: "error", message: "Falha ao aparar: " + error.message }]);
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
    // Com um keyframe selecionado, Delete apaga o keyframe; o clip nunca some por este atalho.
    if (!mod && !event.altKey && (event.key === "Delete" || event.key === "Backspace") && state.selectedKeyframe !== null) {
      event.preventDefault();
      removeSelectedKeyframe();
      return;
    }
    // Sem keyframe selecionado, Delete/Backspace exclui o clip selecionado.
    if (!mod && !event.altKey && (event.key === "Delete" || event.key === "Backspace") && state.selectedId !== null) {
      event.preventDefault();
      deleteSelected();
      return;
    }
    if (!mod && !event.altKey && key === "k") {
      event.preventDefault();
      addKeyframe(state.keyframeProp);
      return;
    }
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
    if (mod && !event.altKey && !event.shiftKey && key === "c" && state.selectedId !== null) {
      event.preventDefault();
      copySelected();
      return;
    }
    if (mod && !event.altKey && !event.shiftKey && key === "v" && state.clipboard !== null) {
      event.preventDefault();
      pasteClipboard();
      return;
    }
    if (mod && !event.altKey && !event.shiftKey && key === "d" && state.selectedId !== null) {
      event.preventDefault();
      duplicateSelected();
      return;
    }
    if (!mod && !event.altKey && key === "s") {
      event.preventDefault();
      splitSelected();
      return;
    }
    if (!mod && !event.altKey && (event.key === "=" || event.key === "+")) {
      event.preventDefault();
      zoomBy(ZOOM_STEP);
      return;
    }
    if (!mod && !event.altKey && (event.key === "-" || event.key === "_")) {
      event.preventDefault();
      zoomBy(1 / ZOOM_STEP);
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
  deleteButton.addEventListener("click", () => deleteSelected());
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
  });

  /* Zoom da timeline (EDT-45): Ctrl+roda ancorada no ponteiro, botões e teclas. */
  timelineScroll.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      /* 100 px de roda de mouse = 1 passo de x1,15; gestos de pinça (deltas pequenos) dão passos menores. */
      const steps = clamp(-event.deltaY / (event.deltaMode === 1 ? 3 : 100), -3, 3);
      if (steps === 0) return;
      const rect = timelineScroll.getBoundingClientRect();
      zoomBy(Math.pow(ZOOM_STEP, steps), event.clientX - rect.left - gutterWidth());
    },
    { passive: false },
  );
  timelineScroll.addEventListener(
    "scroll",
    () => {
      scheduleRuler();
      scheduleWaveforms();
    },
    { passive: true },
  );
  zoomInButton.addEventListener("click", () => zoomBy(ZOOM_STEP));
  zoomOutButton.addEventListener("click", () => zoomBy(1 / ZOOM_STEP));
  zoomFitButton.addEventListener("click", () => zoomFitAll());
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      applyScale();
      redrawTimeline();
    }).observe(timelineScroll);
  }

  setInterval(() => {
    const timeMs = readPlayerTime();
    if (timeMs === null) return;
    const previous = state.playhead;
    state.playhead = state.total > 0 ? clamp(timeMs / 1000, 0, maxPlayhead()) : Math.max(0, timeMs / 1000);
    paintPlayhead();
    if (state.playhead !== previous) followPlayhead();
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
