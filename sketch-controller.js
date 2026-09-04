import * as THREE from "https://unpkg.com/three@0.174.0/build/three.module.js";

const modelViewer = document.querySelector("#modelViewer");
const viewerShell = document.querySelector("#viewerShell");

if (modelViewer && viewerShell) {
  const canvas = document.createElement("canvas");
  canvas.className = "sketch-overlay";
  canvas.setAttribute("aria-hidden", "true");
  viewerShell.append(canvas);

  const debugPanel = document.createElement("aside");
  debugPanel.className = "sketch-debug";
  debugPanel.setAttribute("aria-label", "Sprint 01B pen debug");
  debugPanel.innerHTML = `
    <div class="sketch-debug__title">
      <strong>Pen hit test</strong>
      <span class="sketch-debug__badge">Sprint 01B</span>
    </div>
    <dl>
      <dt>pointer</dt><dd data-sketch-debug="pointerType">none</dd>
      <dt>pen active</dt><dd data-sketch-debug="penActive">no</dd>
      <dt>hit</dt><dd data-sketch-debug="hit">no</dd>
      <dt>XYZ</dt><dd data-sketch-debug="xyz">—</dd>
      <dt>pressure</dt><dd data-sketch-debug="pressure">0.000</dd>
      <dt>stroke points</dt><dd data-sketch-debug="pointCount">0</dd>
    </dl>
    <div class="sketch-debug__actions">
      <button type="button" data-sketch-action="undo" disabled>Undo</button>
      <button type="button" data-sketch-action="clear" disabled>Clear</button>
    </div>
  `;
  viewerShell.append(debugPanel);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
    premultipliedAlpha: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  canvas.dataset.renderer = "three-webgl";
  canvas.dataset.cameraSync = "pending";

  const scene = new THREE.Scene();
  const turntableRoot = new THREE.Group();
  const targetRoot = new THREE.Group();
  turntableRoot.add(targetRoot);
  scene.add(turntableRoot);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.001, 1000);
  const strokeMaterial = new THREE.LineBasicMaterial({
    color: 0x1e6cb4,
    depthTest: true,
    depthWrite: false,
    opacity: 0.95,
    transparent: true,
  });

  const debug = Object.fromEntries(
    [...debugPanel.querySelectorAll("[data-sketch-debug]")]
      .map((element) => [element.dataset.sketchDebug, element]),
  );
  const undoButton = debugPanel.querySelector('[data-sketch-action="undo"]');
  const clearButton = debugPanel.querySelector('[data-sketch-action="clear"]');

  const strokes = [];
  let activeStroke = null;
  let activePenId = null;
  let lastStrokePointCount = 0;
  let resumeAutoRotate = false;
  let modelDiagonal = 1;
  let surfaceOffset = 0.00002;
  let renderRequested = false;
  let lastProjectionError = null;
  let maximumProjectionError = 0;

  function pointValue(vector) {
    return {
      x: Number(vector.x),
      y: Number(vector.y),
      z: Number(vector.z),
    };
  }

  function updateActionState() {
    const hasStrokes = strokes.length > 0;
    undoButton.disabled = !hasStrokes;
    clearButton.disabled = !hasStrokes;
  }

  function updatePointCount() {
    debug.pointCount.textContent = String(
      activeStroke?.points.length ?? lastStrokePointCount,
    );
  }

  function updateSurfaceOffset() {
    const dimensions = modelViewer.getDimensions?.();
    if (!dimensions) return;
    const diagonal = Math.hypot(dimensions.x, dimensions.y, dimensions.z);
    if (!Number.isFinite(diagonal) || diagonal <= 0) return;

    modelDiagonal = diagonal;
    // 0.002% of the model diagonal avoids coincident surfaces without
    // visibly lifting the stroke away from the architecture.
    surfaceOffset = diagonal * 0.00002;
    for (const stroke of strokes) rebuildStrokeGeometry(stroke);
    if (activeStroke) rebuildStrokeGeometry(activeStroke);
  }

  function createStroke() {
    const capacity = 128;
    const positions = new Float32Array(capacity * 3);
    const geometry = new THREE.BufferGeometry();
    const attribute = new THREE.BufferAttribute(positions, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", attribute);
    geometry.setDrawRange(0, 0);

    const line = new THREE.Line(geometry, strokeMaterial);
    line.frustumCulled = false;
    targetRoot.add(line);
    return { points: [], capacity, positions, attribute, geometry, line };
  }

  function ensureStrokeCapacity(stroke, pointCount) {
    if (pointCount <= stroke.capacity) return;
    let capacity = stroke.capacity;
    while (capacity < pointCount) capacity *= 2;

    const positions = new Float32Array(capacity * 3);
    positions.set(stroke.positions);
    const attribute = new THREE.BufferAttribute(positions, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    stroke.capacity = capacity;
    stroke.positions = positions;
    stroke.attribute = attribute;
    stroke.geometry.setAttribute("position", attribute);
  }

  function writeStrokePoint(stroke, index) {
    const point = stroke.points[index];
    const { position, normal } = point;
    const normalLength = Math.hypot(normal.x, normal.y, normal.z) || 1;
    const offset = surfaceOffset / normalLength;
    const target = index * 3;
    stroke.positions[target] = position.x + normal.x * offset;
    stroke.positions[target + 1] = position.y + normal.y * offset;
    stroke.positions[target + 2] = position.z + normal.z * offset;
  }

  function updateStrokeDrawRange(stroke) {
    stroke.geometry.setDrawRange(0, stroke.points.length);
    stroke.attribute.needsUpdate = true;
  }

  function appendStrokePoint(stroke, point) {
    stroke.points.push(point);
    ensureStrokeCapacity(stroke, stroke.points.length);
    writeStrokePoint(stroke, stroke.points.length - 1);
    updateStrokeDrawRange(stroke);
  }

  function rebuildStrokeGeometry(stroke) {
    ensureStrokeCapacity(stroke, stroke.points.length);
    for (let index = 0; index < stroke.points.length; index += 1) {
      writeStrokePoint(stroke, index);
    }
    updateStrokeDrawRange(stroke);
  }

  function disposeStroke(stroke) {
    targetRoot.remove(stroke.line);
    stroke.geometry.dispose();
  }

  function syncCamera() {
    if (!modelViewer.loaded) return false;
    const orbit = modelViewer.getCameraOrbit?.();
    const target = modelViewer.getCameraTarget?.();
    const fieldOfView = Number(modelViewer.getFieldOfView?.());
    if (!orbit || !target || !Number.isFinite(fieldOfView)) return false;

    const rect = viewerShell.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    camera.aspect = rect.width / rect.height;
    camera.fov = fieldOfView;
    camera.near = Math.max(orbit.radius / 10000, 0.000001);
    camera.far = Math.max(orbit.radius * 100, orbit.radius + modelDiagonal * 4, 1);
    camera.position.setFromSphericalCoords(orbit.radius, orbit.phi, orbit.theta);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    // model-viewer translates by the negative camera target, then rotates
    // around the scene origin. This nested hierarchy mirrors that transform.
    turntableRoot.rotation.set(0, Number(modelViewer.turntableRotation) || 0, 0);
    targetRoot.position.set(-target.x, -target.y, -target.z);
    turntableRoot.updateMatrixWorld(true);
    return true;
  }

  function renderScene() {
    renderRequested = false;
    if (syncCamera()) renderer.render(scene, camera);
    if (
      modelViewer.hasAttribute("auto-rotate")
      && (strokes.length > 0 || activeStroke)
    ) {
      requestRender();
    }
  }

  function requestRender() {
    if (renderRequested) return;
    renderRequested = true;
    requestAnimationFrame(renderScene);
  }

  function resizeRenderer() {
    const rect = viewerShell.getBoundingClientRect();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
    requestRender();
  }

  function projectedClientPosition(point) {
    if (!syncCamera()) return null;
    const rect = viewerShell.getBoundingClientRect();
    const projected = new THREE.Vector3(point.x, point.y, point.z);
    targetRoot.localToWorld(projected);
    projected.project(camera);
    return {
      x: rect.left + (projected.x + 1) * rect.width / 2,
      y: rect.top + (1 - projected.y) * rect.height / 2,
    };
  }

  function trackProjectionError(position, sample) {
    const projected = projectedClientPosition(position);
    if (!projected) return;
    lastProjectionError = Math.hypot(
      projected.x - sample.clientX,
      projected.y - sample.clientY,
    );
    maximumProjectionError = Math.max(maximumProjectionError, lastProjectionError);
  }

  function validateCameraSync() {
    const rect = viewerShell.getBoundingClientRect();
    const samples = [
      [0.5, 0.5],
      [0.4, 0.5],
      [0.6, 0.5],
      [0.5, 0.4],
      [0.5, 0.6],
      [0.3, 0.5],
      [0.7, 0.5],
    ];

    for (const [xRatio, yRatio] of samples) {
      const clientX = rect.left + rect.width * xRatio;
      const clientY = rect.top + rect.height * yRatio;
      const hit = hitTest({ clientX, clientY });
      if (!hit) continue;
      const projected = projectedClientPosition(pointValue(hit.position));
      if (!projected) break;
      const error = Math.hypot(projected.x - clientX, projected.y - clientY);
      canvas.dataset.cameraSync = error <= 1.5 ? "pass" : "fail";
      canvas.dataset.cameraSyncError = error.toFixed(3);
      if (error > 1.5) {
        console.warn(`Sketch camera synchronization error: ${error.toFixed(2)}px`);
      }
      return;
    }

    canvas.dataset.cameraSync = "no-hit";
  }

  function hitTest(sample) {
    try {
      return modelViewer.positionAndNormalFromPoint(sample.clientX, sample.clientY);
    } catch {
      return null;
    }
  }

  function addLocalTestStroke() {
    const enabled = location.hostname === "localhost"
      && new URLSearchParams(location.search).has("sketch-test");
    if (!enabled) return;

    const rect = viewerShell.getBoundingClientRect();
    const stroke = createStroke();
    for (let index = 0; index <= 36; index += 1) {
      const progress = index / 36;
      const clientX = rect.left + rect.width * (0.36 + progress * 0.28);
      const clientY = rect.top + rect.height * (
        0.55 + Math.sin(progress * Math.PI * 2) * 0.035
      );
      const hit = hitTest({ clientX, clientY });
      if (!hit) continue;
      appendStrokePoint(stroke, {
        position: pointValue(hit.position),
        normal: pointValue(hit.normal),
        pressure: 0.5,
        tiltX: 0,
        tiltY: 0,
        timestamp: performance.now(),
      });
    }

    if (stroke.points.length >= 2) {
      strokes.push(stroke);
      lastStrokePointCount = stroke.points.length;
      canvas.dataset.localTestPoints = String(stroke.points.length);
      updatePointCount();
      updateActionState();
    } else {
      disposeStroke(stroke);
      canvas.dataset.localTestPoints = "0";
    }
    requestRender();
  }

  function inspectPenSample(sample, { store = false } = {}) {
    const hit = hitTest(sample);
    const pressure = Number(sample.pressure) || 0;

    debug.pointerType.textContent = "pen";
    debug.hit.textContent = hit ? "yes" : "no";
    debug.pressure.textContent = pressure.toFixed(3);
    debug.xyz.textContent = hit
      ? `${hit.position.x.toFixed(3)}, ${hit.position.y.toFixed(3)}, ${hit.position.z.toFixed(3)}`
      : "—";

    if (!store || !hit || !activeStroke) return;

    const point = {
      position: pointValue(hit.position),
      normal: pointValue(hit.normal),
      pressure,
      tiltX: Number(sample.tiltX) || 0,
      tiltY: Number(sample.tiltY) || 0,
      timestamp: Number(sample.timeStamp),
    };
    appendStrokePoint(activeStroke, point);
    trackProjectionError(point.position, sample);
    updatePointCount();
  }

  function samplesFrom(event) {
    if (event.type !== "pointermove" || typeof event.getCoalescedEvents !== "function") {
      return [event];
    }
    const samples = event.getCoalescedEvents();
    return samples.length ? samples : [event];
  }

  function beginPenStroke(event) {
    if (activePenId !== null) return;
    activePenId = event.pointerId;
    activeStroke = createStroke();
    debug.penActive.textContent = "yes";
    lastStrokePointCount = 0;
    updatePointCount();

    resumeAutoRotate = modelViewer.hasAttribute("auto-rotate");
    modelViewer.removeAttribute("auto-rotate");
    try {
      modelViewer.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is helpful but not required on every browser.
    }

    inspectPenSample(event, { store: true });
    requestRender();
  }

  function finishPenStroke(event) {
    if (event.pointerId !== activePenId) return;
    if (event.type === "pointerup") inspectPenSample(event, { store: true });

    if (activeStroke?.points.length) {
      strokes.push(activeStroke);
      lastStrokePointCount = activeStroke.points.length;
    } else {
      if (activeStroke) disposeStroke(activeStroke);
      lastStrokePointCount = 0;
    }

    activeStroke = null;
    activePenId = null;
    if (resumeAutoRotate) modelViewer.setAttribute("auto-rotate", "");
    resumeAutoRotate = false;
    debug.penActive.textContent = "no";
    updatePointCount();
    updateActionState();
    requestRender();
  }

  function onPointerDown(event) {
    debug.pointerType.textContent = event.pointerType || "unknown";
    if (event.pointerType !== "pen") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    beginPenStroke(event);
  }

  function onPointerMove(event) {
    debug.pointerType.textContent = event.pointerType || "unknown";
    if (event.pointerType !== "pen") return;

    const isDrawing = event.pointerId === activePenId;
    if (isDrawing) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    for (const sample of samplesFrom(event)) {
      inspectPenSample(sample, { store: isDrawing });
    }
    if (isDrawing) requestRender();
  }

  function onPointerEnd(event) {
    if (event.pointerType !== "pen" || event.pointerId !== activePenId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finishPenStroke(event);
  }

  undoButton.addEventListener("click", () => {
    const stroke = strokes.pop();
    if (stroke) disposeStroke(stroke);
    lastStrokePointCount = strokes.at(-1)?.points.length ?? 0;
    updatePointCount();
    updateActionState();
    requestRender();
  });

  clearButton.addEventListener("click", () => {
    for (const stroke of strokes) disposeStroke(stroke);
    strokes.length = 0;
    if (activeStroke) disposeStroke(activeStroke);
    activeStroke = null;
    activePenId = null;
    if (resumeAutoRotate) modelViewer.setAttribute("auto-rotate", "");
    resumeAutoRotate = false;
    lastStrokePointCount = 0;
    debug.penActive.textContent = "no";
    debug.hit.textContent = "no";
    debug.xyz.textContent = "—";
    updatePointCount();
    updateActionState();
    requestRender();
  });

  modelViewer.addEventListener("pointerdown", onPointerDown, { capture: true });
  modelViewer.addEventListener("pointermove", onPointerMove, { capture: true });
  modelViewer.addEventListener("pointerup", onPointerEnd, { capture: true });
  modelViewer.addEventListener("pointercancel", onPointerEnd, { capture: true });
  modelViewer.addEventListener("lostpointercapture", onPointerEnd, { capture: true });
  modelViewer.addEventListener("camera-change", requestRender);
  modelViewer.addEventListener("load", () => {
    updateSurfaceOffset();
    resizeRenderer();
    requestAnimationFrame(() => {
      validateCameraSync();
      addLocalTestStroke();
    });
  });

  const resizeObserver = new ResizeObserver(resizeRenderer);
  resizeObserver.observe(viewerShell);
  window.addEventListener("resize", resizeRenderer);
  document.addEventListener("fullscreenchange", resizeRenderer);
  resizeRenderer();

  // Read-only inspection hook for Sprint 01B validation.
  Object.defineProperty(window, "__sketchSprint01B", {
    configurable: true,
    value: {
      getStrokes: () => structuredClone(
        strokes.map((stroke) => ({ points: stroke.points })),
      ),
      getRendererState: () => ({
        lastProjectionError,
        maximumProjectionError,
        modelDiagonal,
        surfaceOffset,
        strokeCount: strokes.length,
      }),
    },
  });
}
