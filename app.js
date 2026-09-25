import { initializeViewerQuality } from "./viewer-quality.js";

const modelViewer = document.querySelector("#modelViewer");
const viewerShell = document.querySelector("#viewerShell");
const loadingPanel = document.querySelector("#loadingPanel");
const progressTrack = document.querySelector("#progressTrack");
const progressBar = document.querySelector("#progressBar");
const progressValue = document.querySelector("#progressValue");
const errorPanel = document.querySelector("#errorPanel");
const resetButton = document.querySelector("#resetButton");
const rotateButton = document.querySelector("#rotateButton");
const rotateLabel = document.querySelector("#rotateLabel");
const fullscreenButton = document.querySelector("#fullscreenButton");
const fullscreenLabel = document.querySelector("#fullscreenLabel");
const retryButton = document.querySelector("#retryButton");
const isoButton = document.querySelector("#isoButton");
const perspectiveButton = document.querySelector("#perspectiveButton");
const viewModeButtons = [...document.querySelectorAll("[data-view-mode]")];
const faceViewIndicator = document.querySelector("#faceViewIndicator");
const fovControl = document.querySelector("#fovControl");
const fovButton = document.querySelector("#fovButton");
const fovButtonValue = document.querySelector("#fovButtonValue");
const fovPanel = document.querySelector("#fovPanel");
const fovValue = document.querySelector("#fovValue");
const fovSlider = document.querySelector("#fovSlider");
const fovPresetButtons = [...document.querySelectorAll("[data-fov]")];
const interactionHint = document.querySelector(".hint");
const modelPathHint = document.querySelector("#modelPathHint");
let resolvedModelURL = null;
let modelDiagonal = 1;
let zoomSensitivityBand = "";
let lastTouchTap = null;
const touchStarts = new Map();
const navigationPointers = new Set();
const penPointers = new Set();
let faceExitGesture = null;
let lastPenInteractionAt = 0;
let lastFaceGestureAt = 0;
let suppressCompatibilityMouseUntil = 0;

function resolveModelSource() {
  const fallback = modelViewer.dataset.defaultModel || "./model.glb";
  const search = new URLSearchParams(window.location.search);
  const requested = search.get("model") || fallback;
  const resolved = new URL(requested, document.baseURI);
  if (!new Set(["http:", "https:"]).has(resolved.protocol)) {
    throw new Error(`Không hỗ trợ giao thức model: ${resolved.protocol}`);
  }
  const version = search.get("v");
  if (version) resolved.searchParams.set("v", version);
  return { requested, resolved };
}

try {
  const modelSource = resolveModelSource();
  modelViewer.setAttribute("src", modelSource.resolved.href);
  modelViewer.dataset.modelIdentity = modelSource.resolved.href;
  modelPathHint.textContent = modelSource.requested;
  resolvedModelURL = modelSource.resolved.href;
} catch (error) {
  loadingPanel.hidden = true;
  errorPanel.hidden = false;
  modelPathHint.textContent = error.message;
  console.error(error);
}

const defaultOrbit = modelViewer.getAttribute("camera-orbit") || "0deg 75deg auto";
let defaultTarget = "auto auto auto";
const defaultMinOrbit = modelViewer.getAttribute("min-camera-orbit") || "auto auto auto";
const defaultMaxOrbit = modelViewer.getAttribute("max-camera-orbit") || "auto auto auto";
const VIEW_MODES = Object.freeze({
  ISO: "iso",
  FACE: "face",
  PERSPECTIVE: "perspective",
});
const DEFAULT_PERSPECTIVE_FOV_DEG = 35;
const MIN_PERSPECTIVE_FOV_DEG = 20;
const MAX_PERSPECTIVE_FOV_DEG = 90;
const NEAR_ORTHOGRAPHIC_FOV_DEG = 1;
const ISO_THETA_RAD = Math.PI / 4;
const ISO_PHI_RAD = Math.acos(1 / Math.sqrt(3));
const FACE_POLE_EPSILON_RAD = Math.PI / 720;
let viewMode = VIEW_MODES.PERSPECTIVE;
let perspectiveFieldOfView = DEFAULT_PERSPECTIVE_FOV_DEG;
let faceView = null;
let userNavigationStarted = false;
let modelLoaded = false;

function applyRecommendedCameraTarget(target) {
  if (!Array.isArray(target) || target.length !== 3 || !target.every(Number.isFinite)) return;
  defaultTarget = target.map((value) => `${value}m`).join(" ");
  if (!modelLoaded || userNavigationStarted) return;
  modelViewer.cameraTarget = defaultTarget;
  modelViewer.jumpCameraToGoal();
}

if (resolvedModelURL) {
  void initializeViewerQuality(modelViewer, resolvedModelURL).then((quality) => {
    applyRecommendedCameraTarget(quality.model?.cameraTarget);
  });
}

function updateAdaptiveZoomSensitivity() {
  const orbit = modelViewer.getCameraOrbit?.();
  if (!orbit || !Number.isFinite(orbit.radius) || modelDiagonal <= 0) return;
  const radiusRatio = orbit.radius / modelDiagonal;
  const band = radiusRatio < 0.12
    ? "detail"
    : radiusRatio < 0.6
      ? "facade"
      : radiusRatio < 1.8
        ? "building"
        : "overview";
  if (band === zoomSensitivityBand) return;
  zoomSensitivityBand = band;
  modelViewer.zoomSensitivity = {
    detail: 0.22,
    facade: 0.34,
    building: 0.5,
    overview: 0.65,
  }[band];
  modelViewer.dataset.zoomSensitivityBand = band;
}

function radians(value) {
  return value * Math.PI / 180;
}

function framedRadius(radius, fromFovDegrees, toFovDegrees) {
  if (![radius, fromFovDegrees, toFovDegrees].every(Number.isFinite)) return radius;
  const fromTangent = Math.tan(radians(fromFovDegrees) / 2);
  const toTangent = Math.tan(radians(toFovDegrees) / 2);
  if (fromTangent <= 0 || toTangent <= 0) return radius;
  return radius * fromTangent / toTangent;
}

function stopAutoRotateForCameraPreset() {
  if (!modelViewer.hasAttribute("auto-rotate")) return;
  modelViewer.removeAttribute("auto-rotate");
  rotateButton.setAttribute("aria-pressed", "false");
  rotateButton.title = "Bật tự động xoay";
  rotateLabel.textContent = "Tự xoay";
}

function updateViewModeUI() {
  for (const button of viewModeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.viewMode === viewMode));
  }
  modelViewer.dataset.viewMode = viewMode;
  faceViewIndicator.hidden = viewMode !== VIEW_MODES.FACE;
  fovControl.hidden = viewMode !== VIEW_MODES.PERSPECTIVE;
  if (viewMode !== VIEW_MODES.PERSPECTIVE) closeFovPanel();
  interactionHint.textContent = viewMode === VIEW_MODES.FACE
    ? "Kéo để thoát Face · Chụm để zoom"
    : viewMode === VIEW_MODES.ISO
      ? "Kéo để xoay · Nhấn ISO để đặt lại góc"
      : "Kéo để xoay · Nhấn đúp mặt để nhìn thẳng";
}

function closeFovPanel() {
  fovPanel.hidden = true;
  fovButton.setAttribute("aria-expanded", "false");
}

function updateFovUI() {
  const rounded = Math.round(perspectiveFieldOfView);
  fovSlider.value = String(rounded);
  fovValue.value = `${rounded}°`;
  fovButtonValue.textContent = `${rounded}°`;
  for (const button of fovPresetButtons) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.fov) === rounded));
  }
}

function applyPerspectiveOrbitBounds() {
  const framing = window.__instancingCamera?.getFraming?.();
  if (framing) {
    modelViewer.minCameraOrbit = `auto auto ${framing.minRadius}m`;
    modelViewer.maxCameraOrbit = `auto auto ${framing.maxRadius}m`;
    return;
  }
  modelViewer.minCameraOrbit = defaultMinOrbit;
  modelViewer.maxCameraOrbit = defaultMaxOrbit;
}

function applyNearOrthographicBounds(radius) {
  const minimumRadius = Math.max(radius * 0.001, 0.000001);
  const maximumRadius = Math.max(radius * 100, minimumRadius * 10);
  modelViewer.minCameraOrbit = `auto auto ${minimumRadius}m`;
  modelViewer.maxCameraOrbit = `auto auto ${maximumRadius}m`;
}

function setViewMode(mode, { restoreCanonical = false } = {}) {
  if (!Object.values(VIEW_MODES).includes(mode)) return false;
  const orbit = modelViewer.getCameraOrbit?.();
  const currentFieldOfView = Number(modelViewer.getFieldOfView?.());
  if (!orbit || !Number.isFinite(orbit.radius) || !Number.isFinite(currentFieldOfView)) {
    return false;
  }

  if (mode === VIEW_MODES.FACE) return false;
  if (mode === viewMode && !(restoreCanonical && mode === VIEW_MODES.ISO)) return true;

  const previousMode = viewMode;
  if (previousMode === VIEW_MODES.PERSPECTIVE) {
    perspectiveFieldOfView = currentFieldOfView;
  }
  const targetFieldOfView = mode === VIEW_MODES.PERSPECTIVE
    ? perspectiveFieldOfView
    : NEAR_ORTHOGRAPHIC_FOV_DEG;
  const targetRadius = framedRadius(
    orbit.radius,
    currentFieldOfView,
    targetFieldOfView,
  );

  viewMode = mode;
  modelViewer.minFieldOfView = "0.5deg";
  modelViewer.maxFieldOfView = `${MAX_PERSPECTIVE_FOV_DEG}deg`;
  modelViewer.fieldOfView = `${targetFieldOfView}deg`;

  if (mode === VIEW_MODES.PERSPECTIVE) {
    faceView = null;
    applyPerspectiveOrbitBounds();
    modelViewer.cameraOrbit = `${orbit.theta}rad ${orbit.phi}rad ${targetRadius}m`;
  } else {
    faceView = null;
    stopAutoRotateForCameraPreset();
    modelViewer.resetTurntableRotation?.(0);
    applyNearOrthographicBounds(targetRadius);
    modelViewer.cameraOrbit = `${ISO_THETA_RAD}rad ${ISO_PHI_RAD}rad ${targetRadius}m`;
  }

  updateViewModeUI();
  window.dispatchEvent(new CustomEvent("viewer-view-mode-change", {
    detail: { viewMode, previousMode },
  }));
  return true;
}

function setPerspectiveFov(value) {
  const nextFov = Math.min(
    MAX_PERSPECTIVE_FOV_DEG,
    Math.max(MIN_PERSPECTIVE_FOV_DEG, Number(value)),
  );
  if (!Number.isFinite(nextFov)) return false;
  const previousFov = perspectiveFieldOfView;
  perspectiveFieldOfView = nextFov;
  updateFovUI();
  if (viewMode !== VIEW_MODES.PERSPECTIVE) return true;

  const orbit = modelViewer.getCameraOrbit?.();
  const currentFov = Number(modelViewer.getFieldOfView?.());
  if (!orbit || !Number.isFinite(orbit.radius) || !Number.isFinite(currentFov)) return false;
  const targetRadius = framedRadius(orbit.radius, currentFov || previousFov, nextFov);
  modelViewer.fieldOfView = `${nextFov}deg`;
  modelViewer.cameraOrbit = `${orbit.theta}rad ${orbit.phi}rad ${targetRadius}m`;
  return true;
}

function orbitDirection(orbit) {
  const sinPhi = Math.sin(orbit.phi);
  return {
    x: sinPhi * Math.sin(orbit.theta),
    y: Math.cos(orbit.phi),
    z: sinPhi * Math.cos(orbit.theta),
  };
}

function cameraSnapshot() {
  const orbit = modelViewer.getCameraOrbit?.();
  const target = modelViewer.getCameraTarget?.();
  const fieldOfView = Number(modelViewer.getFieldOfView?.());
  if (!orbit || !target || !Number.isFinite(fieldOfView)) return null;
  const values = [orbit.theta, orbit.phi, orbit.radius, target.x, target.y, target.z];
  if (!values.every(Number.isFinite)) return null;
  return {
    mode: viewMode,
    orbit: { theta: orbit.theta, phi: orbit.phi, radius: orbit.radius },
    target: { x: target.x, y: target.y, z: target.z },
    fieldOfView,
  };
}

function enterFaceView(clientX, clientY) {
  const hit = modelViewer.positionAndNormalFromPoint?.(clientX, clientY);
  const snapshot = cameraSnapshot();
  if (!hit?.position || !hit?.normal || !snapshot) return false;
  const target = { x: hit.position.x, y: hit.position.y, z: hit.position.z };
  const normal = { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z };
  if (![target.x, target.y, target.z, normal.x, normal.y, normal.z].every(Number.isFinite)) {
    return false;
  }
  const normalLength = Math.hypot(normal.x, normal.y, normal.z);
  if (normalLength <= 1e-8) return false;
  normal.x /= normalLength;
  normal.y /= normalLength;
  normal.z /= normalLength;

  const currentDirection = orbitDirection(snapshot.orbit);
  if (
    normal.x * currentDirection.x
    + normal.y * currentDirection.y
    + normal.z * currentDirection.z < 0
  ) {
    normal.x *= -1;
    normal.y *= -1;
    normal.z *= -1;
  }

  const nearPole = Math.abs(normal.y) > 0.985;
  const theta = nearPole ? snapshot.orbit.theta : Math.atan2(normal.x, normal.z);
  const rawPhi = Math.acos(Math.min(1, Math.max(-1, normal.y)));
  const phi = Math.min(
    Math.PI - FACE_POLE_EPSILON_RAD,
    Math.max(FACE_POLE_EPSILON_RAD, rawPhi),
  );
  const targetRadius = framedRadius(
    snapshot.orbit.radius,
    snapshot.fieldOfView,
    NEAR_ORTHOGRAPHIC_FOV_DEG,
  );
  const previousCameraState = viewMode === VIEW_MODES.FACE
    ? faceView?.previousCameraState ?? snapshot
    : snapshot;
  const previousMode = viewMode;

  stopAutoRotateForCameraPreset();
  viewMode = VIEW_MODES.FACE;
  faceView = { target, normal, previousCameraState };
  modelViewer.minFieldOfView = "0.5deg";
  modelViewer.maxFieldOfView = `${MAX_PERSPECTIVE_FOV_DEG}deg`;
  modelViewer.fieldOfView = `${NEAR_ORTHOGRAPHIC_FOV_DEG}deg`;
  applyNearOrthographicBounds(targetRadius);
  modelViewer.cameraTarget = `${target.x}m ${target.y}m ${target.z}m`;
  modelViewer.cameraOrbit = `${theta}rad ${phi}rad ${targetRadius}m`;
  updateViewModeUI();
  window.dispatchEvent(new CustomEvent("viewer-view-mode-change", {
    detail: { viewMode, previousMode },
  }));
  return true;
}

modelViewer.addEventListener("progress", (event) => {
  const percentage = Math.round(event.detail.totalProgress * 100);
  progressBar.style.width = `${percentage}%`;
  progressValue.textContent = `${percentage}%`;
  progressTrack.setAttribute("aria-valuenow", String(percentage));
});

modelViewer.addEventListener("load", () => {
  modelLoaded = true;
  loadingPanel.hidden = true;
  errorPanel.hidden = true;

  // Các giá trị "auto" để model-viewer tự tính tâm và khoảng cách theo kích thước model.
  modelViewer.cameraTarget = defaultTarget;
  modelViewer.cameraOrbit = defaultOrbit;
  modelViewer.fieldOfView = `${DEFAULT_PERSPECTIVE_FOV_DEG}deg`;
  modelViewer.jumpCameraToGoal();
  const dimensions = modelViewer.getDimensions?.();
  if (dimensions) {
    const diagonal = Math.hypot(dimensions.x, dimensions.y, dimensions.z);
    if (Number.isFinite(diagonal) && diagonal > 0) modelDiagonal = diagonal;
  }
  updateFovUI();
  updateViewModeUI();
  updateAdaptiveZoomSensitivity();
});

modelViewer.addEventListener("camera-change", updateAdaptiveZoomSensitivity);

modelViewer.addEventListener("dblclick", (event) => {
  const now = performance.now();
  if (event.pointerType === "pen" || now - lastPenInteractionAt < 500) return;
  if (now < suppressCompatibilityMouseUntil) return;
  if (now - lastFaceGestureAt < 250) return;
  if (enterFaceView(event.clientX, event.clientY)) {
    lastFaceGestureAt = now;
    event.preventDefault();
  }
});

modelViewer.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "pen") {
    penPointers.add(event.pointerId);
    lastPenInteractionAt = performance.now();
    return;
  }
  if (event.pointerType === "mouse" && performance.now() < suppressCompatibilityMouseUntil) {
    return;
  }
  userNavigationStarted = true;
  navigationPointers.add(event.pointerId);
  if (viewMode === VIEW_MODES.FACE && event.isPrimary) {
    if (event.pointerType === "mouse" && event.button === 0) {
      setViewMode(VIEW_MODES.PERSPECTIVE);
    } else if (event.pointerType === "touch") {
      faceExitGesture = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      };
    }
  }
  if (event.pointerType !== "touch") return;
  touchStarts.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY,
    time: performance.now(),
  });
}, { capture: true });

modelViewer.addEventListener("pointermove", (event) => {
  if (
    viewMode !== VIEW_MODES.FACE
    || !faceExitGesture
    || faceExitGesture.pointerId !== event.pointerId
    || navigationPointers.size !== 1
    || penPointers.size > 0
  ) return;
  const distance = Math.hypot(
    event.clientX - faceExitGesture.x,
    event.clientY - faceExitGesture.y,
  );
  if (distance > 8) {
    faceExitGesture = null;
    setViewMode(VIEW_MODES.PERSPECTIVE);
  }
}, { capture: true });

modelViewer.addEventListener("wheel", () => {
  userNavigationStarted = true;
}, { passive: true });

modelViewer.addEventListener("pointerup", (event) => {
  if (event.pointerType === "pen") {
    penPointers.delete(event.pointerId);
    lastPenInteractionAt = performance.now();
    return;
  }
  navigationPointers.delete(event.pointerId);
  if (faceExitGesture?.pointerId === event.pointerId) faceExitGesture = null;
  if (event.pointerType !== "touch") return;
  const start = touchStarts.get(event.pointerId);
  touchStarts.delete(event.pointerId);
  if (!start) return;
  const now = performance.now();
  const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
  if (now - start.time > 280 || distance > 16 || touchStarts.size > 0) return;
  const isDoubleTap = lastTouchTap
    && now - lastTouchTap.time <= 340
    && Math.hypot(event.clientX - lastTouchTap.x, event.clientY - lastTouchTap.y) <= 28;
  lastTouchTap = { x: event.clientX, y: event.clientY, time: now };
  if (isDoubleTap && enterFaceView(event.clientX, event.clientY)) {
    lastFaceGestureAt = now;
    suppressCompatibilityMouseUntil = now + 800;
    lastTouchTap = null;
  }
}, { capture: true });

modelViewer.addEventListener("pointercancel", (event) => {
  penPointers.delete(event.pointerId);
  navigationPointers.delete(event.pointerId);
  if (faceExitGesture?.pointerId === event.pointerId) faceExitGesture = null;
  touchStarts.delete(event.pointerId);
}, { capture: true });

modelViewer.addEventListener("error", () => {
  loadingPanel.hidden = true;
  errorPanel.hidden = false;
});

resetButton.addEventListener("click", () => {
  const framing = window.__instancingCamera?.getFraming?.();
  closeFovPanel();
  viewMode = VIEW_MODES.PERSPECTIVE;
  faceView = null;
  perspectiveFieldOfView = DEFAULT_PERSPECTIVE_FOV_DEG;
  modelViewer.cameraTarget = framing
    ? framing.center.map((value) => `${value}m`).join(" ")
    : defaultTarget;
  applyPerspectiveOrbitBounds();
  modelViewer.fieldOfView = `${DEFAULT_PERSPECTIVE_FOV_DEG}deg`;
  modelViewer.cameraOrbit = framing
    ? `0deg 75deg ${framing.radius}m`
    : defaultOrbit;
  modelViewer.jumpCameraToGoal();
  updateFovUI();
  updateViewModeUI();
});

isoButton.addEventListener("click", () => setViewMode(VIEW_MODES.ISO, {
  restoreCanonical: viewMode === VIEW_MODES.ISO,
}));
perspectiveButton.addEventListener("click", () => setViewMode(VIEW_MODES.PERSPECTIVE));

fovButton.addEventListener("click", () => {
  const willOpen = fovPanel.hidden;
  fovPanel.hidden = !willOpen;
  fovButton.setAttribute("aria-expanded", String(willOpen));
});

for (const button of fovPresetButtons) {
  button.addEventListener("click", () => setPerspectiveFov(button.dataset.fov));
}

fovSlider.addEventListener("input", () => setPerspectiveFov(fovSlider.value));

document.addEventListener("pointerdown", (event) => {
  if (!fovPanel.hidden && !fovControl.contains(event.target)) closeFovPanel();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeFovPanel();
});

rotateButton.addEventListener("click", () => {
  const isRotating = !modelViewer.hasAttribute("auto-rotate");
  modelViewer.toggleAttribute("auto-rotate", isRotating);
  rotateButton.setAttribute("aria-pressed", String(isRotating));
  rotateButton.title = isRotating ? "Tắt tự động xoay" : "Bật tự động xoay";
  rotateLabel.textContent = isRotating ? "Dừng xoay" : "Tự xoay";
});

fullscreenButton.addEventListener("click", async () => {
  try {
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;

    if (!fullscreenElement) {
      const enterFullscreen =
        viewerShell.requestFullscreen || viewerShell.webkitRequestFullscreen;
      await enterFullscreen.call(viewerShell);
    } else {
      const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
      await exitFullscreen.call(document);
    }
  } catch (error) {
    console.error("Không thể chuyển chế độ toàn màn hình:", error);
  }
});

function updateFullscreenButton() {
  const isFullscreen = Boolean(
    document.fullscreenElement || document.webkitFullscreenElement,
  );
  fullscreenLabel.textContent = isFullscreen ? "Thu nhỏ" : "Toàn màn hình";
  fullscreenButton.title = isFullscreen ? "Thoát toàn màn hình" : "Bật toàn màn hình";
}

document.addEventListener("fullscreenchange", updateFullscreenButton);
document.addEventListener("webkitfullscreenchange", updateFullscreenButton);

retryButton.addEventListener("click", () => {
  window.location.reload();
});

Object.defineProperty(window, "__viewerViewMode", {
  configurable: true,
  value: Object.freeze({
    getState: () => {
      const orbit = modelViewer.getCameraOrbit?.();
      const target = modelViewer.getCameraTarget?.();
      return {
        viewMode,
        projection: viewMode === VIEW_MODES.PERSPECTIVE
          ? "perspective"
          : "near-orthographic",
        perspectiveFov: perspectiveFieldOfView,
        isoLocked: false,
        orbitLocked: false,
        fieldOfView: Number(modelViewer.getFieldOfView?.()),
        orbit: orbit ? { theta: orbit.theta, phi: orbit.phi, radius: orbit.radius } : null,
        target: target ? { x: target.x, y: target.y, z: target.z } : null,
        faceView: faceView ? {
          target: { ...faceView.target },
          normal: { ...faceView.normal },
          previousCameraState: faceView.previousCameraState,
        } : null,
      };
    },
  }),
});

updateFovUI();
updateViewModeUI();
