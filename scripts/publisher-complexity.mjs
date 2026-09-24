export const COMPLEXITY_CLASSES = Object.freeze({
  SMALL: "SMALL",
  MEDIUM: "MEDIUM",
  LARGE: "LARGE",
  HIGHLY_FRAGMENTED: "HIGHLY_FRAGMENTED",
});

export function complexityMetrics(analysis) {
  const meshInstances = Number(analysis.meshInstances ?? analysis.nodes ?? 0);
  const repeatedInstances = Number(analysis.repeatedGeometryInstances ?? 0);
  return {
    primitiveCount: Number(analysis.primitives ?? 0),
    nodeCount: Number(analysis.nodes ?? 0),
    meshCount: Number(analysis.meshes ?? 0),
    materialCount: Number(analysis.materials ?? 0),
    accessorCount: Number(analysis.accessors ?? 0),
    averageTrianglesPerPrimitive: Number(
      analysis.averageTrianglesPerPrimitive
      ?? ((analysis.storedTriangles ?? 0) / Math.max(1, analysis.primitives ?? 0)),
    ),
    repeatedGeometryRatio: meshInstances > 0 ? repeatedInstances / meshInstances : 0,
  };
}

export function classifyModelComplexity(analysis) {
  const metrics = complexityMetrics(analysis);
  const highlyFragmented = metrics.primitiveCount >= 20_000
    || metrics.materialCount >= 5_000
    || metrics.accessorCount >= 50_000
    || (
      metrics.primitiveCount >= 5_000
      && metrics.averageTrianglesPerPrimitive < 12
    );
  let complexityClass;
  if (highlyFragmented) {
    complexityClass = COMPLEXITY_CLASSES.HIGHLY_FRAGMENTED;
  } else if (
    metrics.primitiveCount <= 1_000
    && metrics.nodeCount <= 5_000
    && metrics.materialCount <= 512
  ) {
    complexityClass = COMPLEXITY_CLASSES.SMALL;
  } else if (
    metrics.primitiveCount <= 5_000
    && metrics.nodeCount <= 25_000
    && metrics.materialCount <= 2_000
  ) {
    complexityClass = COMPLEXITY_CLASSES.MEDIUM;
  } else {
    complexityClass = COMPLEXITY_CLASSES.LARGE;
  }
  return { complexityClass, metrics };
}

export function optimizationPathFor(complexityClass) {
  if (complexityClass === COMPLEXITY_CLASSES.SMALL) return "minimal-safe";
  if (complexityClass === COMPLEXITY_CLASSES.MEDIUM) return "standard-safe";
  if (complexityClass === COMPLEXITY_CLASSES.LARGE) return "consolidated-safe";
  return "consolidated-fast";
}
