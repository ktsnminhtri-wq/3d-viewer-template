import * as THREE from "https://unpkg.com/three@0.174.0/build/three.module.js";
import {
  REFERENCE_TYPES,
  createModelSurfaceId,
  createSpatialReferenceStore,
  createStrokeRecord,
  isStrokeReferenceVisible,
  resolveStrokePoint,
} from "./sketch-spatial-model.js";

const modelViewer = document.querySelector("#modelViewer");
const viewerShell = document.querySelector("#viewerShell");

if (modelViewer && viewerShell) {
  const requestedModelSource = new URLSearchParams(window.location.search).get("model")
    || modelViewer.dataset.defaultModel
    || "./model.glb";
  const primaryModelSource = modelViewer.dataset.modelIdentity
    || new URL(requestedModelSource, document.baseURI).href;
  const primaryModelSurfaceId = createModelSurfaceId(primaryModelSource);
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
      <span class="sketch-debug__badge">Sprint 07</span>
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
      <button type="button" data-guide-source="draw">Draw Guide</button>
    </div>
    <p class="sketch-guide-instruction" data-guide-instruction hidden>Tap a surface</p>
    <p class="sketch-constraint-hint" data-constraint-hint hidden></p>
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
  const drawGuideButton = debugPanel.querySelector('[data-guide-source="draw"]');
  const offsetControl = debugPanel.querySelector("[data-guide-offset]");
  const offsetSlider = offsetControl.querySelector('input[type="range"]');
  const offsetOutput = offsetControl.querySelector("output");

  const strokes = [];
  const strokeRenderStates = new Map();
  const guideVisuals = new Map();
  const references = createSpatialReferenceStore({
    onReferenceChange: handleReferenceChange,
    primarySurfaceId: primaryModelSurfaceId,
    primarySurfaceSource: primaryModelSource,
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
  const guideDraftMaterial = new THREE.LineDashedMaterial({
    color: 0xb9e2ff,
    dashSize: 0.03,
    depthTest: false,
    depthWrite: false,
    gapSize: 0.018,
    opacity: 0.9,
    transparent: true,
  });
  const guideDraftGeometry = new THREE.BufferGeometry();
  const guideDraftRenderState = {
    capacity: 128,
    positions: new Float32Array(128 * 3),
    distances: new Float32Array(128),
  };
  guideDraftRenderState.positionAttribute = new THREE.BufferAttribute(
    guideDraftRenderState.positions,
    3,
  );
  guideDraftRenderState.distanceAttribute = new THREE.BufferAttribute(
    guideDraftRenderState.distances,
    1,
  );
  guideDraftRenderState.positionAttribute.setUsage(THREE.DynamicDrawUsage);
  guideDraftRenderState.distanceAttribute.setUsage(THREE.DynamicDrawUsage);
  guideDraftGeometry.setAttribute("position", guideDraftRenderState.positionAttribute);
  guideDraftGeometry.setAttribute("lineDistance", guideDraftRenderState.distanceAttribute);
  guideDraftGeometry.setDrawRange(0, 0);
  const guideDraftLine = new THREE.Line(guideDraftGeometry, guideDraftMaterial);
  guideDraftLine.frustumCulled = false;
  guideDraftLine.renderOrder = 3;
  guideDraftLine.visible = false;
  targetRoot.add(guideDraftLine);
  const raycaster = new THREE.Raycaster();
  const rayInModelSpace = new THREE.Ray();
  const intersectionPlane = new THREE.Plane();
  const inverseTargetMatrix = new THREE.Matrix4();
  const activeDrawingSupport = {
    type: REFERENCE_TYPES.SURFACE,
    id: primaryModelSurfaceId,
  };
  let activeStroke = null;
  let activePenId = null;
  let guideSelectionPenId = null;
  let guideSelectionPending = false;
  let pendingGuideSourceType = null;
  let guideDraft = null;
  let activeTracePlaneId = null;
  let lastStrokePointCount = 0;
  let resumeAutoRotate = false;
  let modelDiagonal = 1;
  let surfaceOffset = 0.00002;
  let renderRequested = false;
  let lastProjectionError = null;
  let maximumProjectionError = 0;
  const tracePlaneOffsets = new Map();
  const constraintHint = debugPanel.querySelector("[data-constraint-hint]");
  const suppressedTouchIds = new Set();
  const touchTapCandidates = new Map();
  const penRawHistory = [];
  const directionConstraint = {
    touchId: null,
    timer: null,
    active: false,
    axis: null,
    baseline: null,
    startX: 0,
    startY: 0,
  };
  let lastGuideTap = null;
  let transientMessageTimer = null;

  function pointValue(vector) {
    return {
      x: Number(vector.x),
      y: Number(vector.y),
      z: Number(vector.z),
    };
  }

  function setActiveDrawingSupport(type, id) {
    if (!references.hasReference(type, id)) return false;
    clearGuideDraft();
    activeDrawingSupport.type = type;
    activeDrawingSupport.id = id;
    guideSelectionPending = false;
    pendingGuideSourceType = null;
    guideMenu.hidden = true;
    updateDrawingSupportUI();
    return true;
  }

  function showGuideMessage(message, { transient = false } = {}) {
    if (transientMessageTimer) {
      clearTimeout(transientMessageTimer);
      transientMessageTimer = null;
    }
    guideInstruction.textContent = message;
    guideInstruction.hidden = false;
    if (!transient) return;
    transientMessageTimer = setTimeout(() => {
      if (!guideSelectionPending) guideInstruction.hidden = true;
      transientMessageTimer = null;
    }, 1400);
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
    clearGuideDraft();
    guideSelectionPending = false;
    pendingGuideSourceType = null;
    guideInstruction.hidden = true;
    const opening = guideMenu.hidden;
    guideMenu.hidden = !opening;
    offsetControl.hidden = opening
      || activeDrawingSupport.type !== REFERENCE_TYPES.PLANE;
  }

  function beginGuideSelection(sourceType) {
    if (sourceType !== "face" && sourceType !== "draw") return;
    clearGuideDraft();
    guideSelectionPending = true;
    pendingGuideSourceType = sourceType;
    guideMenu.hidden = true;
    showGuideMessage(sourceType === "draw"
      ? "Start on model · Draw one line"
      : "Tap a surface · From Face");
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

  function clearGuideDraft() {
    guideDraft = null;
    guideDraftLine.visible = false;
    guideDraftGeometry.setDrawRange(0, 0);
    canvas.dataset.guideDraftPoints = "0";
    canvas.dataset.guideDraftVisible = "false";
  }

  function ensureGuideDraftCapacity(pointCount) {
    if (pointCount <= guideDraftRenderState.capacity) return;
    let capacity = guideDraftRenderState.capacity;
    while (capacity < pointCount) capacity *= 2;
    const positions = new Float32Array(capacity * 3);
    const distances = new Float32Array(capacity);
    positions.set(guideDraftRenderState.positions);
    distances.set(guideDraftRenderState.distances);
    guideDraftRenderState.capacity = capacity;
    guideDraftRenderState.positions = positions;
    guideDraftRenderState.distances = distances;
    guideDraftRenderState.positionAttribute = new THREE.BufferAttribute(positions, 3);
    guideDraftRenderState.distanceAttribute = new THREE.BufferAttribute(distances, 1);
    guideDraftRenderState.positionAttribute.setUsage(THREE.DynamicDrawUsage);
    guideDraftRenderState.distanceAttribute.setUsage(THREE.DynamicDrawUsage);
    guideDraftGeometry.setAttribute("position", guideDraftRenderState.positionAttribute);
    guideDraftGeometry.setAttribute("lineDistance", guideDraftRenderState.distanceAttribute);
  }

  function updateGuideDraftVisual() {
    const pointCount = guideDraft?.points.length ?? 0;
    if (!pointCount) {
      guideDraftLine.visible = false;
      guideDraftGeometry.setDrawRange(0, 0);
      return;
    }

    ensureGuideDraftCapacity(pointCount);
    const index = pointCount - 1;
    const point = guideDraft.points[index];
    const positionIndex = index * 3;
    guideDraftRenderState.positions[positionIndex] = point.x;
    guideDraftRenderState.positions[positionIndex + 1] = point.y;
    guideDraftRenderState.positions[positionIndex + 2] = point.z;
    guideDraftRenderState.distances[index] = index === 0
      ? 0
      : guideDraftRenderState.distances[index - 1]
        + point.distanceTo(guideDraft.points[index - 1]);
    guideDraftRenderState.positionAttribute.needsUpdate = true;
    guideDraftRenderState.distanceAttribute.needsUpdate = true;
    guideDraftGeometry.setDrawRange(0, pointCount);
    guideDraftLine.visible = pointCount > 1;
    canvas.dataset.guideDraftPoints = String(pointCount);
    canvas.dataset.guideDraftVisible = String(guideDraftLine.visible);
    requestRender();
  }

  function appendGuideDraftSample(sample) {
    if (!guideDraft) return false;
    const hit = intersectPlaneFrame(sample, guideDraft.frame);
    if (!hit) return false;
    const lastPoint = guideDraft.points.at(-1);
    const minimumSpacing = Math.max(modelDiagonal * 0.00015, 0.00001);
    if (lastPoint && hit.position.distanceToSquared(lastPoint) < minimumSpacing ** 2) {
      return false;
    }
    guideDraft.points.push(hit.position);
    guideDraft.endClientX = sample.clientX;
    guideDraft.endClientY = sample.clientY;
    updateGuideDraftVisual();
    return true;
  }

  function beginDrawGuideDraft(event) {
    const anchorHit = hitTest(event);
    if (!anchorHit) {
      showGuideMessage("Start on model");
      return false;
    }
    const frame = viewPlaneFrame();
    if (!frame) {
      showGuideMessage("Camera unavailable");
      return false;
    }

    const anchor = new THREE.Vector3(
      anchorHit.position.x,
      anchorHit.position.y,
      anchorHit.position.z,
    );
    guideDraft = {
      pointerId: event.pointerId,
      frame: { ...frame, origin: pointValue(anchor) },
      points: [anchor],
      startClientX: event.clientX,
      startClientY: event.clientY,
      endClientX: event.clientX,
      endClientY: event.clientY,
    };
    guideSelectionPenId = event.pointerId;
    guideDraftMaterial.dashSize = Math.max(modelDiagonal * 0.012, 0.002);
    guideDraftMaterial.gapSize = Math.max(modelDiagonal * 0.007, 0.001);
    showGuideMessage("Draw one guide line");
    updateGuideDraftVisual();
    return true;
  }

  function createGuideFromDrawGesture(draft) {
    if (!draft || draft.points.length < 2) return false;
    const start = draft.points[0];
    const end = draft.points.at(-1);
    const screenLength = Math.hypot(
      draft.endClientX - draft.startClientX,
      draft.endClientY - draft.startClientY,
    );
    const normal = new THREE.Vector3(
      draft.frame.normal.x,
      draft.frame.normal.y,
      draft.frame.normal.z,
    ).normalize();
    const xAxis = end.clone().sub(start);
    xAxis.addScaledVector(normal, -xAxis.dot(normal));
    if (screenLength < 14 || xAxis.length() < Math.max(modelDiagonal * 0.002, 0.0001)) {
      return false;
    }
    xAxis.normalize();
    const yAxis = new THREE.Vector3().crossVectors(normal, xAxis).normalize();

    const origin = pointValue(start);
    const size = guideSize();
    const plane = references.createTracePlane({
      origin,
      normal: pointValue(normal),
      xAxis: pointValue(xAxis),
      yAxis: pointValue(yAxis),
      width: size,
      height: size,
      visible: true,
      locked: false,
      sourceType: "draw",
    });
    tracePlaneOffsets.set(plane.id, { baseOrigin: origin, offset: 0 });
    activeTracePlaneId = plane.id;
    configureOffsetSlider();
    setActiveDrawingSupport(REFERENCE_TYPES.PLANE, plane.id);
    requestRender();
    return true;
  }

  function finishDrawGuideDraft(event) {
    if (!guideDraft || event.pointerId !== guideDraft.pointerId) return false;
    if (event.type === "pointerup") appendGuideDraftSample(event);
    const completedDraft = guideDraft;
    guideDraftLine.visible = false;
    guideDraftGeometry.setDrawRange(0, 0);
    guideDraft = null;
    if (!createGuideFromDrawGesture(completedDraft)) {
      showGuideMessage("Draw a longer line");
      return false;
    }
    return true;
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

  function createFaceGuideFromHit(hit) {
    const origin = pointValue(hit.position);
    const faceNormal = pointValue(hit.normal);
    const frame = { normal: faceNormal, ...stablePlaneAxes(faceNormal) };
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
      sourceType: "face",
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
      primaryModelSurfaceId,
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

  function intersectPlaneFrame(sample, plane) {
    if (!plane || !syncCamera()) return null;
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

  function intersectTracePlane(sample, planeId) {
    const plane = references.getTracePlane(planeId);
    if (!plane || !plane.visible) return null;
    return intersectPlaneFrame(sample, plane);
  }

  function guidePreviewContains(hit, plane) {
    return Boolean(
      hit
      && plane
      && Math.abs(hit.u) <= plane.width / 2
      && Math.abs(hit.v) <= plane.height / 2
    );
  }

  function alignCameraToGuide(focusPoint) {
    if (
      activeDrawingSupport.type !== REFERENCE_TYPES.PLANE
      || !activeDrawingSupport.id
      || !syncCamera()
    ) return false;
    const plane = references.getTracePlane(activeDrawingSupport.id);
    const orbit = modelViewer.getCameraOrbit?.();
    if (!plane || !orbit) return false;

    const direction = new THREE.Vector3(
      plane.normal.x,
      plane.normal.y,
      plane.normal.z,
    ).applyAxisAngle(new THREE.Vector3(0, 1, 0), turntableRoot.rotation.y).normalize();
    const currentCameraDirection = camera.position.clone().normalize();
    if (direction.dot(currentCameraDirection) < 0) direction.negate();

    const twoPointMode = document.querySelector("#twoPointButton")
      ?.getAttribute("aria-pressed") === "true";
    if (twoPointMode) {
      direction.y = 0;
      if (direction.lengthSq() <= 1e-8) {
        showGuideMessage("Use 3P for this Guide", { transient: true });
        return false;
      }
      direction.normalize();
    }

    const spherical = new THREE.Spherical().setFromVector3(
      direction.multiplyScalar(orbit.radius),
    );
    const focus = focusPoint || plane.origin;
    if (modelViewer.hasAttribute("auto-rotate")) {
      document.querySelector("#rotateButton")?.click();
    }
    modelViewer.cameraTarget = `${focus.x}m ${focus.y}m ${focus.z}m`;
    modelViewer.cameraOrbit = `${spherical.theta}rad ${spherical.phi}rad ${orbit.radius}m`;
    showGuideMessage("View aligned", { transient: true });
    requestRender();
    return true;
  }

  function registerGuideTap(candidate) {
    if (activeDrawingSupport.type !== REFERENCE_TYPES.PLANE) return;
    const plane = references.getTracePlane(activeDrawingSupport.id);
    const hit = intersectTracePlane(candidate, activeDrawingSupport.id);
    if (!guidePreviewContains(hit, plane)) {
      lastGuideTap = null;
      return;
    }

    const now = performance.now();
    if (
      lastGuideTap
      && now - lastGuideTap.time <= 360
      && Math.hypot(
        candidate.clientX - lastGuideTap.clientX,
        candidate.clientY - lastGuideTap.clientY,
      ) <= 36
    ) {
      lastGuideTap = null;
      alignCameraToGuide(pointValue(hit.position));
      return;
    }
    lastGuideTap = {
      time: now,
      clientX: candidate.clientX,
      clientY: candidate.clientY,
    };
  }

  function clearConstraintTimer() {
    if (directionConstraint.timer) clearTimeout(directionConstraint.timer);
    directionConstraint.timer = null;
  }

  function constraintAxisFromHistory() {
    if (penRawHistory.length < 2 || !activeStroke) return null;
    const latest = penRawHistory.at(-1);
    const earlier = penRawHistory[Math.max(0, penRawHistory.length - 7)];
    const threshold = Math.cos(35 * Math.PI / 180);

    if (activeStroke.referenceType === REFERENCE_TYPES.PLANE) {
      const du = latest.u - earlier.u;
      const dv = latest.v - earlier.v;
      const length = Math.hypot(du, dv);
      if (length <= Math.max(modelDiagonal * 0.0002, 0.00001)) return null;
      const xScore = Math.abs(du) / length;
      const yScore = Math.abs(dv) / length;
      const score = Math.max(xScore, yScore);
      if (score < threshold) return null;
      return xScore >= yScore ? "guide-x" : "guide-y";
    }

    const delta = new THREE.Vector3(
      latest.position.x - earlier.position.x,
      latest.position.y - earlier.position.y,
      latest.position.z - earlier.position.z,
    );
    const length = delta.length();
    if (length <= Math.max(modelDiagonal * 0.0002, 0.00001)) return null;
    const scores = [
      ["world-y", Math.abs(delta.y) / length],
      ["world-x", Math.abs(delta.x) / length],
      ["world-z", Math.abs(delta.z) / length],
    ].sort((a, b) => b[1] - a[1]);
    return scores[0][1] >= threshold ? scores[0][0] : null;
  }

  function constraintLabel(axis) {
    if (axis === "guide-x") return "Along guide";
    if (axis === "guide-y") return "Across guide";
    if (axis === "world-y") return "Vertical";
    if (axis === "world-x" || axis === "world-z") return "Horizontal";
    return "Hold · move near a direction";
  }

  function updateConstraintHint() {
    constraintHint.hidden = !directionConstraint.active;
    if (directionConstraint.active) {
      constraintHint.textContent = constraintLabel(directionConstraint.axis);
    }
  }

  function activateDirectionConstraint() {
    directionConstraint.timer = null;
    if (
      directionConstraint.touchId === null
      || !activeStroke
      || activePenId === null
      || !activeStroke.points.length
    ) return;
    directionConstraint.active = true;
    directionConstraint.axis = constraintAxisFromHistory();
    directionConstraint.baseline = structuredClone(activeStroke.points.at(-1));
    updateConstraintHint();
  }

  function beginDirectionConstraint(event) {
    if (directionConstraint.touchId !== null) return;
    directionConstraint.touchId = event.pointerId;
    directionConstraint.startX = event.clientX;
    directionConstraint.startY = event.clientY;
    clearConstraintTimer();
    directionConstraint.timer = setTimeout(activateDirectionConstraint, 180);
  }

  function releaseDirectionConstraint({ keepTouch = false } = {}) {
    clearConstraintTimer();
    directionConstraint.active = false;
    directionConstraint.axis = null;
    directionConstraint.baseline = null;
    if (!keepTouch) directionConstraint.touchId = null;
    updateConstraintHint();
  }

  function applyDirectionConstraint(point) {
    if (!directionConstraint.active || !directionConstraint.baseline) return point;
    if (!directionConstraint.axis) {
      directionConstraint.axis = constraintAxisFromHistory();
      updateConstraintHint();
      if (!directionConstraint.axis) return point;
    }

    const baseline = directionConstraint.baseline;
    if (directionConstraint.axis === "guide-x") {
      return { ...point, v: baseline.v };
    }
    if (directionConstraint.axis === "guide-y") {
      return { ...point, u: baseline.u };
    }

    const axis = directionConstraint.axis === "world-y"
      ? new THREE.Vector3(0, 1, 0)
      : directionConstraint.axis === "world-x"
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 0, 1);
    const basePosition = new THREE.Vector3(
      baseline.position.x,
      baseline.position.y,
      baseline.position.z,
    );
    const rawPosition = new THREE.Vector3(
      point.position.x,
      point.position.y,
      point.position.z,
    );
    const position = basePosition.add(
      axis.multiplyScalar(rawPosition.sub(basePosition).dot(axis)),
    );
    return { ...point, position: pointValue(position) };
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
    const sourceType = ["draw", "view"].includes(params.get("guide-test"))
      ? "draw"
      : "face";

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

    let guideCreated = false;
    if (sourceType === "draw") {
      const frame = viewPlaneFrame();
      const anchor = new THREE.Vector3(
        guideHit.position.x,
        guideHit.position.y,
        guideHit.position.z,
      );
      const endSample = {
        clientX: rect.left + rect.width * 0.68,
        clientY: rect.top + rect.height * 0.44,
      };
      const endHit = frame && intersectPlaneFrame(endSample, {
        ...frame,
        origin: pointValue(anchor),
      });
      if (frame && endHit) {
        guideCreated = createGuideFromDrawGesture({
          frame: { ...frame, origin: pointValue(anchor) },
          points: [anchor, endHit.position],
          startClientX: rect.left + rect.width * 0.5,
          startClientY: rect.top + rect.height * 0.5,
          endClientX: endSample.clientX,
          endClientY: endSample.clientY,
        });
      }
    } else {
      guideCreated = createFaceGuideFromHit(guideHit);
    }
    if (!guideCreated) {
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
      const plane = references.getTracePlane(stroke.referenceId);
      canvas.dataset.localGuideSourceMetadata = plane?.sourceType || "missing";
      updatePointCount();
      updateActionState();
    } else {
      disposeStroke(stroke);
      canvas.dataset.localGuideTestPoints = "0";
    }
    requestRender();
  }

  function addLocalSprint07Checks() {
    const params = new URLSearchParams(location.search);
    if (location.hostname !== "localhost" || !params.has("sprint07-test")) return;

    const plane = activeTracePlaneId
      ? references.getTracePlane(activeTracePlaneId)
      : null;
    if (plane) {
      directionConstraint.active = true;
      directionConstraint.axis = "guide-x";
      directionConstraint.baseline = { u: 2, v: 3 };
      const guideX = applyDirectionConstraint({ u: 9, v: 11 });
      directionConstraint.axis = "guide-y";
      const guideY = applyDirectionConstraint({ u: 9, v: 11 });
      canvas.dataset.localGuideConstraint = (
        guideX.u === 9
        && guideX.v === 3
        && guideY.u === 2
        && guideY.v === 11
      ) ? "pass" : "fail";
      releaseDirectionConstraint();
    }

    directionConstraint.active = true;
    directionConstraint.axis = "world-y";
    directionConstraint.baseline = {
      position: { x: 1, y: 2, z: 3 },
    };
    const constrainedModelPoint = applyDirectionConstraint({
      position: { x: 7, y: 8, z: 9 },
      normal: { x: 0, y: 0, z: 1 },
    });
    canvas.dataset.localModelConstraint = (
      constrainedModelPoint.position.x === 1
      && constrainedModelPoint.position.y === 8
      && constrainedModelPoint.position.z === 3
    ) ? "pass" : "fail";
    releaseDirectionConstraint();

    if (plane && params.get("sprint07-test") === "align") {
      canvas.dataset.localGuideAlign = alignCameraToGuide(plane.origin)
        ? "requested"
        : "fail";
    }
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
    const rawPoint = referenceType === REFERENCE_TYPES.PLANE
      ? { u: hit.u, v: hit.v, ...inputData }
      : {
          position: pointValue(hit.position),
          normal: pointValue(hit.normal),
          ...inputData,
        };
    penRawHistory.push(structuredClone(rawPoint));
    if (penRawHistory.length > 12) penRawHistory.shift();
    const point = applyDirectionConstraint(rawPoint);
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
    if (hit) createFaceGuideFromHit(hit);
  }

  function onTouchPointerDown(event) {
    const penOwnsGesture = activePenId !== null || guideDraft !== null;
    if (penOwnsGesture) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressedTouchIds.add(event.pointerId);
      try {
        modelViewer.setPointerCapture(event.pointerId);
      } catch {
        // Suppression still works through capture-phase listeners.
      }
      if (activePenId !== null) beginDirectionConstraint(event);
      return;
    }

    if (activeDrawingSupport.type !== REFERENCE_TYPES.PLANE) return;
    const now = performance.now();
    const suppressNavigation = Boolean(
      lastGuideTap
      && now - lastGuideTap.time <= 360
      && Math.hypot(
        event.clientX - lastGuideTap.clientX,
        event.clientY - lastGuideTap.clientY,
      ) <= 36
    );
    touchTapCandidates.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      startTime: now,
      moved: false,
      suppressNavigation,
    });
    if (suppressNavigation) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function onTouchPointerMove(event) {
    if (suppressedTouchIds.has(event.pointerId)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (
        event.pointerId === directionConstraint.touchId
        && !directionConstraint.active
        && Math.hypot(
          event.clientX - directionConstraint.startX,
          event.clientY - directionConstraint.startY,
        ) > 12
      ) {
        clearConstraintTimer();
      }
      return;
    }
    const candidate = touchTapCandidates.get(event.pointerId);
    if (!candidate) return;
    candidate.clientX = event.clientX;
    candidate.clientY = event.clientY;
    if (Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY) > 12) {
      candidate.moved = true;
    }
    if (candidate.suppressNavigation) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function onTouchPointerEnd(event) {
    if (suppressedTouchIds.has(event.pointerId)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressedTouchIds.delete(event.pointerId);
      if (event.pointerId === directionConstraint.touchId) {
        releaseDirectionConstraint();
      }
      return;
    }

    const candidate = touchTapCandidates.get(event.pointerId);
    touchTapCandidates.delete(event.pointerId);
    if (!candidate) return;
    candidate.clientX = event.clientX;
    candidate.clientY = event.clientY;
    const isTap = event.type === "pointerup"
      && !candidate.moved
      && performance.now() - candidate.startTime <= 300;
    if (candidate.suppressNavigation) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    if (isTap) registerGuideTap(candidate);
  }

  function beginPenStroke(event) {
    if (activePenId !== null) return;
    penRawHistory.length = 0;
    releaseDirectionConstraint();
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
    penRawHistory.length = 0;
    releaseDirectionConstraint({
      keepTouch: directionConstraint.touchId !== null,
    });
    if (resumeAutoRotate) modelViewer.setAttribute("auto-rotate", "");
    resumeAutoRotate = false;
    debug.penActive.textContent = "no";
    updatePointCount();
    updateActionState();
    requestRender();
  }

  function onPointerDown(event) {
    debug.pointerType.textContent = event.pointerType || "unknown";
    if (event.pointerType === "touch") {
      onTouchPointerDown(event);
      return;
    }
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
      if (pendingGuideSourceType === "draw") {
        beginDrawGuideDraft(event);
      } else {
        selectGuideSurface(event);
      }
      return;
    }

    beginPenStroke(event);
  }

  function onPointerMove(event) {
    debug.pointerType.textContent = event.pointerType || "unknown";
    if (event.pointerType === "touch") {
      onTouchPointerMove(event);
      return;
    }
    if (event.pointerType !== "pen") return;

    if (event.pointerId === guideSelectionPenId) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (guideDraft) {
        for (const sample of samplesFrom(event)) appendGuideDraftSample(sample);
      }
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
    if (event.pointerType === "touch") {
      onTouchPointerEnd(event);
      return;
    }
    if (event.pointerId === guideSelectionPenId) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (guideDraft) {
        if (event.type === "pointercancel") {
          clearGuideDraft();
          showGuideMessage("Start on model · Draw one line");
        } else {
          finishDrawGuideDraft(event);
        }
      }
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
    penRawHistory.length = 0;
    clearGuideDraft();
    releaseDirectionConstraint({
      keepTouch: directionConstraint.touchId !== null,
    });
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
      primaryModelSurfaceId,
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
  drawGuideButton.addEventListener("click", () => beginGuideSelection("draw"));
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
      addLocalSprint07Checks();
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
    getGuideCreationState: () => ({
      mode: pendingGuideSourceType,
      pending: guideSelectionPending,
      draftPointCount: guideDraft?.points.length ?? 0,
    }),
    getConstraintState: () => ({
      active: directionConstraint.active,
      axis: directionConstraint.axis,
      touchId: directionConstraint.touchId,
    }),
    getRendererState: () => ({
      lastProjectionError,
      maximumProjectionError,
      modelDiagonal,
      surfaceOffset,
      strokeCount: strokes.length,
      renderObjectCount: strokeRenderStates.size,
      primarySurfaceReferenceId: primaryModelSurfaceId,
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
