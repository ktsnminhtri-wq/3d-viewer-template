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
const brightnessButton = document.querySelector("#brightnessButton");
const brightnessPanel = document.querySelector("#brightnessPanel");
const brightnessSlider = document.querySelector("#brightnessSlider");
const brightnessValue = document.querySelector("#brightnessValue");
const brightnessResetButton = document.querySelector("#brightnessResetButton");
const fullscreenButton = document.querySelector("#fullscreenButton");
const fullscreenLabel = document.querySelector("#fullscreenLabel");
const retryButton = document.querySelector("#retryButton");

const defaultOrbit = "0deg 75deg auto";
const defaultTarget = "auto auto auto";
const defaultExposure = 1.3;
const minExposure = 0.8;
const maxExposure = 1.8;
const exposureStep = 0.05;
const exposureStorageKey = "modelViewerExposure";

function normalizeExposure(value) {
  const parsedValue = Number.parseFloat(value);
  const safeValue = Number.isFinite(parsedValue) ? parsedValue : defaultExposure;
  const clampedValue = Math.min(maxExposure, Math.max(minExposure, safeValue));
  return Math.round((clampedValue - minExposure) / exposureStep) * exposureStep
    + minExposure;
}

function readSavedExposure() {
  try {
    return normalizeExposure(localStorage.getItem(exposureStorageKey));
  } catch {
    return defaultExposure;
  }
}

function applyExposure(value, save = true) {
  const exposure = normalizeExposure(value);
  modelViewer.exposure = exposure;
  brightnessSlider.value = exposure.toFixed(2);
  brightnessValue.value = exposure.toFixed(2);
  brightnessValue.textContent = exposure.toFixed(2);

  if (save) {
    try {
      localStorage.setItem(exposureStorageKey, exposure.toFixed(2));
    } catch {
      // The viewer still works when storage is unavailable or disabled.
    }
  }
}

function setBrightnessPanelOpen(isOpen) {
  brightnessPanel.hidden = !isOpen;
  brightnessButton.setAttribute("aria-expanded", String(isOpen));
}

const savedExposure = readSavedExposure();
brightnessSlider.value = savedExposure.toFixed(2);
brightnessValue.value = savedExposure.toFixed(2);
brightnessValue.textContent = savedExposure.toFixed(2);

customElements.whenDefined("model-viewer").then(() => {
  applyExposure(savedExposure, false);
});

modelViewer.addEventListener("progress", (event) => {
  const percentage = Math.round(event.detail.totalProgress * 100);
  progressBar.style.width = `${percentage}%`;
  progressValue.textContent = `${percentage}%`;
  progressTrack.setAttribute("aria-valuenow", String(percentage));
});

modelViewer.addEventListener("load", () => {
  loadingPanel.hidden = true;
  errorPanel.hidden = true;

  // Các giá trị "auto" để model-viewer tự tính tâm và khoảng cách theo kích thước model.
  modelViewer.cameraTarget = defaultTarget;
  modelViewer.cameraOrbit = defaultOrbit;
  modelViewer.jumpCameraToGoal();
});

modelViewer.addEventListener("error", () => {
  loadingPanel.hidden = true;
  errorPanel.hidden = false;
});

resetButton.addEventListener("click", () => {
  modelViewer.cameraTarget = defaultTarget;
  modelViewer.cameraOrbit = defaultOrbit;
  modelViewer.fieldOfView = "30deg";
  modelViewer.jumpCameraToGoal();
});

rotateButton.addEventListener("click", () => {
  const isRotating = !modelViewer.hasAttribute("auto-rotate");
  modelViewer.toggleAttribute("auto-rotate", isRotating);
  rotateButton.setAttribute("aria-pressed", String(isRotating));
  rotateButton.title = isRotating ? "Tắt tự động xoay" : "Bật tự động xoay";
  rotateLabel.textContent = isRotating ? "Dừng xoay" : "Tự xoay";
});

brightnessButton.addEventListener("click", () => {
  const isOpen = brightnessButton.getAttribute("aria-expanded") !== "true";
  setBrightnessPanelOpen(isOpen);

  if (isOpen) brightnessSlider.focus();
});

brightnessSlider.addEventListener("input", () => {
  applyExposure(brightnessSlider.value);
});

brightnessResetButton.addEventListener("click", () => {
  applyExposure(defaultExposure);
  brightnessSlider.focus();
});

document.addEventListener("pointerdown", (event) => {
  if (
    brightnessButton.getAttribute("aria-expanded") === "true"
    && !brightnessPanel.contains(event.target)
    && !brightnessButton.contains(event.target)
  ) {
    setBrightnessPanelOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !brightnessPanel.hidden) {
    setBrightnessPanelOpen(false);
    brightnessButton.focus();
  }
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
