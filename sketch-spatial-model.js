export const REFERENCE_TYPES = Object.freeze({
  SURFACE: "surface",
  PLANE: "plane",
});

// model-viewer returns hit position + normal, but no stable mesh/primitive ID.
// Surface strokes therefore reference the loaded model's local coordinate space.
export const PRIMARY_MODEL_SURFACE_ID = "surface:model.glb";

let nextLocalId = 1;

function createId(prefix) {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}:${globalThis.crypto.randomUUID()}`;
  }
  const id = `${prefix}:local-${nextLocalId}`;
  nextLocalId += 1;
  return id;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite.`);
  return number;
}

function vector3(value, label) {
  if (!value) throw new TypeError(`${label} is required.`);
  return {
    x: finiteNumber(value.x, `${label}.x`),
    y: finiteNumber(value.y, `${label}.y`),
    z: finiteNumber(value.z, `${label}.z`),
  };
}

function unitVector3(value, label) {
  const vector = vector3(value, label);
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (length === 0) throw new TypeError(`${label} cannot be zero length.`);
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function validatePlaneBasis(plane) {
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const tolerance = 1e-4;
  if (
    Math.abs(dot(plane.xAxis, plane.yAxis)) > tolerance
    || Math.abs(dot(plane.xAxis, plane.normal)) > tolerance
    || Math.abs(dot(plane.yAxis, plane.normal)) > tolerance
  ) {
    throw new TypeError("Trace Plane axes must be mutually perpendicular.");
  }
}

export function createSpatialReferenceStore({ onReferenceChange = () => {} } = {}) {
  const surfaceReferences = new Map();
  const tracePlanes = new Map();

  surfaceReferences.set(PRIMARY_MODEL_SURFACE_ID, Object.freeze({
    id: PRIMARY_MODEL_SURFACE_ID,
    coordinateSpace: "model-local",
    source: "./model.glb",
  }));

  function hasReference(referenceType, referenceId) {
    if (referenceType === REFERENCE_TYPES.SURFACE) {
      return surfaceReferences.has(referenceId);
    }
    if (referenceType === REFERENCE_TYPES.PLANE) {
      return tracePlanes.has(referenceId);
    }
    return false;
  }

  function getTracePlane(id) {
    return tracePlanes.get(id) ?? null;
  }

  function createTracePlane({
    id = createId("plane"),
    origin,
    normal,
    xAxis,
    yAxis,
    width,
    height,
    visible = true,
    locked = false,
  }) {
    if (surfaceReferences.has(id) || tracePlanes.has(id)) {
      throw new Error(`Spatial reference already exists: ${id}`);
    }

    const plane = {
      id,
      origin: vector3(origin, "origin"),
      normal: unitVector3(normal, "normal"),
      xAxis: unitVector3(xAxis, "xAxis"),
      yAxis: unitVector3(yAxis, "yAxis"),
      width: finiteNumber(width, "width"),
      height: finiteNumber(height, "height"),
      visible: Boolean(visible),
      locked: Boolean(locked),
    };
    if (plane.width <= 0 || plane.height <= 0) {
      throw new RangeError("Trace Plane width and height must be greater than zero.");
    }
    validatePlaneBasis(plane);

    tracePlanes.set(id, plane);
    onReferenceChange(REFERENCE_TYPES.PLANE, id);
    return plane;
  }

  function updateTracePlane(id, changes) {
    const current = getTracePlane(id);
    if (!current) throw new Error(`Unknown Trace Plane: ${id}`);
    const next = {
      ...current,
      ...(changes.origin ? { origin: vector3(changes.origin, "origin") } : {}),
      ...(changes.normal ? { normal: unitVector3(changes.normal, "normal") } : {}),
      ...(changes.xAxis ? { xAxis: unitVector3(changes.xAxis, "xAxis") } : {}),
      ...(changes.yAxis ? { yAxis: unitVector3(changes.yAxis, "yAxis") } : {}),
      ...(changes.width === undefined ? {} : { width: finiteNumber(changes.width, "width") }),
      ...(changes.height === undefined ? {} : { height: finiteNumber(changes.height, "height") }),
      ...(changes.visible === undefined ? {} : { visible: Boolean(changes.visible) }),
      ...(changes.locked === undefined ? {} : { locked: Boolean(changes.locked) }),
    };
    if (next.width <= 0 || next.height <= 0) {
      throw new RangeError("Trace Plane width and height must be greater than zero.");
    }
    validatePlaneBasis(next);
    tracePlanes.set(id, next);
    onReferenceChange(REFERENCE_TYPES.PLANE, id);
    return next;
  }

  return Object.freeze({
    createTracePlane,
    getTracePlane,
    hasReference,
    listTracePlanes: () => [...tracePlanes.values()],
    updateTracePlane,
  });
}

export function createStrokeRecord({ referenceType, referenceId, references }) {
  if (!references.hasReference(referenceType, referenceId)) {
    throw new Error(`Stroke requires a valid spatial reference: ${referenceType}/${referenceId}`);
  }
  const plane = referenceType === REFERENCE_TYPES.PLANE
    ? references.getTracePlane(referenceId)
    : null;
  if (plane?.locked) throw new Error(`Trace Plane is locked: ${referenceId}`);

  return {
    id: createId("stroke"),
    referenceType,
    referenceId,
    points: [],
    createdAt: new Date().toISOString(),
  };
}

export function isStrokeReferenceVisible(stroke, references) {
  if (stroke.referenceType === REFERENCE_TYPES.SURFACE) return true;
  return references.getTracePlane(stroke.referenceId)?.visible === true;
}

export function resolveStrokePoint(
  stroke,
  point,
  references,
  { surfaceOffset = 0, planeOffset = 0 } = {},
) {
  if (!references.hasReference(stroke.referenceType, stroke.referenceId)) {
    throw new Error(`Stroke reference is unavailable: ${stroke.referenceId}`);
  }

  if (stroke.referenceType === REFERENCE_TYPES.SURFACE) {
    const position = vector3(point.position, "point.position");
    const normal = unitVector3(point.normal, "point.normal");
    return {
      x: position.x + normal.x * surfaceOffset,
      y: position.y + normal.y * surfaceOffset,
      z: position.z + normal.z * surfaceOffset,
    };
  }

  // Trace Plane points are stored as plane-local (u, v) coordinates, then
  // resolved into the same model-local coordinate space used by surface hits.
  const plane = references.getTracePlane(stroke.referenceId);
  const u = finiteNumber(point.u, "point.u");
  const v = finiteNumber(point.v, "point.v");
  return {
    x: plane.origin.x + plane.xAxis.x * u + plane.yAxis.x * v + plane.normal.x * planeOffset,
    y: plane.origin.y + plane.xAxis.y * u + plane.yAxis.y * v + plane.normal.y * planeOffset,
    z: plane.origin.z + plane.xAxis.z * u + plane.yAxis.z * v + plane.normal.z * planeOffset,
  };
}
