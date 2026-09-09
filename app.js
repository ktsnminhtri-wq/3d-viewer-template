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
const twoPointButton = document.querySelector("#twoPointButton");
const threePointButton = document.querySelector("#threePointButton");
const modelPathHint = document.querySelector("#modelPathHint");

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
} catch (error) {
  loadingPanel.hidden = true;
  errorPanel.hidden = false;
  modelPathHint.textContent = error.message;
  console.error(error);
}

const defaultOrbit = modelViewer.getAttribute("camera-orbit") || "0deg 75deg auto";
const defaultTarget = "auto auto auto";
const defaultMinOrbit = modelViewer.getAttribute("min-camera-orbit") || "auto auto auto";
const defaultMaxOrbit = modelViewer.getAttribute("max-camera-orbit") || "auto auto auto";
const TWO_POINT_PHI = "90deg";
let perspectiveMode = "3P";

function updatePerspectiveButtons() {
  const isTwoPoint = perspectiveMode === "2P";
  twoPointButton.setAttribute("aria-pressed", String(isTwoPoint));
  threePointButton.setAttribute("aria-pressed", String(!isTwoPoint));
}

function setPerspectiveMode(mode) {
  if (mode === perspectiveMode) return;

  const orbit = modelViewer.getCameraOrbit();
  perspectiveMode = mode;

  if (mode === "2P") {
    // A level perspective camera (phi = 90deg) keeps glTF's Y-up verticals
    // parallel while preserving horizontal orbit, pan and perspective zoom.
    modelViewer.minCameraOrbit = `auto ${TWO_POINT_PHI} auto`;
    modelViewer.maxCameraOrbit = `auto ${TWO_POINT_PHI} auto`;
    modelViewer.cameraOrbit = `${orbit.theta}rad ${TWO_POINT_PHI} ${orbit.radius}m`;
  } else {
    modelViewer.minCameraOrbit = defaultMinOrbit;
    modelViewer.maxCameraOrbit = defaultMaxOrbit;
    modelViewer.cameraOrbit = `${orbit.theta}rad ${orbit.phi}rad ${orbit.radius}m`;
  }

  updatePerspectiveButtons();
}

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
  modelViewer.cameraOrbit = perspectiveMode === "2P"
    ? `0deg ${TWO_POINT_PHI} auto`
    : defaultOrbit;
  modelViewer.fieldOfView = "30deg";
  modelViewer.jumpCameraToGoal();
});

twoPointButton.addEventListener("click", () => setPerspectiveMode("2P"));
threePointButton.addEventListener("click", () => setPerspectiveMode("3P"));

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
