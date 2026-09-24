const QUALITY_PROFILE_NAMES = new Set(["high", "balanced", "mobile"]);
const QUALITY_MODE_NAMES = new Set(["auto", ...QUALITY_PROFILE_NAMES]);
const DISPLAY_PRESET_NAMES = new Set(["faithful", "presentation"]);

export const QUALITY_PROFILES = Object.freeze({
  high: Object.freeze({
    label: "High",
    minimumRenderScale: 1,
    overlayDprCap: 2,
    shadowScale: 1,
    environmentPolicy: "configured",
    textureLimitHint: 4096,
  }),
  balanced: Object.freeze({
    label: "Balanced",
    minimumRenderScale: 0.65,
    overlayDprCap: 1.5,
    shadowScale: 0.65,
    environmentPolicy: "configured",
    textureLimitHint: 2048,
  }),
  mobile: Object.freeze({
    label: "Mobile",
    minimumRenderScale: 0.35,
    overlayDprCap: 1,
    shadowScale: 0,
    environmentPolicy: "configured",
    textureLimitHint: 1024,
  }),
});

export const DISPLAY_PRESETS = Object.freeze({
  faithful: Object.freeze({
    label: "SketchUp-like / Faithful",
    environmentImage: "neutral",
    toneMapping: "neutral",
    exposure: 1,
    shadowIntensity: 0.28,
    shadowSoftness: 1.1,
  }),
  presentation: Object.freeze({ label: "Presentation" }),
});

const state = {
  modelViewer: null,
  mode: "auto",
  selectedProfile: "balanced",
  displayPreset: "presentation",
  baseLighting: null,
  device: null,
  model: null,
  renderScale: null,
  timings: {
    scriptStartedMs: performance.now(),
    modelLoadedMs: null,
    firstUsableFrameMs: null,
    cameraEventFps: 0,
    idleCameraEvents: null,
  },
};

let cameraWindowStart = 0;
let cameraEventCount = 0;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function numberAttribute(element, name, fallback) {
  return finiteNumber(element.getAttribute(name), fallback);
}

function captureBaseLighting(modelViewer) {
  return {
    environmentImage: modelViewer.getAttribute("environment-image") || "neutral",
    toneMapping: modelViewer.getAttribute("tone-mapping") || "neutral",
    exposure: numberAttribute(modelViewer, "exposure", 1),
    shadowIntensity: numberAttribute(modelViewer, "shadow-intensity", 0),
    shadowSoftness: numberAttribute(modelViewer, "shadow-softness", 1),
  };
}

function deviceSignals() {
  const dpr = Math.max(1, finiteNumber(window.devicePixelRatio, 1));
  const width = Math.max(1, window.screen?.width || window.innerWidth || 1);
  const height = Math.max(1, window.screen?.height || window.innerHeight || 1);
  const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches === true;
  const userAgentMobile = navigator.userAgentData?.mobile === true
    || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  return {
    dpr,
    cssWidth: width,
    cssHeight: height,
    physicalPixels: Math.round(width * height * dpr * dpr),
    coarsePointer,
    mobileLike: userAgentMobile || coarsePointer,
  };
}

function modelSignals(metadata) {
  const counts = metadata?.counts || {};
  const textures = metadata?.textures || {};
  return {
    renderedTriangles: finiteNumber(counts.renderedTriangles, 0),
    drawCalls: finiteNumber(counts.drawCalls, 0),
    nodes: finiteNumber(counts.nodes, 0),
    primitives: finiteNumber(counts.primitives, 0),
    materials: finiteNumber(counts.materials, 0),
    textures: finiteNumber(counts.textures, 0),
    estimatedTextureGPUBytes: finiteNumber(textures.estimatedGPUBytesRGBA8WithMipmaps, 0),
    animations: finiteNumber(counts.animations, 0),
    cameraTarget: Array.isArray(metadata?.bounds?.cameraTarget)
      && metadata.bounds.cameraTarget.length === 3
      && metadata.bounds.cameraTarget.every(Number.isFinite)
      ? [...metadata.bounds.cameraTarget]
      : null,
  };
}

export function selectAutoQualityProfile(device, model) {
  const highPixelLoad = device.physicalPixels >= 5_000_000 || device.dpr >= 2.5;
  const heavyModel = Boolean(model) && (
    model.renderedTriangles >= 1_500_000
    || model.drawCalls >= 4_000
    || model.nodes >= 20_000
    || model.primitives >= 4_000
    || model.estimatedTextureGPUBytes >= 160 * 1024 * 1024
  );
  const mediumModel = Boolean(model) && (
    model.renderedTriangles >= 500_000
    || model.drawCalls >= 1_000
    || model.nodes >= 8_000
    || model.primitives >= 1_500
  );

  if (device.mobileLike && (mediumModel || highPixelLoad || device.dpr >= 2)) return "mobile";
  if (device.mobileLike || heavyModel || highPixelLoad || mediumModel) return "balanced";
  return "high";
}

function requestedMode() {
  const value = new URLSearchParams(window.location.search).get("quality")?.toLowerCase();
  return QUALITY_MODE_NAMES.has(value) ? value : "auto";
}

function requestedDisplayPreset() {
  const value = new URLSearchParams(window.location.search).get("display")?.toLowerCase();
  return DISPLAY_PRESET_NAMES.has(value) ? value : "presentation";
}

function metadataURL(modelURL) {
  try {
    const url = new URL(modelURL, document.baseURI);
    if (url.origin !== window.location.origin) return null;
    if (url.pathname.endsWith("/dist/current/model.glb")) {
      return new URL("./metadata.json", url);
    }
    if (url.pathname.endsWith("/model.glb")) {
      return new URL("./dist/current/metadata.json", document.baseURI);
    }
  } catch {
    // A missing metadata report must never block the viewer.
  }
  return null;
}

function currentDisplayValues() {
  if (state.displayPreset === "faithful") return DISPLAY_PRESETS.faithful;
  return state.baseLighting;
}

function applyProfile() {
  const modelViewer = state.modelViewer;
  if (!modelViewer || !state.baseLighting) return;

  state.selectedProfile = state.mode === "auto"
    ? selectAutoQualityProfile(state.device, state.model)
    : state.mode;

  const profile = QUALITY_PROFILES[state.selectedProfile];
  const display = currentDisplayValues();
  const environmentImage = profile.environmentPolicy === "neutral"
    ? "neutral"
    : display.environmentImage;

  const ModelViewerElement = customElements.get("model-viewer");
  if (ModelViewerElement) ModelViewerElement.minimumRenderScale = profile.minimumRenderScale;

  modelViewer.environmentImage = environmentImage;
  modelViewer.toneMapping = display.toneMapping;
  modelViewer.exposure = display.exposure;
  modelViewer.shadowIntensity = display.shadowIntensity * profile.shadowScale;
  modelViewer.shadowSoftness = display.shadowSoftness;
  modelViewer.dataset.qualityMode = state.mode;
  modelViewer.dataset.qualityProfile = state.selectedProfile;
  modelViewer.dataset.displayPreset = state.displayPreset;
  modelViewer.dataset.minimumRenderScale = String(profile.minimumRenderScale);
  modelViewer.dataset.overlayDprCap = String(profile.overlayDprCap);
  modelViewer.dataset.effectiveShadowIntensity = modelViewer.shadowIntensity.toFixed(3);

  emitState();
}

function publicState() {
  const profile = QUALITY_PROFILES[state.selectedProfile];
  return {
    mode: state.mode,
    selectedProfile: state.selectedProfile,
    displayPreset: state.displayPreset,
    profile: { ...profile },
    device: state.device ? { ...state.device } : null,
    model: state.model ? { ...state.model } : null,
    renderScale: state.renderScale ? { ...state.renderScale } : null,
    timings: { ...state.timings },
    effective: state.modelViewer ? {
      environmentImage: state.modelViewer.environmentImage,
      toneMapping: state.modelViewer.toneMapping,
      exposure: state.modelViewer.exposure,
      shadowIntensity: state.modelViewer.shadowIntensity,
      shadowSoftness: state.modelViewer.shadowSoftness,
    } : null,
  };
}

function emitState() {
  const detail = publicState();
  Object.defineProperty(window, "__viewerQuality", {
    configurable: true,
    value: Object.freeze({
      getState: () => publicState(),
      setMode: setQualityMode,
      setDisplayPreset,
      setBaseLighting,
    }),
  });
  window.dispatchEvent(new CustomEvent("viewer-quality-change", { detail }));
}

function recordRenderScale(detail = {}) {
  const rect = state.modelViewer?.getBoundingClientRect();
  const reportedDpr = finiteNumber(detail.reportedDpr, state.device?.dpr ?? 1);
  const renderedDpr = finiteNumber(detail.renderedDpr, reportedDpr);
  state.renderScale = {
    reportedDpr,
    renderedDpr,
    minimumRenderScale: finiteNumber(
      detail.minimumRenderScale,
      QUALITY_PROFILES[state.selectedProfile].minimumRenderScale,
    ),
    pixelWidth: rect ? Math.round(rect.width * renderedDpr) : null,
    pixelHeight: rect ? Math.round(rect.height * renderedDpr) : null,
  };
  emitState();
}

async function loadMetadata(modelURL) {
  const url = metadataURL(modelURL);
  if (!url) return;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.model = modelSignals(await response.json());
    applyProfile();
  } catch (error) {
    console.info(`Quality Auto: model metadata unavailable (${error.message}).`);
    emitState();
  }
}

function recordCameraEvent() {
  const now = performance.now();
  if (!cameraWindowStart) cameraWindowStart = now;
  cameraEventCount += 1;
  const elapsed = now - cameraWindowStart;
  if (elapsed >= 750) {
    state.timings.cameraEventFps = Math.round(cameraEventCount * 1000 / elapsed);
    cameraWindowStart = now;
    cameraEventCount = 0;
  }
}

function recordModelLoad() {
  if (state.timings.modelLoadedMs !== null) return;
  state.timings.modelLoadedMs = Math.round(performance.now());
  requestAnimationFrame(() => requestAnimationFrame(() => {
    state.timings.firstUsableFrameMs = Math.round(performance.now());
    emitState();
  }));

  let idleEvents = 0;
  const idleCounter = () => { idleEvents += 1; };
  state.modelViewer.addEventListener("camera-change", idleCounter);
  window.setTimeout(() => {
    state.modelViewer?.removeEventListener("camera-change", idleCounter);
    state.timings.idleCameraEvents = idleEvents;
    emitState();
  }, 1500);
}

export async function initializeViewerQuality(modelViewer, modelURL) {
  await customElements.whenDefined("model-viewer");
  state.modelViewer = modelViewer;
  state.mode = requestedMode();
  state.displayPreset = requestedDisplayPreset();
  state.device = deviceSignals();
  state.baseLighting = captureBaseLighting(modelViewer);

  modelViewer.addEventListener("render-scale", (event) => recordRenderScale(event.detail));
  modelViewer.addEventListener("camera-change", recordCameraEvent);
  if (modelViewer.loaded) recordModelLoad();
  else modelViewer.addEventListener("load", recordModelLoad, { once: true });
  window.addEventListener("resize", () => recordRenderScale(state.renderScale || {}));

  applyProfile();
  recordRenderScale();
  await loadMetadata(modelURL);
  return publicState();
}

export function setQualityMode(mode) {
  const normalized = String(mode).toLowerCase();
  if (!QUALITY_MODE_NAMES.has(normalized)) return false;
  state.mode = normalized;
  applyProfile();
  return true;
}

export function setDisplayPreset(preset) {
  const normalized = String(preset).toLowerCase();
  if (!DISPLAY_PRESET_NAMES.has(normalized)) return false;
  state.displayPreset = normalized;
  applyProfile();
  return true;
}

export function setBaseLighting(value = {}) {
  const fallback = state.baseLighting || {
    environmentImage: "neutral",
    toneMapping: "neutral",
    exposure: 1,
    shadowIntensity: 0,
    shadowSoftness: 1,
  };
  state.baseLighting = {
    environmentImage: value.environmentImage ?? fallback.environmentImage,
    toneMapping: value.toneMapping ?? fallback.toneMapping,
    exposure: finiteNumber(value.exposure, fallback.exposure),
    shadowIntensity: finiteNumber(value.shadowIntensity, fallback.shadowIntensity),
    shadowSoftness: finiteNumber(value.shadowSoftness, fallback.shadowSoftness),
  };
  applyProfile();
}

export function getViewerQualityState() {
  return publicState();
}
