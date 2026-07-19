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

const defaultOrbit = modelViewer.getAttribute("camera-orbit") || "0deg 75deg auto";
const defaultTarget = "auto auto auto";

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
