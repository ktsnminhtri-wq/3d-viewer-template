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
const twoDButton = document.querySelector("#twoDButton");
const isoButton = document.querySelector("#isoButton");
const perspectiveButton = document.querySelector("#perspectiveButton");
const viewModeButtons = [...document.querySelectorAll("[data-view-mode]")];
const interactionHint = document.querySelector(".hint");
const modelPathHint = document.querySelector("#modelPathHint");
let resolvedModelURL = null;
let modelDiagonal = 1;
let zoomSensitivityBand = "";
let lastTouchTap = null;
const touchStarts = new Map();
const navigationPointers = new Set();
const penPointers = new Set();
let fixedPanGesture = null;

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
  TWO_D: "2d",
  ISO: "iso",
  PERSPECTIVE: "perspective",
});
const PERSPECTIVE_FOV_DEG = 30;
const NEAR_ORTHOGRAPHIC_FOV_DEG = 1;
const ISO_THETA_RAD = Math.PI / 4;
const ISO_PHI_RAD = Math.acos(1 / Math.sqrt(3));
const LEVEL_PHI_RAD = Math.PI / 2;
let viewMode = VIEW_MODES.PERSPECTIVE;
let perspectiveFieldOfView = PERSPECTIVE_FOV_DEG;
let lockedOrbit = null;
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

function focusCameraAt(clientX, clientY) {
  const hit = modelViewer.positionAndNormalFromPoint?.(clientX, clientY);
  if (!hit?.position) return false;
  const { x, y, z } = hit.position;
  if (![x, y, z].every(Number.isFinite)) return false;
  modelViewer.cameraTarget = `${x}m ${y}m ${z}m`;
  return true;
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

function stopAutoRotateForLockedView() {
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
  const fixedView = viewMode !== VIEW_MODES.PERSPECTIVE;
  interactionHint.textContent = fixedView
    ? "Kéo để di chuyển · Cuộn hoặc chụm để zoom"
    : "Kéo để xoay · Cuộn hoặc chụm để zoom";
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

function applyLockedOrbit(theta, phi, radius) {
  lockedOrbit = { theta, phi };
  const minimumRadius = Math.max(radius * 0.001, 0.000001);
  const maximumRadius = Math.max(radius * 100, minimumRadius * 10);
  modelViewer.minCameraOrbit = `${theta}rad ${phi}rad ${minimumRadius}m`;
  modelViewer.maxCameraOrbit = `${theta}rad ${phi}rad ${maximumRadius}m`;
  modelViewer.cameraOrbit = `${theta}rad ${phi}rad ${radius}m`;
}

function setViewMode(mode, { restoreCanonical = false } = {}) {
  if (!Object.values(VIEW_MODES).includes(mode)) return false;
  const orbit = modelViewer.getCameraOrbit?.();
  const currentFieldOfView = Number(modelViewer.getFieldOfView?.());
  if (!orbit || !Number.isFinite(orbit.radius) || !Number.isFinite(currentFieldOfView)) {
    return false;
  }

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
  modelViewer.maxFieldOfView = "45deg";
  modelViewer.fieldOfView = `${targetFieldOfView}deg`;

  if (mode === VIEW_MODES.PERSPECTIVE) {
    lockedOrbit = null;
    applyPerspectiveOrbitBounds();
    modelViewer.cameraOrbit = `${orbit.theta}rad ${orbit.phi}rad ${targetRadius}m`;
  } else if (mode === VIEW_MODES.ISO) {
    stopAutoRotateForLockedView();
    modelViewer.resetTurntableRotation?.(0);
    applyLockedOrbit(ISO_THETA_RAD, ISO_PHI_RAD, targetRadius);
  } else {
    stopAutoRotateForLockedView();
    applyLockedOrbit(orbit.theta, LEVEL_PHI_RAD, targetRadius);
  }

  updateViewModeUI();
  window.dispatchEvent(new CustomEvent("viewer-view-mode-change", {
    detail: { viewMode, previousMode },
  }));
  return true;
}

function panFixedView(deltaX, deltaY) {
  if (viewMode === VIEW_MODES.PERSPECTIVE) return false;
  const orbit = modelViewer.getCameraOrbit?.();
  const target = modelViewer.getCameraTarget?.();
  const fieldOfView = Number(modelViewer.getFieldOfView?.());
  const rect = modelViewer.getBoundingClientRect();
  if (!orbit || !target || !Number.isFinite(fieldOfView) || rect.height <= 0) return false;

  const theta = lockedOrbit?.theta ?? orbit.theta;
  const phi = lockedOrbit?.phi ?? orbit.phi;
  const sinPhi = Math.sin(phi);
  const cameraDirection = {
    x: sinPhi * Math.sin(theta),
    y: Math.cos(phi),
    z: sinPhi * Math.cos(theta),
  };
  const forward = {
    x: -cameraDirection.x,
    y: -cameraDirection.y,
    z: -cameraDirection.z,
  };
  let right = { x: -forward.z, y: 0, z: forward.x };
  const rightLength = Math.hypot(right.x, right.y, right.z) || 1;
  right = {
    x: right.x / rightLength,
    y: 0,
    z: right.z / rightLength,
  };
  const screenUp = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  };
  const unitsPerPixel = 2 * orbit.radius * Math.tan(radians(fieldOfView) / 2) / rect.height;
  const x = target.x - right.x * deltaX * unitsPerPixel + screenUp.x * deltaY * unitsPerPixel;
  const y = target.y - right.y * deltaX * unitsPerPixel + screenUp.y * deltaY * unitsPerPixel;
  const z = target.z - right.z * deltaX * unitsPerPixel + screenUp.z * deltaY * unitsPerPixel;
  if (![x, y, z].every(Number.isFinite)) return false;
  modelViewer.cameraTarget = `${x}m ${y}m ${z}m`;
  modelViewer.jumpCameraToGoal?.();
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
  modelViewer.fieldOfView = `${PERSPECTIVE_FOV_DEG}deg`;
  modelViewer.jumpCameraToGoal();
  const dimensions = modelViewer.getDimensions?.();
  if (dimensions) {
    const diagonal = Math.hypot(dimensions.x, dimensions.y, dimensions.z);
    if (Number.isFinite(diagonal) && diagonal > 0) modelDiagonal = diagonal;
  }
  updateViewModeUI();
  updateAdaptiveZoomSensitivity();
});

modelViewer.addEventListener("camera-change", updateAdaptiveZoomSensitivity);

modelViewer.addEventListener("dblclick", (event) => {
  if (viewMode !== VIEW_MODES.PERSPECTIVE) return;
  if (focusCameraAt(event.clientX, event.clientY)) event.preventDefault();
});

modelViewer.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "pen") {
    penPointers.add(event.pointerId);
    return;
  }
  userNavigationStarted = true;
  navigationPointers.add(event.pointerId);
  if (
    viewMode !== VIEW_MODES.PERSPECTIVE
    && event.isPrimary
    && (event.pointerType === "touch" || event.button === 0)
  ) {
    fixedPanGesture = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
  }
  if (event.pointerType !== "touch") return;
  touchStarts.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY,
    time: performance.now(),
  });
});

modelViewer.addEventListener("pointermove", (event) => {
  if (
    !fixedPanGesture
    || fixedPanGesture.pointerId !== event.pointerId
    || viewMode === VIEW_MODES.PERSPECTIVE
    || navigationPointers.size !== 1
    || penPointers.size > 0
  ) return;
  if (event.pointerType === "mouse" && event.buttons !== 1) return;
  const deltaX = event.clientX - fixedPanGesture.x;
  const deltaY = event.clientY - fixedPanGesture.y;
  fixedPanGesture.x = event.clientX;
  fixedPanGesture.y = event.clientY;
  if (!panFixedView(deltaX, deltaY)) return;
  event.preventDefault();
  event.stopPropagation();
}, { capture: true });

modelViewer.addEventListener("wheel", () => {
  userNavigationStarted = true;
}, { passive: true });

modelViewer.addEventListener("pointerup", (event) => {
  if (event.pointerType === "pen") {
    penPointers.delete(event.pointerId);
    return;
  }
  navigationPointers.delete(event.pointerId);
  if (fixedPanGesture?.pointerId === event.pointerId) fixedPanGesture = null;
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
  if (isDoubleTap && viewMode === VIEW_MODES.PERSPECTIVE) {
    focusCameraAt(event.clientX, event.clientY);
    lastTouchTap = null;
  }
});

modelViewer.addEventListener("pointercancel", (event) => {
  penPointers.delete(event.pointerId);
  navigationPointers.delete(event.pointerId);
  if (fixedPanGesture?.pointerId === event.pointerId) fixedPanGesture = null;
  touchStarts.delete(event.pointerId);
});

modelViewer.addEventListener("error", () => {
  loadingPanel.hidden = true;
  errorPanel.hidden = false;
});

resetButton.addEventListener("click", () => {
  const resetMode = viewMode;
  const framing = window.__instancingCamera?.getFraming?.();
  modelViewer.cameraTarget = framing
    ? framing.center.map((value) => `${value}m`).join(" ")
    : defaultTarget;
  applyPerspectiveOrbitBounds();
  modelViewer.fieldOfView = `${PERSPECTIVE_FOV_DEG}deg`;
  modelViewer.cameraOrbit = framing
    ? `0deg 75deg ${framing.radius}m`
    : defaultOrbit;
  modelViewer.jumpCameraToGoal();
  viewMode = VIEW_MODES.PERSPECTIVE;
  perspectiveFieldOfView = PERSPECTIVE_FOV_DEG;
  lockedOrbit = null;
  if (resetMode !== VIEW_MODES.PERSPECTIVE) {
    setViewMode(resetMode, { restoreCanonical: true });
    modelViewer.jumpCameraToGoal();
  } else {
    updateViewModeUI();
  }
});

twoDButton.addEventListener("click", () => setViewMode(VIEW_MODES.TWO_D));
isoButton.addEventListener("click", () => setViewMode(VIEW_MODES.ISO, {
  restoreCanonical: viewMode === VIEW_MODES.ISO,
}));
perspectiveButton.addEventListener("click", () => setViewMode(VIEW_MODES.PERSPECTIVE));

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
        isoLocked: viewMode === VIEW_MODES.ISO,
        orbitLocked: viewMode !== VIEW_MODES.PERSPECTIVE,
        fieldOfView: Number(modelViewer.getFieldOfView?.()),
        orbit: orbit ? { theta: orbit.theta, phi: orbit.phi, radius: orbit.radius } : null,
        target: target ? { x: target.x, y: target.y, z: target.z } : null,
      };
    },
  }),
});

updateViewModeUI();
