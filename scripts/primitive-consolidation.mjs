import { joinPrimitives } from "@gltf-transform/functions";

function primitiveCompatibilityKey(primitive, materialIndices) {
  const materialIndex = primitive.getMaterial()
    ? materialIndices.get(primitive.getMaterial())
    : -1;
  const indices = primitive.getIndices();
  const attributes = primitive.listSemantics().sort().map((semantic) => {
    const accessor = primitive.getAttribute(semantic);
    return [
      semantic,
      accessor.getElementSize(),
      accessor.getComponentType(),
      accessor.getNormalized(),
    ].join(":");
  }).join("+");
  return [
    materialIndex,
    primitive.getMode(),
    Boolean(indices),
    indices?.getComponentType?.() ?? "none",
    attributes,
  ].join("|");
}

export function consolidateTrianglePrimitives(document) {
  const root = document.getRoot();
  const materialIndices = new Map(root.listMaterials().map((material, index) => [material, index]));
  let inputPrimitives = 0;
  let outputPrimitives = 0;
  let consolidationGroupCount = 0;
  let joinedPrimitiveCount = 0;

  for (const mesh of root.listMeshes()) {
    const groups = new Map();
    for (const primitive of mesh.listPrimitives()) {
      inputPrimitives += 1;
      if (primitive.getMode() !== 4 || primitive.listTargets().length) continue;
      const key = primitiveCompatibilityKey(primitive, materialIndices);
      const group = groups.get(key) ?? [];
      group.push(primitive);
      groups.set(key, group);
    }
    for (const primitives of groups.values()) {
      if (primitives.length < 2) continue;
      const joined = joinPrimitives(primitives);
      for (const primitive of primitives) {
        mesh.removePrimitive(primitive);
        primitive.dispose();
      }
      mesh.addPrimitive(joined);
      consolidationGroupCount += 1;
      joinedPrimitiveCount += primitives.length;
    }
    outputPrimitives += mesh.listPrimitives().length;
  }

  return {
    inputPrimitives,
    outputPrimitives,
    consolidationGroupCount,
    joinedPrimitiveCount,
    mergedPrimitiveCount: inputPrimitives - outputPrimitives,
    // Backward-compatible names used by the experimental benchmark metadata.
    joinedGroups: consolidationGroupCount,
    joinedPrimitives: joinedPrimitiveCount,
  };
}
