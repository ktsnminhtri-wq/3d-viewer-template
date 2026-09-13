(function initializeInstancedModelFraming() {
  const modelViewer = document.querySelector("#modelViewer");
  if (!modelViewer) return;

  const search = new URLSearchParams(window.location.search);
  const requestedModel = search.get("model") || modelViewer.dataset.defaultModel || "./model.glb";
  const modelURL = new URL(requestedModel, document.baseURI);
  const metadataURL = new URL("./metadata.json", modelURL);
  const version = search.get("v");
  if (version) metadataURL.searchParams.set("v", version);

  const metadataPromise = fetch(metadataURL)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((metadata) => {
      const usesInstancing = metadata?.extensions?.used?.includes("EXT_mesh_gpu_instancing");
      const center = metadata?.bounds?.center;
      const size = metadata?.bounds?.size;
      const validBounds = [center, size].every(
        (values) => Array.isArray(values) && values.length === 3 && values.every(Number.isFinite),
      );

      return usesInstancing && validBounds ? { center, size } : null;
    })
    .catch((error) => {
      console.warn("Không thể đọc metadata để hiệu chỉnh camera:", error);
      return null;
    });

  const loadedPromise = modelViewer.loaded
    ? Promise.resolve()
    : new Promise((resolve) => {
        modelViewer.addEventListener("load", resolve, { once: true });
      });

  let framing = null;

  function applyFraming({ resetTarget = false } = {}) {
    if (!framing) return;

    const isTwoPoint = document.querySelector("#twoPointButton")?.getAttribute("aria-pressed") === "true";
    const currentOrbit = modelViewer.getCameraOrbit?.();
    const theta = resetTarget ? 0 : currentOrbit?.theta ?? 0;
    const phi = isTwoPoint ? Math.PI / 2 : resetTarget ? (75 * Math.PI) / 180 : currentOrbit?.phi ?? (75 * Math.PI) / 180;
    const radius = resetTarget ? framing.radius : currentOrbit?.radius ?? framing.radius;

    if (resetTarget) {
      modelViewer.cameraTarget = `${framing.center[0]}m ${framing.center[1]}m ${framing.center[2]}m`;
    }
    modelViewer.cameraOrbit = `${theta}rad ${phi}rad ${radius}m`;
    modelViewer.minCameraOrbit = `auto ${isTwoPoint ? "90deg" : "auto"} ${framing.minRadius}m`;
    modelViewer.maxCameraOrbit = `auto ${isTwoPoint ? "90deg" : "auto"} ${framing.maxRadius}m`;
    modelViewer.jumpCameraToGoal?.();
  }

  Promise.all([metadataPromise, loadedPromise]).then(([bounds]) => {
    if (!bounds) return;

    const diagonal = Math.hypot(...bounds.size);
    const halfFieldOfView = (30 * Math.PI) / 360;
    const radius = (diagonal / 2) / Math.sin(halfFieldOfView);

    framing = {
      center: bounds.center,
      radius,
      minRadius: Math.max(radius * 0.05, 0.01),
      maxRadius: radius * 5,
    };

    requestAnimationFrame(() => applyFraming({ resetTarget: true }));
  });

  document.querySelector("#resetButton")?.addEventListener("click", (event) => {
    if (!framing) return;
    event.stopImmediatePropagation();
    modelViewer.fieldOfView = "30deg";
    applyFraming({ resetTarget: true });
  }, { capture: true });

  for (const button of document.querySelectorAll("#twoPointButton, #threePointButton")) {
    button.addEventListener("click", () => {
      requestAnimationFrame(() => applyFraming());
    });
  }
})();
