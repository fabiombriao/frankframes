import { MAX_PX_PER_FRAME, chooseStep, clampZoom, lastFrameTime, isFrameLevel, nextTrack, peakSlice, pxSpan, roundToFrame, snap as snapTarget, snapMove, snapToFrame, tickLabel, trackGroup, trackRows, zoomAround } from "/timeline-math.js";
import { keyframeMarks, keyframePropsFor, renderKeyframeSection, renderMotionSection, renderTransitionSection } from "/motion.js";
import { compositionFields, compositionPatch, pastEndNotice } from "/composition.js";
import { activeCueIndex, captionFrame, displayNumber, numericChanges } from "/inspector.js";
import { fitPlayerBox, playerViewport } from "/player-fit.js";
import { createLayerEditor } from "/layers.js";

(() => {
  "use strict";

  /* Passo das setas ao mover o clip selecionado. */
  const NUDGE = 0.05;
  /* Ímã (EDT-44): distância em px da tela até onde a borda gruda. O limiar em segundos é SNAP_PX / pxPerSecond. */
  const SNAP_PX = 8;
  const MIN_DURATION = 0.1;
  /* Passo do zoom da timeline. */
  const ZOOM_STEP = 1.15;
  const FRAME_POLL_MS = 100;

  const fileNameEl = document.getElementById("fileName");
  const totalDurationEl = document.getElementById("totalDuration");
  const compositionFpsEl = document.getElementById("compositionFps");
  const durationKindEl = document.getElementById("durationKind");
  const compositionButton = document.getElementById("compositionButton");
  const compositionForm = document.getElementById("compositionForm");
  const compositionIdEl = document.getElementById("compositionId");
  const compDuration = document.getElementById("compDuration");
  const compDerived = document.getElementById("compDerived");
  const compWidth = document.getElementById("compWidth");
  const compHeight = document.getElementById("compHeight");
  const compFps = document.getElementById("compFps");
  const compositionNote = document.getElementById("compositionNote");
  const compositionFormDiagnostics = document.getElementById("compositionFormDiagnostics");
  const endNotice = document.getElementById("endNotice");
  const endNoticeText = document.getElementById("endNoticeText");
  const endNoticeButton = document.getElementById("endNoticeButton");
  const connectionEl = document.getElementById("connection");
  const player = document.getElementById("player");
  const playerPanel = document.getElementById("playerPanel");
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
  const clipTextFields = document.getElementById("clipTextFields");
  const inspectorPanel = inspector.closest(".inspector-panel");
  const applyButton = document.getElementById("applyButton");
  const layerDiagnostics = document.getElementById("layerDiagnostics");
  const layerEditor = createLayerEditor({
    player,
    button: document.getElementById("layersButton"),
    panel: document.getElementById("layerPanel"),
    overlay: document.getElementById("layerOverlay"),
    outline: document.getElementById("layerOutline"),
    dirtyChanged: () => updateExportButton(),
    showDiagnostics: (diagnostics) => renderDiagnostics(layerDiagnostics, diagnostics),
    save: async (changes) => {
      const result = await mutate("POST", "/api/layers", changes);
      if (result.ok) applyHistory(result.payload.history);
      else renderDiagnostics(layerDiagnostics, result.diagnostics);
      return result.ok ? result.payload.revision : null;
    },
  });
  const compositionDiagnostics = document.getElementById("compositionDiagnostics");
  const inspectorDiagnostics = document.getElementById("inspectorDiagnostics");
  const captionsSection = document.getElementById("captionsSection");
  const captionsStatus = document.getElementById("captionsStatus");
  const captionsDiagnostics = document.getElementById("captionsDiagnostics");
  const captionsList = document.getElementById("captionsList");
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
  const snapGuideEl = document.getElementById("snapGuide");
  const importButton = document.getElementById("importButton");
  const importInput = document.getElementById("importInput");
  const insertTextButton = document.getElementById("insertTextButton");
  const splitButton = document.getElementById("splitButton");
  const deleteButton = document.getElementById("deleteButton");
  const undoButton = document.getElementById("undoButton");
  const redoButton = document.getElementById("redoButton");
  const dropOverlay = document.getElementById("dropOverlay");
  const exportButton = document.getElementById("exportButton");
  const exportDialog = document.getElementById("exportDialog");
  const exportForm = document.getElementById("exportForm");
  const exportSetup = document.getElementById("exportSetup");
  const exportPreset = document.getElementById("exportPreset");
  const exportCodec = document.getElementById("exportCodec");
  const exportOutput = document.getElementById("exportOutput");
  const exportProgress = document.getElementById("exportProgress");
  const exportStages = document.getElementById("exportStages");
  const exportBar = document.getElementById("exportBar");
  const exportMessage = document.getElementById("exportMessage");
  const exportDiagnostics = document.getElementById("exportDiagnostics");
  const exportCloseButton = document.getElementById("exportClose");
  const exportCancelButton = document.getElementById("exportCancel");
  const exportRevealButton = document.getElementById("exportReveal");
  const exportAgainButton = document.getElementById("exportAgain");
  const exportStartButton = document.getElementById("exportStart");
  /* Estágios do pipeline, na ordem em que aparecem no progresso. */
  const EXPORT_STAGES = ["compile", "probe", "extract", "capture", "audio", "encode", "assemble"];
  const toolDiagnostics = document.getElementById("toolDiagnostics");
  /* Mesma folga do servidor: corte colado na borda geraria um pedaço vazio. */
  const MIN_SPLIT_PIECE = 0.001;

  const state = {
    clips: [],
    total: 0,
    fps: 30,
    /* Raiz como o arquivo a declara (EDT-84): id, durationKind, duration, width, height, fps, contentEnd. */
    composition: null,
    fileName: "index.html",
    selectedId: null,
    /* Área de transferência por referência: o id do clip copiado, não o conteúdo. */
    clipboard: null,
    /* Mudança no inspetor ainda não aplicada; o botão Exportar acompanha (só vale o que está salvo). */
    _inspectorDirty: false,
    get inspectorDirty() {
      return this._inspectorDirty;
    },
    set inspectorDirty(value) {
      this._inspectorDirty = value;
      updateExportButton();
    },
    playhead: 0,
    history: { canUndo: false, canRedo: false, undo: null, redo: null },
    busy: false,
    motionPresets: null,
    /* Legendas do host selecionado (EDT-97), ou null: { hostId, cues, rows, request, current }. */
    captions: null,
    /* Keyframe selecionado: { clipId, time } com o tempo local ao clip, em segundos. */
    selectedKeyframe: null,
    keyframeProp: "opacity",
    /* Escala da timeline (EDT-45): px por segundo. Em "ajustar" (zoomFit) o valor acompanha a largura visível. */
    pxPerSecond: 1,
    zoomFit: true,
    /* Waveform por fonte (mediaSrc): a promessa é buscada uma vez; o resultado fica em waveformResults. */
    waveforms: new Map(),
    waveformResults: new Map(),
    /* Ids de clips com data-track cujo elemento não é posicionado no preview (z-index sem efeito). */
    layerWarnings: new Set(),
    /* Pedidos de edição em andamento. */
    inflight: 0,
    /* Export (EDT-46): o job vem do servidor; exportView escolhe entre o formulário e o progresso. */
    exportJob: null,
    exportDefaults: null,
    exportView: "setup",
    exportShownId: null,
    exportSubmitting: false,
    exportCanceling: false,
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

  /* Instante sem ímã: o frame mais próximo, truncado em ms (ver floorMs), em qualquer zoom. */
  function toFrame(value) {
    return snapToFrame(value, state.fps);
  }

  /* Só exibição (3 casas): o valor que vai para o HTML nunca sai daqui. */
  function formatNumber(value) {
    return displayNumber(value);
  }

  /* Preenche um campo numérico e guarda o texto exibido: "Aplicar" só envia o que o usuário editou em cima dele. */
  function showField(element, text) {
    element.value = text;
    element.dataset.shown = text;
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
      textParts: Array.isArray(raw.textParts) ? raw.textParts : [],
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
      captions: raw.captions === true,
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
      output.push({
        severity,
        message: value.message,
        hint: typeof value.hint === "string" ? value.hint : undefined,
        code: typeof value.code === "string" ? value.code : undefined,
        clipId: typeof value.clipId === "string" ? value.clipId : undefined,
      });
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
    state.composition = {
      id: typeof data.id === "string" ? data.id : "",
      durationKind: data.durationKind === "authored" || data.durationKind === "derived" ? data.durationKind : "unresolved",
      duration: declared,
      width: asNumber(data.width),
      height: asNumber(data.height),
      fps: data.fps,
      contentEnd: asNumber(data.contentEnd),
    };
    state.playhead = clamp(state.playhead, 0, maxPlayhead());
    keepKeyframeSelection();

    fitPlayer();
    renderTop();
    renderTimeline();
    paintPlayhead();

    if (state.selectedId !== null && !findClip(state.selectedId)) {
      clearInspector();
    } else if (state.selectedId !== null) {
      updateSelectionStyles();
      if (!state.inspectorDirty) fillInspector();
    } else if (!state.inspectorDirty) {
      fillComposition();
    }
    /* A releitura vale mesmo com o inspetor sujo: desfazer e edição por fora mudam o arquivo das legendas. */
    const previousCaptions = state.captions;
    syncCaptions();
    if (previousCaptions !== null && state.captions === previousCaptions) loadCaptions();
    checkLayerEffect();
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
      renderEndNotice(pastEndNotice(diagnostics));
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
    const kind = state.composition === null ? "unresolved" : state.composition.durationKind;
    durationKindEl.textContent = kind === "authored" ? "fixa (data-duration)" : kind === "derived" ? "derivada dos clips" : "";
  }

  /*
   * Faixa sobre a timeline: o playhead e o preview param no fim autoral da raiz, então, se um clip passa dele,
   * o Studio diz isso em vez de cortar em silêncio (W_CLIP_PAST_END, docs/contract.md §7).
   */
  function renderEndNotice(notice) {
    endNotice.hidden = notice === null;
    durationKindEl.classList.toggle("is-warning", notice !== null);
    if (notice === null) {
      endNoticeText.textContent = "";
      endNotice.removeAttribute("title");
      return;
    }
    const subject = notice.count === 1 && notice.ids.length === 1 ? 'o clip "' + notice.ids[0] + '" passa' : notice.count + " clips passam";
    endNoticeText.textContent =
      "A composição termina em " + formatSeconds(state.total) + " (data-duration fixo) e " + subject + " do fim: o excedente não entra no preview nem no render.";
    endNotice.title = notice.message + (notice.hint ? " — " + notice.hint : "");
  }

  /* Inspetor de Composição (EDT-84): a raiz, quando nenhum clip está selecionado. */

  function compositionNoteText(data) {
    const end = data.contentEnd === null ? null : formatSeconds(data.contentEnd);
    if (data.durationKind === "authored") {
      return "Duração fixa pelo arquivo: clips depois dela não entram no preview nem no render." + (end === null ? "" : " Os clips vão até " + end + ".");
    }
    if (data.durationKind === "derived") return "Sem data-duration: a duração acompanha o fim do último clip (" + (end ?? "--") + ").";
    return "Duração não resolvida: informe data-duration ou dê duração aos clips.";
  }

  function fillComposition() {
    const data = state.composition;
    if (data === null) return;
    const fields = compositionFields(data);
    compositionIdEl.textContent = data.id;
    compDuration.value = fields.duration;
    compDerived.checked = fields.derived;
    compDuration.disabled = fields.derived;
    compWidth.value = fields.width;
    compHeight.value = fields.height;
    compFps.value = fields.fps;
    compositionNote.textContent = compositionNoteText(data);
    compositionForm.hidden = false;
    state.inspectorDirty = false;
  }

  /* Abre o inspetor de Composição (botão do topo e faixa de aviso): tira a seleção de clip e foca a duração. */
  function openComposition() {
    clearInspector();
    fillComposition();
    compositionForm.scrollIntoView({ block: "nearest" });
    (compDuration.disabled ? compDerived : compDuration).focus();
  }

  function submitComposition() {
    if (state.composition === null) return mutationQueue;
    const { body, error } = compositionPatch(state.composition, {
      duration: compDuration.value,
      derived: compDerived.checked,
      width: compWidth.value,
      height: compHeight.value,
      fps: compFps.value,
    });
    if (error !== null) {
      renderDiagnostics(compositionFormDiagnostics, [{ severity: "error", message: error }]);
      return mutationQueue;
    }
    if (body === null) {
      state.inspectorDirty = false;
      renderDiagnostics(compositionFormDiagnostics, [{ severity: "info", message: "Nada mudou na composição." }]);
      return mutationQueue;
    }
    return queueComposition(body);
  }

  /* POST /api/composition: contrato inválido volta como E_CONTRACT_INVALID e o arquivo fica como estava. */
  function queueComposition(body) {
    mutationQueue = mutationQueue
      .then(async () => {
        const result = await mutate("POST", "/api/composition", body);
        if (result.payload && result.payload.history) applyHistory(result.payload.history);
        if (result.ok) state.inspectorDirty = false;
        await refreshComposition();
        renderDiagnostics(compositionFormDiagnostics, result.ok ? [] : result.diagnostics);
      })
      .catch((error) => {
        renderDiagnostics(compositionFormDiagnostics, [{ severity: "error", message: "Falha ao salvar a composição: " + error.message }]);
      });
    return mutationQueue;
  }

  /* Inspector */

  function clearInspector() {
    state.selectedId = null;
    layerEditor.sync(null);
    state.inspectorDirty = false;
    inspector.hidden = true;
    fillComposition();
    motionSection.hidden = true;
    transitionSection.hidden = true;
    keyframeSection.hidden = true;
    state.selectedKeyframe = null;
    inspectorEmpty.hidden = false;
    renderDiagnostics(inspectorDiagnostics, []);
    updateSelectionStyles();
    syncCaptions();
  }

  function fillInspector() {
    const clip = state.selectedId === null ? null : findClip(state.selectedId);
    if (!clip) {
      clearInspector();
      return;
    }
    inspector.hidden = false;
    inspectorEmpty.hidden = true;
    compositionForm.hidden = true;
    clipTagEl.textContent = clip.tag;
    clipIdEl.textContent = clip.id;
    showField(fieldStart, formatNumber(clip.start));
    showField(fieldDuration, formatNumber(clip.duration));
    showField(fieldOffset, formatNumber(clip.offset));
    showField(fieldVolume, formatNumber(clip.volume));
    fieldRole.value = clip.role ?? "";
    showField(fieldRate, formatNumber(clip.playbackRate));
    clipTextFields.replaceChildren(...clip.textParts.map((part) => {
      const label = document.createElement("label");
      label.className = "text-field";
      const title = document.createElement("span");
      title.textContent = clip.textParts.length === 1 ? "Texto" : "Texto " + (part.index + 1) + " · " + part.tag;
      const field = document.createElement("textarea");
      field.dataset.textPart = String(part.index);
      field.rows = 2;
      field.defaultValue = part.text;
      label.append(title, field);
      return label;
    }));
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
    syncCaptions();
  }

  /* Legendas (EDT-97): o texto de cada legenda do host selecionado, editado aqui e gravado no arquivo delas. */

  /* Mostra a seção do host selecionado; trocar de host recomeça a lista e descarta o que não foi aplicado. */
  function syncCaptions() {
    const clip = state.selectedId === null ? null : findClip(state.selectedId);
    if (!clip || !clip.captions) {
      captionsSection.hidden = true;
      if (state.captions === null) return;
      state.captions = null;
      captionsList.replaceChildren();
      updateExportButton();
      return;
    }
    captionsSection.hidden = false;
    if (state.captions !== null && state.captions.hostId === clip.id) return;
    /* `request` numera as leituras: resposta atrasada não pinta por cima de uma mais nova. */
    state.captions = { hostId: clip.id, cues: [], rows: new Map(), request: 0, current: null };
    captionsList.replaceChildren();
    renderDiagnostics(captionsDiagnostics, []);
    captionsStatus.hidden = false;
    captionsStatus.textContent = "carregando";
    updateExportButton();
    loadCaptions();
  }

  /* Texto digitado e ainda não aplicado: como no resto do inspetor, o Exportar espera. */
  function captionsDirty() {
    if (state.captions === null) return false;
    for (const row of state.captions.rows.values()) {
      if (row.input.value !== row.input.dataset.serverText) return true;
    }
    return false;
  }

  /* No Studio a recusa mostra o código além da mensagem e do hint. */
  function withCodes(diagnostics, payload) {
    return diagnostics.map((item) => {
      const code = item.code ?? (payload && item.message === payload.message ? payload.code : undefined);
      return code ? { ...item, message: code + ": " + item.message } : item;
    });
  }

  async function loadCaptions() {
    const panel = state.captions;
    if (panel === null) return;
    panel.request += 1;
    const request = panel.request;
    const stale = () => state.captions !== panel || panel.request !== request;
    try {
      const response = await fetch("/api/captions/" + encodeURIComponent(panel.hostId), { cache: "no-store", headers: { accept: "application/json" } });
      const payload = await readJson(response);
      if (stale()) return;
      if (!response.ok) {
        renderCaptions(panel, []);
        const diagnostics = normalizeDiagnostics(payload);
        renderDiagnostics(
          captionsDiagnostics,
          diagnostics.length ? withCodes(diagnostics, payload) : [{ severity: "error", message: payload.message || "HTTP " + response.status }],
        );
        return;
      }
      renderDiagnostics(captionsDiagnostics, []);
      renderCaptions(panel, arrayOrEmpty(payload.cues));
    } catch (error) {
      if (stale()) return;
      renderDiagnostics(captionsDiagnostics, [{ severity: "error", message: "Não foi possível ler as legendas: " + error.message }]);
    }
  }

  /*
   * Atualiza as linhas no lugar: linha que continua não sai do DOM (o foco fica nela) e texto ainda não aplicado
   * não é sobrescrito. Os tempos mostrados são os da timeline (início do host mais o da legenda).
   */
  function renderCaptions(panel, cues) {
    panel.cues = cues;
    const host = findClip(panel.hostId);
    const base = host !== null && host.start !== null ? host.start : 0;
    const keep = new Set(cues.map((cue) => cue.id));
    for (const [id, row] of panel.rows) {
      if (keep.has(id)) continue;
      row.item.remove();
      panel.rows.delete(id);
    }
    cues.forEach((cue, index) => {
      let row = panel.rows.get(cue.id);
      if (row === undefined) {
        row = createCaptionRow(panel, cue.id);
        panel.rows.set(cue.id, row);
      }
      row.time.textContent = formatSeconds(base + cue.start) + " – " + formatSeconds(base + cue.end);
      if (row.input.value === row.input.dataset.serverText) row.input.value = cue.text;
      row.input.dataset.serverText = cue.text;
      if (captionsList.children[index] !== row.item) captionsList.insertBefore(row.item, captionsList.children[index] ?? null);
    });
    captionsStatus.hidden = true;
    panel.current = undefined;
    paintCurrentCaption();
    updateExportButton();
  }

  function createCaptionRow(panel, cueId) {
    const item = document.createElement("li");
    item.className = "caption-row";
    item.dataset.cueId = cueId;
    const form = document.createElement("form");
    form.noValidate = true;
    const time = document.createElement("button");
    time.type = "button";
    time.className = "caption-time";
    time.title = "Levar o playhead ao início desta legenda";
    const edit = document.createElement("div");
    edit.className = "caption-edit";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "caption-text";
    input.autocomplete = "off";
    input.enterKeyHint = "done";
    input.setAttribute("aria-label", "Texto da legenda " + cueId);
    input.dataset.serverText = "";
    const apply = document.createElement("button");
    apply.type = "submit";
    apply.className = "primary-button caption-apply";
    apply.textContent = "Aplicar";
    const diagnostics = document.createElement("div");
    diagnostics.className = "diagnostics";
    diagnostics.setAttribute("role", "status");
    edit.append(input, apply);
    form.append(time, edit, diagnostics);
    item.append(form);

    time.addEventListener("click", () => {
      const host = findClip(panel.hostId);
      const cue = panel.cues.find((entry) => entry.id === cueId);
      if (host !== null && host.start !== null && cue !== undefined) seekPreview(host.start + cue.start);
    });
    input.addEventListener("input", () => updateExportButton());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      queueCaption(panel.hostId, input, diagnostics, cueId);
    });
    return { item, time, input, diagnostics };
  }

  /* POST /api/captions/<host>/<legenda>; recusa aparece na própria linha, com o arquivo intacto. */
  function queueCaption(hostId, input, diagnostics, cueId) {
    const text = input.value;
    mutationQueue = mutationQueue
      .then(async () => {
        const result = await mutate("POST", "/api/captions/" + encodeURIComponent(hostId) + "/" + encodeURIComponent(cueId), { text });
        if (result.payload && result.payload.history) applyHistory(result.payload.history);
        if (!result.ok) {
          renderDiagnostics(diagnostics, withCodes(result.diagnostics, result.payload));
          return;
        }
        renderDiagnostics(diagnostics, []);
        /* O que foi enviado deixa de ser rascunho: a releitura traz o texto como ficou no arquivo. */
        input.dataset.serverText = text;
        updateExportButton();
        await refreshComposition();
      })
      .catch((error) => {
        renderDiagnostics(diagnostics, [{ severity: "error", message: "Falha ao salvar a legenda: " + error.message }]);
      });
    return mutationQueue;
  }

  /* Marca a legenda sob o playhead e a mantém à vista; com o foco na lista, a rolagem fica com quem edita. */
  function paintCurrentCaption() {
    const panel = state.captions;
    if (panel === null) return;
    const host = findClip(panel.hostId);
    let id = null;
    if (host !== null && host.start !== null) {
      const local = state.playhead - host.start;
      const inside = host.duration === null || local < host.duration - 0.0005;
      const index = inside ? activeCueIndex(panel.cues, local) : -1;
      if (index >= 0) id = panel.cues[index].id;
    }
    if (id === panel.current) return;
    panel.current = id;
    for (const [cueId, row] of panel.rows) {
      row.item.classList.toggle("is-current", cueId === id);
      if (cueId === id) row.item.setAttribute("aria-current", "true");
      else row.item.removeAttribute("aria-current");
    }
    const current = id === null ? undefined : panel.rows.get(id);
    if (current === undefined || captionsList.contains(document.activeElement)) return;
    const top = current.item.offsetTop;
    const bottom = top + current.item.offsetHeight;
    if (top < captionsList.scrollTop) captionsList.scrollTop = top;
    else if (bottom > captionsList.scrollTop + captionsList.clientHeight) captionsList.scrollTop = bottom - captionsList.clientHeight;
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
    const changed = state.selectedId !== id || inspector.hidden;
    if (!changed && state.inspectorDirty) return;
    if (state.selectedKeyframe !== null && state.selectedKeyframe.clipId !== id) state.selectedKeyframe = null;
    state.selectedId = id;
    layerEditor.sync(id);
    state.inspectorDirty = false;
    updateSelectionStyles();
    fillInspector();
    if (changed) inspectorPanel.scrollTop = 0;
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
    insertTextButton.disabled = state.busy;
    updateExportButton();
  }

  /* Exportar (EDT-46) */

  function exportRunning() {
    return state.exportJob !== null && state.exportJob.status === "running";
  }

  /* Com export rodando o botão reabre o progresso; senão só vale sem edição pendente nem inspetor sujo. */
  function updateExportButton() {
    const running = exportRunning();
    const blocked = !running && (state.busy || state.inflight > 0 || state.inspectorDirty || captionsDirty() || layerEditor.dirty());
    exportButton.disabled = blocked || state.exportDefaults === null;
    exportButton.textContent = running ? "Exportando " + Math.round(state.exportJob.percent) + "%" : "Exportar";
    exportButton.title = blocked
      ? "aplique as alterações antes de exportar"
      : running
        ? "Ver o progresso do export"
        : "Exportar o vídeo (renderiza o arquivo salvo)";
  }

  function applyExportJob(job) {
    state.exportJob = job;
    if (job !== null && job.id === state.exportShownId) state.exportView = "job";
    renderExport();
  }

  async function loadExport() {
    try {
      const response = await fetch("/api/export", { cache: "no-store", headers: { accept: "application/json" } });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(payload.message || "HTTP " + response.status);
      state.exportDefaults = payload.defaults;
      state.exportJob = payload.job;
      fillExportForm();
      renderExport();
    } catch (error) {
      renderDiagnostics(toolDiagnostics, [{ severity: "error", message: "Não foi possível ler o estado do export: " + error.message }]);
    }
  }

  function fillExportForm() {
    const defaults = state.exportDefaults;
    if (defaults === null) return;
    if (exportPreset.options.length === 0) {
      for (const name of defaults.presets) exportPreset.add(new Option(name, name));
      exportPreset.value = defaults.presets.includes("standard") ? "standard" : defaults.presets[0];
    }
    if (exportCodec.options.length === 0) {
      for (const name of defaults.codecs) exportCodec.add(new Option(name, name));
      exportCodec.value = defaults.codecs[0];
    }
    if (exportOutput.value === "") exportOutput.value = defaults.output;
  }

  /* Trocar o codec troca a extensão do destino (vp9 = .webm; av1 e h264 = .mp4). */
  function syncExportExtension() {
    const wanted = exportCodec.value === "vp9" ? ".webm" : ".mp4";
    exportOutput.value = exportOutput.value.replace(/\.(mp4|webm)$/i, wanted);
  }

  function exportJobDiagnostics(job) {
    if (job.status === "failed" && job.error) {
      const items = [
        { severity: "error", message: job.error.code + (job.error.stage ? " (" + job.error.stage + ")" : "") + ": " + job.error.message },
      ];
      for (const item of job.error.diagnostics || []) {
        items.push({ severity: item.severity === "warning" ? "warning" : "error", message: item.code + (item.clipId ? " [" + item.clipId + "]" : "") });
      }
      return items;
    }
    if (job.status === "done") return job.warnings.map((message) => ({ severity: "warning", message }));
    return [];
  }

  function renderExport() {
    updateExportButton();
    if (!exportDialog.open) return;
    const job = state.exportJob;
    const showJob = state.exportView === "job" && job !== null;
    exportSetup.hidden = showJob;
    exportProgress.hidden = !showJob;
    exportStartButton.hidden = showJob;
    exportStartButton.disabled = state.exportSubmitting;
    exportCancelButton.hidden = !(showJob && job.status === "running");
    exportCancelButton.disabled = state.exportCanceling;
    exportRevealButton.hidden = !(showJob && job.status === "done");
    exportAgainButton.hidden = !(showJob && job.status !== "running");
    if (!showJob) return;

    const current = job.stage === null ? -1 : EXPORT_STAGES.indexOf(job.stage);
    exportStages.replaceChildren(
      ...EXPORT_STAGES.map((name, index) => {
        const item = document.createElement("li");
        item.textContent = name;
        if (job.status === "done" || index < current) item.className = "is-done";
        else if (index === current && job.status === "running") item.className = "is-current";
        return item;
      }),
    );
    exportBar.value = job.status === "done" ? 100 : job.percent;
    if (job.status === "running") exportMessage.textContent = job.stage === null ? "iniciando…" : job.stage + " · " + Math.round(job.percent) + "%";
    else if (job.status === "done") exportMessage.textContent = "Exportado: " + job.output;
    else if (job.status === "canceled") exportMessage.textContent = "Export cancelado; nenhum arquivo foi gravado.";
    else exportMessage.textContent = "O export falhou.";
    renderDiagnostics(exportDiagnostics, exportJobDiagnostics(job));
  }

  function openExportDialog() {
    if (state.exportDefaults === null) return;
    state.exportView = exportRunning() ? "job" : "setup";
    state.exportShownId = exportRunning() ? state.exportJob.id : null;
    renderDiagnostics(exportDiagnostics, []);
    fillExportForm();
    if (!exportDialog.open) exportDialog.showModal();
    renderExport();
  }

  async function submitExport(overwrite) {
    state.exportSubmitting = true;
    renderExport();
    try {
      // Edição pendente termina antes: o export lê o arquivo que está salvo.
      await mutationQueue;
      if (state.inspectorDirty) {
        renderDiagnostics(exportDiagnostics, [{ severity: "error", message: "Há alterações do inspetor sem aplicar; aplique antes de exportar." }]);
        return;
      }
      const body = { preset: exportPreset.value, codec: exportCodec.value, output: exportOutput.value };
      if (overwrite === true) body.overwrite = true;
      const result = await mutate("POST", "/api/export", body);
      if (!result.ok) {
        const code = result.payload ? result.payload.code : null;
        if (code === "E_EXPORT_EXISTS" && overwrite !== true) {
          const name = exportOutput.value.split(/[\\/]/).pop();
          if (window.confirm("Substituir " + name + "?")) {
            state.exportSubmitting = false;
            await submitExport(true);
          }
          return;
        }
        renderDiagnostics(exportDiagnostics, result.diagnostics);
        return;
      }
      renderDiagnostics(exportDiagnostics, []);
      state.exportShownId = result.payload.id;
      state.exportView = "job";
      await loadExport();
    } finally {
      state.exportSubmitting = false;
      renderExport();
    }
  }

  async function cancelExport() {
    state.exportCanceling = true;
    renderExport();
    try {
      const result = await mutate("POST", "/api/export/cancel", {});
      if (!result.ok) renderDiagnostics(exportDiagnostics, result.diagnostics);
      await loadExport();
    } finally {
      state.exportCanceling = false;
      renderExport();
    }
  }

  async function revealExport() {
    const result = await mutate("POST", "/api/export/reveal", {});
    if (!result.ok) renderDiagnostics(exportDiagnostics, result.diagnostics);
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
      const body = mode === "paste" ? { at: toFrame(Math.max(0, state.playhead)) } : {};
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
      let start = toFrame(Math.max(0, state.playhead));
      const notes = [];
      let lastId = null;
      for (const file of list) {
        notes.push({ severity: "info", message: "Enviando " + file.name + "…" });
        renderDiagnostics(toolDiagnostics, notes);
        let payload;
        let response;
        try {
          response = await fetch(
            "/api/media?name=" + encodeURIComponent(file.name) + "&start=" + encodeURIComponent(String(start)),
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
        // Vários arquivos de uma vez entram em sequência, um depois do outro; o início segue exato (sem arredondar a ms).
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

    /* Só vai o campo que o usuário editou (texto diferente do exibido): o resto fica byte a byte no HTML. */
    const numericFields = [
      [fieldStart, "data-start"],
      [fieldDuration, "data-duration"],
      [fieldOffset, "data-offset"],
      [fieldVolume, "data-volume"],
      [fieldRate, "data-playback-rate"],
    ];
    const changes = numericChanges(
      numericFields.map(([element, key]) => ({
        key,
        shown: element.dataset.shown ?? "",
        text: element.value,
        original: originalFor(clip, key),
      })),
    );
    const attributes = changes.attributes;
    const errors = changes.errors.map((message) => ({ severity: "error", message }));

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

    const textParts = Array.from(clipTextFields.querySelectorAll("[data-text-part]")).flatMap((field) => {
      const index = Number(field.dataset.textPart);
      const original = field.defaultValue;
      return field.value === original ? [] : [{ index, original, text: field.value }];
    });
    if (!Object.keys(attributes).length && textParts.length === 0) {
      renderDiagnostics(inspectorDiagnostics, [{ severity: "info", message: "Nenhuma alteração para aplicar." }]);
      return;
    }

    const body = { attributes };
    if (textParts.length > 0) body.textParts = textParts;

    applyButton.disabled = true;
    try {
      const result = await mutate("POST", "/api/clips/" + encodeURIComponent(clip.id), body);
      if (!result.ok) {
        renderDiagnostics(inspectorDiagnostics, result.diagnostics);
        return;
      }
      applyHistory(result.payload.history);
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

  /* Uma linha por (tipo, faixa); clips que se sobrepõem na mesma linha ganham sub-raias (docs/contract.md §9d). */
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

    const rows = trackRows(state.clips);
    const hasVisual = rows.some((row) => row.group === "visual");
    const hasAudio = rows.some((row) => row.group === "audio");
    if (hasVisual) timelineRows.append(trackZone("visual"));
    for (const row of rows) timelineRows.append(trackRowElement(row));
    if (hasAudio) timelineRows.append(trackZone("audio"));

    timelineScroll.scrollTop = scrollTop;
    timelineScroll.scrollLeft = scrollLeft;
    scheduleWaveforms();
  }

  /* Zona "+ nova faixa": solta aqui, o clip ganha a próxima faixa do grupo (acima da maior, ou abaixo da última de áudio). */
  function trackZone(group) {
    const zone = document.createElement("div");
    zone.className = "track-zone";
    zone.dataset.group = group;
    zone.dataset.track = String(nextTrack(state.clips, group));
    const label = document.createElement("div");
    label.className = "row-label";
    label.textContent = "+ nova faixa";
    const lane = document.createElement("div");
    lane.className = "lane";
    zone.append(label, lane);
    return zone;
  }

  function trackRowElement(row) {
    const rowEl = document.createElement("div");
    rowEl.className = "timeline-row";
    rowEl.dataset.rowKey = row.key;
    rowEl.dataset.group = row.group;
    rowEl.dataset.track = String(row.track);

    const label = document.createElement("div");
    label.className = "row-label";
    const tag = document.createElement("span");
    tag.className = "row-tag";
    tag.textContent = row.label;
    const name = document.createElement("span");
    name.className = "row-name";
    name.textContent = row.kind === "audio" ? "áudio" : row.kind === "video" ? "vídeo" : "texto";
    label.append(tag, name);

    const lane = document.createElement("div");
    lane.className = "lane";
    for (const clips of row.lanes) {
      const sub = document.createElement("div");
      sub.className = "sublane";
      for (const clip of clips) appendClip(sub, clip);
      lane.append(sub);
    }
    rowEl.append(label, lane);
    return rowEl;
  }

  /* Barra do clip + faixa de transição + losangos de keyframe, na sub-raia dele. */
  function appendClip(sub, clip) {
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

    const title = document.createElement("span");
    title.className = "bar-name";
    title.textContent = clip.id;
    bar.append(title);
    if (state.layerWarnings.has(clip.id)) {
      const warn = document.createElement("span");
      warn.className = "bar-warn";
      warn.textContent = "⚠";
      warn.title = "camada sem efeito: elemento não posicionado";
      bar.append(warn);
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

    sub.append(bar);
    const strip = transitionStrip(clip);
    if (strip !== null) sub.append(strip);
    for (const mark of keyframeMarkElements(clip)) sub.append(mark);
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
      if (clip.start !== null) showField(fieldStart, formatNumber(clip.start));
      if (clip.duration !== null) showField(fieldDuration, formatNumber(clip.duration));
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
    paintCurrentCaption();
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
    if (clip.start === null || state.total <= 0) {
      seekTimeline(event.clientX);
      return;
    }

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
      originY: event.clientY,
      originTrack: clip.track,
      /* Faixa de destino ao soltar: a mesma do clip até o ponteiro entrar numa linha válida. */
      targetTrack: clip.track,
      targetEl: null,
      candidates: snapCandidates(clip.id),
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

  /**
   * Alvos do ímã: início e fim dos outros clips de topo (os aninhados têm tempo local), o playhead e as pontas
   * da composição. Fora o próprio clip arrastado.
   */
  function snapCandidates(excludeId) {
    const list = [0, state.playhead];
    if (state.total > 0) list.push(state.total);
    for (const other of state.clips) {
      if (other.id === excludeId || other.parentId !== null || other.start === null) continue;
      list.push(other.start);
      if (other.end !== null) list.push(other.end);
    }
    return list;
  }

  function paintSnapGuide(time) {
    snapGuideEl.hidden = time === null;
    if (time !== null) snapGuideEl.style.left = time * state.pxPerSecond + "px";
  }

  /** Linha ou zona sob o ponteiro (só pela geometria: a barra arrastada está deslocada e taparia o hit-test). */
  function dropTargetAt(clientY) {
    for (const el of timelineRows.children) {
      const box = el.getBoundingClientRect();
      if (clientY >= box.top && clientY < box.bottom) return el;
    }
    return null;
  }

  function clearDropMarks() {
    for (const el of timelineRows.children) el.classList.remove("is-drop-target", "is-drop-invalid");
  }

  /** Move a barra com o ponteiro na vertical e escolhe a linha de destino; só o mesmo grupo (visual/áudio) vale. */
  function updateDropTarget(event) {
    const clip = drag.clip;
    drag.bar.classList.add("is-dragging");
    drag.bar.style.transform = "translateY(" + (event.clientY - drag.originY) + "px)";
    clearDropMarks();
    const el = dropTargetAt(event.clientY);
    drag.targetEl = null;
    drag.targetTrack = drag.originTrack;
    if (el === null || el.dataset.track === undefined) return;
    const valid = el.dataset.group === trackGroup(clip.kind);
    el.classList.add(valid ? "is-drop-target" : "is-drop-invalid");
    if (!valid) return;
    drag.targetEl = el;
    drag.targetTrack = Number(el.dataset.track);
  }

  function onDragMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaPx = event.clientX - drag.originX;
    if (Math.abs(deltaPx) >= 2) drag.moved = true;
    if (drag.mode === "move" && Math.abs(event.clientY - drag.originY) >= 2) drag.moved = true;
    if (!drag.moved) return;
    const deltaSeconds = deltaPx / drag.pps;
    const threshold = SNAP_PX / drag.pps;
    /* Alt desliga o ímã: o instante cai no frame mais próximo. */
    const magnet = !event.altKey;
    let guide = null;

    if (drag.mode === "move") {
      const raw = Math.max(0, drag.originStart + deltaSeconds);
      const duration = drag.clip.duration ?? 0;
      const hit = magnet ? snapMove(raw, duration, drag.candidates, threshold) : { t: raw, guide: null };
      drag.clip.start = hit.guide === null ? toFrame(raw) : Math.max(0, hit.t);
      guide = hit.guide;
      if (drag.clip.duration !== null) drag.clip.end = drag.clip.start + drag.clip.duration;
      updateDropTarget(event);
    } else if (drag.mode === "trim-start") {
      // O fim fica parado; o início para na borda da fonte (mídia), em 0 e a MIN_DURATION do fim.
      const media = drag.clip.kind === "video" || drag.clip.kind === "audio";
      const rate = drag.clip.playbackRate > 0 ? drag.clip.playbackRate : 1;
      const lowest = media ? Math.max(0, drag.originStart - drag.originOffset / rate) : 0;
      const highest = Math.max(lowest, drag.originEnd - MIN_DURATION);
      const raw = drag.originStart + deltaSeconds;
      const hit = magnet ? snapTarget(raw, drag.candidates, threshold) : { t: raw, guide: null };
      const wanted = hit.guide === null ? roundToFrame(raw, state.fps) : hit.t;
      const start = clamp(wanted, lowest, highest);
      guide = hit.guide !== null && start === hit.t ? hit.guide : null;
      drag.clip.start = start;
      drag.clip.duration = drag.originEnd - start;
      drag.clip.end = drag.originEnd;
      if (media) drag.clip.offset = drag.originOffset + (start - drag.originStart) * rate;
    } else {
      const start = drag.clip.start ?? 0;
      const raw = drag.originStart + drag.originDuration + deltaSeconds;
      const hit = magnet ? snapTarget(raw, drag.candidates, threshold) : { t: raw, guide: null };
      const end = hit.guide === null ? toFrame(raw) : hit.t;
      drag.clip.duration = Math.max(MIN_DURATION, end - start);
      guide = hit.guide !== null && end - start >= MIN_DURATION ? hit.guide : null;
      drag.clip.end = drag.clip.start === null ? null : drag.clip.start + drag.clip.duration;
    }
    paintSnapGuide(guide);
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
    paintSnapGuide(null);
    clearDropMarks();
    finished.bar.style.transform = "";
    finished.bar.classList.remove("is-dragging");
    if (!finished.moved) {
      if (event.type === "pointerup" && finished.mode === "move") seekTimeline(finished.originX);
      return;
    }
    if (event.type === "pointercancel") {
      finished.clip.start = finished.originStart;
      finished.clip.duration = finished.originDuration;
      finished.clip.end = finished.originEnd;
      finished.clip.offset = finished.originOffset;
      updateBarGeometry(finished.clip, finished.bar);
      return;
    }

    if (finished.mode === "trim-start") {
      if (finished.clip.start !== finished.originStart) trimClip(finished.clip.id, finished.clip.start);
    } else if (finished.mode === "move") {
      /* Faixa e início saem num PATCH só: um passo no histórico, um desfazer. */
      const attributes = {};
      if (finished.clip.start !== finished.originStart) attributes["data-start"] = formatNumber(finished.clip.start);
      const trackChanged = finished.targetTrack !== finished.originTrack;
      if (trackChanged) attributes["data-track"] = String(finished.targetTrack);
      if (Object.keys(attributes).length === 0) return;
      if (trackChanged) {
        finished.clip.track = finished.targetTrack;
        renderTimeline();
      }
      queuePatch(finished.clip.id, attributes);
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
    const next = Math.max(0, Math.round((clip.start + direction * NUDGE) / NUDGE) * NUDGE);
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

  /* Bloco do catálogo (EDT-88): o servidor copia o bloco para o projeto e insere o próprio bloco (sub-composição) no playhead. */
  async function insertBlock(block, button) {
    const slug = typeof block.slug === "string" ? block.slug : "";
    const name = String(block.name ?? slug);
    if (!slug) {
      renderDiagnostics(blocksDiagnostics, [{ severity: "error", message: "Bloco sem slug: " + name }]);
      return;
    }
    const start = toFrame(Math.max(0, state.playhead));
    button.disabled = true;
    try {
      const result = await mutate("POST", "/api/blocks", { slug, start });
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
        : [{ severity: "info", message: "Bloco " + name + " inserido em " + formatSeconds(start) + " (arquivos em " + payloadDir(result.payload.src) + ")." }];
      renderDiagnostics(blocksDiagnostics, diagnostics);
    } finally {
      button.disabled = false;
    }
  }

  function payloadDir(src) {
    const text = typeof src === "string" ? src : "";
    const cut = text.lastIndexOf("/");
    return cut > 0 ? text.slice(0, cut + 1) : text;
  }

  /* Texto simples no playhead: o único template do servidor; nunca substitui um bloco do catálogo. */
  async function insertText() {
    const start = toFrame(Math.max(0, state.playhead));
    return runTool(async () => {
      const result = await mutate("POST", "/api/clips", { template: "text", start, duration: 3 });
      if (result.payload && result.payload.history) applyHistory(result.payload.history);
      if (!result.ok) {
        renderDiagnostics(toolDiagnostics, result.diagnostics);
        return;
      }
      state.inspectorDirty = false;
      await refreshComposition();
      const id = typeof result.payload.id === "string" ? result.payload.id : null;
      if (id && findClip(id)) selectClip(id);
      renderDiagnostics(toolDiagnostics, [{ severity: "info", message: "Texto inserido em " + formatSeconds(start) + "." }]);
    });
  }

  /* Mutação */

  async function mutate(method, url, body) {
    state.inflight += 1;
    updateExportButton();
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
    } finally {
      state.inflight -= 1;
      updateExportButton();
    }
  }

  /* Player, eventos e atalhos */

  let lastPlayerFit = "";

  /* O viewport do preview é o da raiz (data-width/data-height), a mesma fonte do render; escala para caber sem cortar. */
  function fitPlayer() {
    const style = getComputedStyle(playerPanel);
    const available = {
      width: playerPanel.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height: playerPanel.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    };
    if (!(available.width > 0) || !(available.height > 0)) return;
    const viewport = playerViewport(state.composition);
    const key = [available.width, available.height, viewport.width, viewport.height].join("x");
    if (key === lastPlayerFit) return;
    lastPlayerFit = key;
    const box = fitPlayerBox(available, viewport);
    player.style.width = viewport.width + "px";
    player.style.height = viewport.height + "px";
    player.style.transform = "scale(" + box.scale + ")";
    playerFrame.style.width = box.frameWidth + "px";
    playerFrame.style.height = box.frameHeight + "px";
    playerFrame.style.left = parseFloat(style.paddingLeft) + box.left + "px";
    playerFrame.style.top = parseFloat(style.paddingTop) + box.top + "px";
  }

  function observePlayerSize() {
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => fitPlayer());
    observer.observe(playerPanel);
  }

  /* Último erro do relógio do preview já mostrado, para não repetir o aviso a cada poll. */
  let reportedLiveError = 0;

  function readPlayerTime() {
    let win;
    try {
      win = player.contentWindow;
      if (win && win.__ff && typeof win.__ff.now === "function") {
        const value = Number(win.__ff.now());
        if (!Number.isFinite(value)) {
          setConnection("preview: relógio devolveu instante inválido", true);
          return null;
        }
        const errors = win.__ff.liveErrors;
        if (Array.isArray(errors) && errors.length > reportedLiveError) {
          reportedLiveError = errors.length;
          setConnection("preview: " + errors[errors.length - 1], true);
        }
        return value;
      }
    } catch (error) {
      setConnection("preview inacessível: " + (error && error.message ? error.message : error), true);
    }
    return null;
  }

  /* O preview guarda e restaura o próprio instante e o estado de play (pagehide, em preview-ui): o Studio só recarrega. */
  function reloadPreview() {
    reportedLiveError = 0;
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
    source.addEventListener("export", (event) => {
      try {
        applyExportJob(JSON.parse(event.data));
      } catch (error) {
        renderDiagnostics(toolDiagnostics, [{ severity: "error", message: "Evento de export ilegível: " + error.message }]);
      }
    });
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

  /* O scrub da própria barra pausa e busca o frame. As legendas usam o primeiro frame visível. */
  function seekPreview(seconds, nearest = false) {
    let view = null;
    let range = null;
    try {
      view = player.contentWindow;
      range = player.contentDocument ? player.contentDocument.querySelector("[data-ff-scrub]") : null;
    } catch (error) {
      setConnection("preview inacessível: " + error.message, true);
      return;
    }
    const meta = view === null ? undefined : view.__ffPreviewMeta;
    if (range === null || !meta || !meta.fps) {
      setConnection("preview sem barra de controle", true);
      return;
    }
    const frame = nearest ? Math.round(seconds * meta.fps.num / meta.fps.den) : captionFrame(seconds, meta.fps);
    range.value = String(frame);
    range.dispatchEvent(new view.Event("input"));
  }

  function seekTimeline(clientX) {
    if (state.total <= 0) return;
    const seconds = (clientX - ruler.getBoundingClientRect().left) / state.pxPerSecond;
    seekPreview(clamp(seconds, 0, maxPlayhead()), true);
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

  function historyShortcut(event) {
    if (event.defaultPrevented || event.altKey || (!event.ctrlKey && !event.metaKey)) return false;
    const key = event.key.toLowerCase();
    if (key !== "z" && (key !== "y" || event.shiftKey)) return false;
    const target = event.target;
    if (target?.isContentEditable ||
        target?.matches?.("textarea, input:not([type=range]):not([type=checkbox]):not([type=radio])")) return false;
    event.preventDefault();
    travel(key === "y" || event.shiftKey ? "redo" : "undo");
    return true;
  }

  document.addEventListener("keydown", (event) => {
    if (event.code === "Space" && !isTyping(event)) {
      event.preventDefault();
      togglePlayback();
      return;
    }
    if (historyShortcut(event) || event.defaultPrevented || isTyping(event)) return;
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
  insertTextButton.addEventListener("click", () => insertText());
  splitButton.addEventListener("click", () => splitSelected());
  deleteButton.addEventListener("click", () => deleteSelected());
  undoButton.addEventListener("click", () => travel("undo"));
  redoButton.addEventListener("click", () => travel("redo"));
  exportButton.addEventListener("click", () => openExportDialog());
  exportCodec.addEventListener("change", syncExportExtension);
  exportForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitExport(false);
  });
  exportCloseButton.addEventListener("click", () => exportDialog.close());
  exportCancelButton.addEventListener("click", () => cancelExport());
  exportRevealButton.addEventListener("click", () => revealExport());
  exportAgainButton.addEventListener("click", () => {
    state.exportView = "setup";
    state.exportShownId = null;
    renderDiagnostics(exportDiagnostics, []);
    renderExport();
  });

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
  /* Camada sem efeito (EDT-44): clip visual com data-track cujo elemento é estático no preview — o z-index não vale. */
  function checkLayerEffect() {
    const doc = player.contentDocument;
    const view = doc ? doc.defaultView : null;
    if (!doc || !view) return;
    const warned = new Set();
    for (const clip of state.clips) {
      if (clip.kind === "audio") continue;
      const el = doc.querySelector('[data-clip-id="' + CSS.escape(clip.id) + '"]');
      if (el === null || !el.hasAttribute("data-track")) continue;
      if (view.getComputedStyle(el).position === "static") warned.add(clip.id);
    }
    const same = warned.size === state.layerWarnings.size && [...warned].every((id) => state.layerWarnings.has(id));
    if (same) return;
    state.layerWarnings = warned;
    if (drag === null) renderTimeline();
  }
  player.addEventListener("load", checkLayerEffect);
  player.contentDocument?.addEventListener("keydown", historyShortcut);
  player.addEventListener("load", () => {
    const doc = player.contentDocument;
    if (!doc) return;
    doc.addEventListener("keydown", historyShortcut);
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

  compositionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitComposition();
  });
  compositionForm.addEventListener("input", () => {
    state.inspectorDirty = true;
  });
  /* "Derivada" tira data-duration; ao desmarcar, a caixa já vem com o fim dos clips para não ficar vazia. */
  compDerived.addEventListener("change", () => {
    compDuration.disabled = compDerived.checked;
    if (!compDerived.checked && compDuration.value === "" && state.composition !== null && state.composition.contentEnd !== null) {
      compDuration.value = formatNumber(state.composition.contentEnd);
    }
    state.inspectorDirty = true;
  });
  compositionButton.addEventListener("click", openComposition);
  endNoticeButton.addEventListener("click", openComposition);

  inspector.addEventListener("input", () => {
    state.inspectorDirty = true;
  });

  inspector.addEventListener("change", () => {
    state.inspectorDirty = true;
  });

  window.addEventListener("resize", () => {
    fitPlayer();
  });

  timelineCanvas.addEventListener("click", (event) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (!event.target.closest(".ruler, .lane") || event.target.closest("button")) return;
    seekTimeline(event.clientX);
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
    layerEditor.paint();
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
  loadExport();
  connectEvents();
})();
