import * as THREE from "https://unpkg.com/three@0.174.0/build/three.module.js";
import {
  PRIMARY_MODEL_SURFACE_ID,
  REFERENCE_TYPES,
  createSpatialReferenceStore,
  createStrokeRecord,
  isStrokeReferenceVisible,
  resolveStrokePoint,
} from "./sketch-spatial-model.js";

const modelViewer = document.querySelector("#modelViewer");
const viewerShell = document.querySelector("#viewerShell");

if (modelViewer && viewerShell) {
  const canvas = document.createElement("canvas");
  canvas.className = "sketch-overlay";
  canvas.setAttribute("aria-hidden", "true");
  viewerShell.append(canvas);

  const debugPanel = document.createElement("aside");
  debugPanel.className = "sketch-debug";
  debugPanel.setAttribute("aria-label", "Spatial sketch controls");
  debugPanel.innerHTML = `
    <div class="sketch-debug__title">
      <strong>Pen hit test</strong>
      <span class="sketch-debug__badge">Sprint 06</span>
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
    <div class="sketch-support" aria-label="Drawing support">
      <div class="sketch-support__toggle" role="group" aria-label="Drawing support">
        <button type="button" data-sketch-support="surface" aria-pressed="true">Model</button>
        <button type="button" data-sketch-support="plane" aria-pressed="false">Guide</button>
      </div>
      <button type="button" data-sketch-action="new-guide">New Guide</button>
    </div>
    <div class="sketch-guide-menu" data-guide-menu hidden>
      <button type="button" data-guide-source="face">From Face</button>
      <button type="button" data-guide-source="view">From View</button>
    </div>
    <p class="sketch-guide-instruction" data-guide-instruction hidden>Tap a surface</p>
    <label class="sketch-offset" data-guide-offset hidden>
      <span>Offset</span>
      <input type="range" min="-1" max="1" step="0.01" value="0" />
      <output>0.000</output>
    </label>
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
  const newGuideButton = debugPanel.querySelector('[data-sketch-action="new-guide"]');
  const modelSupportButton = debugPanel.querySelector('[data-sketch-support="surface"]');
  const guideSupportButton = debugPanel.querySelector('[data-sketch-support="plane"]');
  const guideInstruction = debugPanel.querySelector("[data-guide-instruction]");
  const guideMenu = debugPanel.querySelector("[data-guide-menu]");
  const fromFaceButton = debugPanel.querySelector('[data-guide-source="face"]');
  const fromViewButton = debugPanel.querySelector('[data-guide-source="view"]');
  const offsetControl = debugPanel.querySelector("[data-guide-offset]");
  const offsetSlider = offsetControl.querySelector('input[type="range"]');
  const offsetOutput = offsetControl.querySelector("output");

  const strokes = [];
  const strokeRenderStates = new Map();
  const guideVisuals = new Map();
  const references = createSpatialReferenceStore({
    onReferenceChange: handleReferenceChange,
  });
  const guideGeometry = new THREE.PlaneGeometry(1, 1);
  const guideMaterial = new THREE.ShaderMaterial({
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    transparent: true,
    uniforms: {
      guideColor: { value: new THREE.Color(0x8fc9e8) },
      guideOpacity: { value: 0.14 },
    },
    vertexShader: `
      varying vec2 guideUv;
      void main() {
        guideUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 guideColor;
      uniform float guideOpacity;
      varying vec2 guideUv;
      void main() {
        float edgeDistance = min(
          min(guideUv.x, 1.0 - guideUv.x),
          min(guideUv.y, 1.0 - guideUv.y)
        );
        float edgeFade = smoothstep(0.0, 0.16, edgeDistance);
        gl_FragColor = vec4(guideColor, guideOpacity * edgeFade);
      }
    `,
  });
  const raycaster = new THREE.Raycaster();
  const rayInModelSpace = new THREE.Ray();
  const intersectionPlane = new THREE.Plane();
  const inverseTargetMatrix = new THREE.Matrix4();
  const activeDrawingSupport = {
    type: REFERENCE_TYPES.SURFACE,
    id: PRIMARY_MODEL_SURFACE_ID,
  };
  let activeStroke = null;
  let activePenId = null;
  let guideSelectionPenId = null;
  let guideSelectionPending = false;
  let pendingGuideSourceType = null;
  let activeTracePlaneId = null;
  let lastStrokePointCount = 0;
  let resumeAutoRotate = false;
  let modelDiagonal = 1;
  let surfaceOffset = 0.00002;
  let renderRequested = false;
  let lastProjectionError = null;
  let maximumProjectionError = 0;
  const tracePlaneOffsets = new Map();

  function pointValue(vector) {
    return {
      x: Number(vector.x),
      y: Number(vector.y),
      z: Number(vector.z),
    };
  }

  function setActiveDrawingSupport(type, id) {
    if (!references.hasReference(type, id)) return false;
    activeDrawingSupport.type = type;
    activeDrawingSupport.id = id;
    guideSelectionPending = false;
    pendingGuideSourceType = null;
    guideMenu.hidden = true;
    updateDrawingSupportUI();
    return true;
  }

  function updateDrawingSupportUI() {
    const guideActive = activeDrawingSupport.type === REFERENCE_TYPES.PLANE;
    modelSupportButton.setAttribute("aria-pressed", String(!guideActive));
    guideSupportButton.setAttribute("aria-pressed", String(guideActive));
    guideInstruction.hidden = !guideSelectionPending;
    offsetControl.hidden = !guideActive;

    if (!guideActive) return;
    const state = tracePlaneOffsets.get(activeDrawingSupport.id);
    if (!state) return;
    offsetSlider.value = String(state.offset);
    offsetOutput.value = state.offset.toFixed(3);
  }

  function toggleGuideCreationMenu() {
    guideSelectionPending = false;
    pendingGuideSourceType = null;
    guideInstruction.hidden = true;
    const opening = guideMenu.hidden;
    guideMenu.hidden = !opening;
    offsetControl.hidden = opening
      || activeDrawingSupport.type !== REFERENCE_TYPES.PLANE;
  }

  function beginGuideSelection(sourceType) {
    if (sourceType !== "face" && sourceType !== "view") return;
    guideSelectionPending = true;
    pendingGuideSourceType = sourceType;
    guideMenu.hidden = true;
    guideInstruction.textContent = sourceType === "view"
      ? "Tap a surface · From View"
      : "Tap a surface · From Face";
    guideInstruction.hidden = false;
    offsetControl.hidden = true;
  }

  function guideSize() {
    return Math.max(modelDiagonal * 0.45, 0.01);
  }

  function configureOffsetSlider() {
    const limit = Math.max(modelDiagonal * 0.15, 0.01);
    offsetSlider.min = String(-limit);
    offsetSlider.max = String(limit);
    offsetSlider.step = String(Math.max(modelDiagonal / 1000, 0.001));
  }

  function stablePlaneAxes(normalValue) {
    const normal = new THREE.Vector3(
      normalValue.x,
      normalValue.y,
      normalValue.z,
    ).normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const verticalInPlane = worldUp.clone().addScaledVector(
      normal,
      -worldUp.dot(normal),
    );

    if (verticalInPlane.lengthSq() > 1e-8) {
      const yAxis = verticalInPlane.normalize();
      const xAxis = new THREE.Vector3().crossVectors(yAxis, normal).normalize();
      return { xAxis: pointValue(xAxis), yAxis: pointValue(yAxis) };
    }

    syncCamera();
    inverseTargetMatrix.copy(targetRoot.matrixWorld).invert();
    const cameraRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
      .transformDirection(inverseTargetMatrix);
    cameraRight.addScaledVector(normal, -cameraRight.dot(normal));
    if (cameraRight.lengthSq() <= 1e-8) {
      cameraRight.set(1, 0, 0).addScaledVector(normal, -normal.x);
    }
    if (cameraRight.lengthSq() <= 1e-8) {
      cameraRight.set(0, 0, 1).addScaledVector(normal, -normal.z);
    }

    const xAxis = cameraRight.normalize();
    const yAxis = new THREE.Vector3().crossVectors(normal, xAxis).normalize();
    return { xAxis: pointValue(xAxis), yAxis: pointValue(yAxis) };
  }

  function viewPlaneFrame() {
    if (!syncCamera()) return null;
    inverseTargetMatrix.copy(targetRoot.matrixWorld).invert();

    const cameraForward = camera.getWorldDirection(new THREE.Vector3())
      .transformDirection(inverseTargetMatrix);
    const normal = cameraForward.negate().normalize();
    const cameraRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
      .transformDirection(inverseTargetMatrix);
    const cameraUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
      .transformDirection(inverseTargetMatrix);

    cameraRight.addScaledVector(normal, -cameraRight.dot(normal));
    if (cameraRight.lengthSq() <= 1e-8) return null;
    const xAxis = cameraRight.normalize();
    const yAxis = new THREE.Vector3().crossVectors(normal, xAxis).normalize();
    if (yAxis.dot(cameraUp) < 0) {
      xAxis.negate();
      yAxis.crossVectors(normal, xAxis).normalize();
    }

    return {
      normal: pointValue(normal),
      xAxis: pointValue(xAxis),
      yAxis: pointValue(yAxis),
    };
  }

  function ensureGuideVisual(plane) {
    let mesh = guideVisuals.get(plane.id);
    if (!mesh) {
      mesh = new THREE.Mesh(guideGeometry, guideMaterial);
      mesh.renderOrder = 1;
      mesh.frustumCulled = false;
      guideVisuals.set(plane.id, mesh);
      targetRoot.add(mesh);
    }
    return mesh;
  }

  function updateGuideVisual(plane) {
    const mesh = ensureGuideVisual(plane);
    const normal = new THREE.Vector3(plane.normal.x, plane.normal.y, plane.normal.z);
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(plane.xAxis.x, plane.xAxis.y, plane.xAxis.z),
      new THREE.Vector3(plane.yAxis.x, plane.yAxis.y, plane.yAxis.z),
      normal,
    );
    mesh.position.set(
      plane.origin.x + normal.x * surfaceOffset,
      plane.origin.y + normal.y * surfaceOffset,
      plane.origin.z + normal.z * surfaceOffset,
    );
    mesh.quaternion.setFromRotationMatrix(basis);
    mesh.scale.set(plane.width, plane.height, 1);
    mesh.visible = plane.visible;
    mesh.updateMatrix();
  }

  function handleReferenceChange(referenceType, referenceId) {
    if (referenceType === REFERENCE_TYPES.PLANE) {
      const plane = references.getTracePlane(referenceId);
      if (plane) updateGuideVisual(plane);
    }
    refreshStrokesForReference(referenceType, referenceId);
  }

  function createGuideFromHit(hit, sourceType) {
    const origin = pointValue(hit.position);
    const faceNormal = pointValue(hit.normal);
    const frame = sourceType === "view"
      ? viewPlaneFrame()
      : { normal: faceNormal, ...stablePlaneAxes(faceNormal) };
    if (!frame) return false;
    const size = guideSize();
    const plane = references.createTracePlane({
      origin,
      normal: frame.normal,
      xAxis: frame.xAxis,
      yAxis: frame.yAxis,
      width: size,
      height: size,
      visible: true,
      locked: false,
      sourceType,
    });
    tracePlaneOffsets.set(plane.id, { baseOrigin: origin, offset: 0 });
    activeTracePlaneId = plane.id;
    configureOffsetSlider();
    setActiveDrawingSupport(REFERENCE_TYPES.PLANE, plane.id);
    requestRender();
    return true;
  }

  function setActiveGuideOffset(value) {
    if (activeDrawingSupport.type !== REFERENCE_TYPES.PLANE) return;
    const plane = references.getTracePlane(activeDrawingSupport.id);
    const state = tracePlaneOffsets.get(activeDrawingSupport.id);
    if (!plane || !state) return;

    const offset = Number(value);
    if (!Number.isFinite(offset)) return;
    state.offset = offset;
    references.updateTracePlane(plane.id, {
      origin: {
        x: state.baseOrigin.x + plane.normal.x * offset,
        y: state.baseOrigin.y + plane.normal.y * offset,
        z: state.baseOrigin.z + plane.normal.z * offset,
      },
    });
    offsetOutput.value = offset.toFixed(3);
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
    configureOffsetSlider();
    for (const plane of references.listTracePlanes()) updateGuideVisual(plane);
    for (const stroke of strokes) rebuildStrokeGeometry(stroke);
    if (activeStroke) rebuildStrokeGeometry(activeStroke);
  }

  function createRenderableStroke(referenceType, referenceId) {
    const stroke = createStrokeRecord({
      referenceType,
      referenceId,
      references,
    });
    const capacity = 128;
    const positions = new Float32Array(capacity * 3);
    const geometry = new THREE.BufferGeometry();
    const attribute = new THREE.BufferAttribute(positions, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", attribute);
    geometry.setDrawRange(0, 0);

    const line = new THREE.Line(geometry, strokeMaterial);
    line.renderOrder = 2;
    line.frustumCulled = false;
    targetRoot.add(line);
    strokeRenderStates.set(stroke.id, {
      capacity,
      positions,
      attribute,
      geometry,
      line,
    });
    return stroke;
  }

  function createSurfaceStroke() {
    return createRenderableStroke(
      REFERENCE_TYPES.SURFACE,
      PRIMARY_MODEL_SURFACE_ID,
    );
  }

  function createActiveStroke() {
    return createRenderableStroke(
      activeDrawingSupport.type,
      activeDrawingSupport.id,
    );
  }

  function getStrokeRenderState(stroke) {
    const renderState = strokeRenderStates.get(stroke.id);
    if (!renderState) throw new Error(`Missing render state for stroke: ${stroke.id}`);
    return renderState;
  }

  function ensureStrokeCapacity(stroke, pointCount) {
    const renderState = getStrokeRenderState(stroke);
    if (pointCount <= renderState.capacity) return;
    let capacity = renderState.capacity;
    while (capacity < pointCount) capacity *= 2;

    const positions = new Float32Array(capacity * 3);
    positions.set(renderState.positions);
    const attribute = new THREE.BufferAttribute(positions, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    renderState.capacity = capacity;
    renderState.positions = positions;
    renderState.attribute = attribute;
    renderState.geometry.setAttribute("position", attribute);
  }

  function writeStrokePoint(stroke, index) {
    const point = stroke.points[index];
    const position = resolveStrokePoint(stroke, point, references, {
      surfaceOffset,
      planeOffset: surfaceOffset * 2,
    });
    const renderState = getStrokeRenderState(stroke);
    const target = index * 3;
    renderState.positions[target] = position.x;
    renderState.positions[target + 1] = position.y;
    renderState.positions[target + 2] = position.z;
  }

  function updateStrokeDrawRange(stroke) {
    const renderState = getStrokeRenderState(stroke);
    renderState.geometry.setDrawRange(0, stroke.points.length);
    renderState.attribute.needsUpdate = true;
    renderState.line.visible = isStrokeReferenceVisible(stroke, references);
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

  function refreshStrokesForReference(referenceType, referenceId) {
    for (const stroke of strokes) {
      if (
        stroke.referenceType === referenceType
        && stroke.referenceId === referenceId
      ) {
        rebuildStrokeGeometry(stroke);
      }
    }
    if (
      activeStroke?.referenceType === referenceType
      && activeStroke.referenceId === referenceId
    ) {
      rebuildStrokeGeometry(activeStroke);
    }
    requestRender();
  }

  function disposeStroke(stroke) {
    const renderState = strokeRenderStates.get(stroke.id);
    if (!renderState) return;
    targetRoot.remove(renderState.line);
    renderState.geometry.dispose();
    strokeRenderStates.delete(stroke.id);
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

  function intersectTracePlane(sample, planeId) {
    const plane = references.getTracePlane(planeId);
    if (!plane || !plane.visible || !syncCamera()) return null;

    const rect = viewerShell.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((sample.clientX - rect.left) / rect.width) * 2 - 1,
      -((sample.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    inverseTargetMatrix.copy(targetRoot.matrixWorld).invert();
    rayInModelSpace.copy(raycaster.ray).applyMatrix4(inverseTargetMatrix);

    const normal = new THREE.Vector3(plane.normal.x, plane.normal.y, plane.normal.z);
    const origin = new THREE.Vector3(plane.origin.x, plane.origin.y, plane.origin.z);
    intersectionPlane.setFromNormalAndCoplanarPoint(normal, origin);
    const position = rayInModelSpace.intersectPlane(
      intersectionPlane,
      new THREE.Vector3(),
    );
    if (!position) return null;

    const delta = position.clone().sub(origin);
    const xAxis = new THREE.Vector3(plane.xAxis.x, plane.xAxis.y, plane.xAxis.z);
    const yAxis = new THREE.Vector3(plane.yAxis.x, plane.yAxis.y, plane.yAxis.z);
    const u = delta.dot(xAxis);
    const v = delta.dot(yAxis);
    return { position, normal, u, v };
  }

  function addLocalTestStroke() {
    const enabled = location.hostname === "localhost"
      && new URLSearchParams(location.search).has("sketch-test");
    if (!enabled) return;

    const rect = viewerShell.getBoundingClientRect();
    const stroke = createSurfaceStroke();
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

  function addLocalGuideTest() {
    const params = new URLSearchParams(location.search);
    const enabled = location.hostname === "localhost" && params.has("guide-test");
    if (!enabled) return;
    const sourceType = params.get("guide-test") === "view" ? "view" : "face";

    const rect = viewerShell.getBoundingClientRect();
    const candidates = [
      [0.5, 0.5],
      [0.45, 0.5],
      [0.55, 0.5],
      [0.5, 0.45],
      [0.5, 0.55],
    ];
    let guideHit = null;
    for (const [xRatio, yRatio] of candidates) {
      guideHit = hitTest({
        clientX: rect.left + rect.width * xRatio,
        clientY: rect.top + rect.height * yRatio,
      });
      if (guideHit) break;
    }
    if (!guideHit) {
      canvas.dataset.localGuideTestPoints = "no-hit";
      return;
    }

    if (!createGuideFromHit(guideHit, sourceType)) {
      canvas.dataset.localGuideTestPoints = "frame-error";
      return;
    }
    const stroke = createActiveStroke();
    let outsidePreviewPoints = 0;
    for (let index = 0; index <= 24; index += 1) {
      const progress = index / 24;
      const sample = {
        clientX: rect.left + rect.width * (0.18 + progress * 0.64),
        clientY: rect.top + rect.height * (
          0.5 + Math.sin(progress * Math.PI * 2) * 0.045
        ),
      };
      const hit = intersectTracePlane(sample, activeTracePlaneId);
      if (!hit) continue;
      const plane = references.getTracePlane(activeTracePlaneId);
      if (
        Math.abs(hit.u) > plane.width / 2
        || Math.abs(hit.v) > plane.height / 2
      ) {
        outsidePreviewPoints += 1;
      }
      appendStrokePoint(stroke, {
        u: hit.u,
        v: hit.v,
        pressure: 0.5,
        tiltX: 0,
        tiltY: 0,
        timestamp: performance.now(),
      });
    }

    if (stroke.points.length >= 2) {
      strokes.push(stroke);
      lastStrokePointCount = stroke.points.length;
      canvas.dataset.localGuideTestPoints = String(stroke.points.length);
      canvas.dataset.localGuideTestReference = stroke.referenceId;
      canvas.dataset.localGuideTestSource = sourceType;
      canvas.dataset.localGuideOutsidePoints = String(outsidePreviewPoints);
      updatePointCount();
      updateActionState();
    } else {
      disposeStroke(stroke);
      canvas.dataset.localGuideTestPoints = "0";
    }
    requestRender();
  }

  function inspectPenSample(sample, { store = false } = {}) {
    const referenceType = store && activeStroke
      ? activeStroke.referenceType
      : activeDrawingSupport.type;
    const referenceId = store && activeStroke
      ? activeStroke.referenceId
      : activeDrawingSupport.id;
    const hit = referenceType === REFERENCE_TYPES.PLANE
      ? intersectTracePlane(sample, referenceId)
      : hitTest(sample);
    const pressure = Number(sample.pressure) || 0;

    debug.pointerType.textContent = "pen";
    debug.hit.textContent = hit ? "yes" : "no";
    debug.pressure.textContent = pressure.toFixed(3);
    debug.xyz.textContent = hit
      ? `${hit.position.x.toFixed(3)}, ${hit.position.y.toFixed(3)}, ${hit.position.z.toFixed(3)}`
      : "—";

    if (!store || !hit || !activeStroke) return;

    const inputData = {
      pressure,
      tiltX: Number(sample.tiltX) || 0,
      tiltY: Number(sample.tiltY) || 0,
      timestamp: Number(sample.timeStamp),
    };
    const point = referenceType === REFERENCE_TYPES.PLANE
      ? { u: hit.u, v: hit.v, ...inputData }
      : {
          position: pointValue(hit.position),
          normal: pointValue(hit.normal),
          ...inputData,
        };
    appendStrokePoint(activeStroke, point);
    trackProjectionError(pointValue(hit.position), sample);
    updatePointCount();
  }

  function samplesFrom(event) {
    if (event.type !== "pointermove" || typeof event.getCoalescedEvents !== "function") {
      return [event];
    }
    const samples = event.getCoalescedEvents();
    return samples.length ? samples : [event];
  }

  function selectGuideSurface(event) {
    const hit = hitTest(event);
    const pressure = Number(event.pressure) || 0;
    debug.pointerType.textContent = "pen";
    debug.hit.textContent = hit ? "yes" : "no";
    debug.pressure.textContent = pressure.toFixed(3);
    debug.xyz.textContent = hit
      ? `${hit.position.x.toFixed(3)}, ${hit.position.y.toFixed(3)}, ${hit.position.z.toFixed(3)}`
      : "—";
    if (hit) createGuideFromHit(hit, pendingGuideSourceType || "face");
  }

  function beginPenStroke(event) {
    if (activePenId !== null) return;
    activePenId = event.pointerId;
    activeStroke = createActiveStroke();
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

    if (guideSelectionPending) {
      guideSelectionPenId = event.pointerId;
      try {
        modelViewer.setPointerCapture(event.pointerId);
      } catch {
        // The selection still works when pointer capture is unavailable.
      }
      selectGuideSurface(event);
      return;
    }

    beginPenStroke(event);
  }

  function onPointerMove(event) {
    debug.pointerType.textContent = event.pointerType || "unknown";
    if (event.pointerType !== "pen") return;

    if (event.pointerId === guideSelectionPenId) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

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
    if (event.pointerId === guideSelectionPenId) {
      event.preventDefault();
      event.stopImmediatePropagation();
      guideSelectionPenId = null;
      return;
    }
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

  modelSupportButton.addEventListener("click", () => {
    setActiveDrawingSupport(
      REFERENCE_TYPES.SURFACE,
      PRIMARY_MODEL_SURFACE_ID,
    );
  });

  guideSupportButton.addEventListener("click", () => {
    if (!activeTracePlaneId) {
      toggleGuideCreationMenu();
      return;
    }
    const plane = references.getTracePlane(activeTracePlaneId);
    if (plane && !plane.visible) {
      references.updateTracePlane(activeTracePlaneId, { visible: true });
    }
    setActiveDrawingSupport(REFERENCE_TYPES.PLANE, activeTracePlaneId);
  });

  newGuideButton.addEventListener("click", toggleGuideCreationMenu);
  fromFaceButton.addEventListener("click", () => beginGuideSelection("face"));
  fromViewButton.addEventListener("click", () => beginGuideSelection("view"));
  offsetSlider.addEventListener("input", () => {
    setActiveGuideOffset(offsetSlider.value);
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
      addLocalGuideTest();
    });
  });

  const resizeObserver = new ResizeObserver(resizeRenderer);
  resizeObserver.observe(viewerShell);
  window.addEventListener("resize", resizeRenderer);
  document.addEventListener("fullscreenchange", resizeRenderer);
  updateDrawingSupportUI();
  resizeRenderer();

  const spatialInspection = Object.freeze({
    getStrokes: () => structuredClone(strokes),
    getTracePlanes: () => structuredClone(references.listTracePlanes()),
    getActiveDrawingSupport: () => structuredClone(activeDrawingSupport),
    getRendererState: () => ({
      lastProjectionError,
      maximumProjectionError,
      modelDiagonal,
      surfaceOffset,
      strokeCount: strokes.length,
      renderObjectCount: strokeRenderStates.size,
      primarySurfaceReferenceId: PRIMARY_MODEL_SURFACE_ID,
    }),
  });

  // Keep the previous inspection name for compatibility with Sprint 01B tests.
  Object.defineProperty(window, "__sketchSprint01B", {
    configurable: true,
    value: spatialInspection,
  });
  Object.defineProperty(window, "__sketchSpatialModel", {
    configurable: true,
    value: spatialInspection,
  });
}
