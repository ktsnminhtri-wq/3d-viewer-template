import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { getBounds, uninstance } from "@gltf-transform/functions";
import sharp from "sharp";

export const MIB = 1024 * 1024;
export const GITHUB_FILE_LIMIT = 100 * MIB;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => key !== "name" && key !== "extras")
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function functionalMaterialKey(material) {
  return JSON.stringify(stableValue(material));
}

function accessorContentKey(accessor, definition = {}) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    componentType: definition.componentType ?? null,
    normalized: definition.normalized ?? false,
    type: definition.type ?? null,
    count: definition.count ?? 0,
  }));
  const array = accessor?.getArray?.();
  if (array) hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  return hash.digest("hex");
}

function primitiveContentKey(primitive, accessorKeys, materialKeys, includeMaterial) {
  const attributes = Object.entries(primitive.attributes ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([semantic, accessorIndex]) => [semantic, accessorKeys[accessorIndex] ?? null]);
  const targets = (primitive.targets ?? []).map((target) => Object.entries(target)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([semantic, accessorIndex]) => [semantic, accessorKeys[accessorIndex] ?? null]));
  return {
    mode: primitive.mode ?? 4,
    indices: primitive.indices === undefined ? null : accessorKeys[primitive.indices] ?? null,
    attributes,
    targets,
    material: includeMaterial && primitive.material !== undefined
      ? materialKeys[primitive.material] ?? null
      : null,
  };
}

function meshContentKey(mesh, accessorKeys, materialKeys, includeMaterial) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify((mesh.primitives ?? []).map(
    (primitive) => primitiveContentKey(primitive, accessorKeys, materialKeys, includeMaterial),
  )));
  return hash.digest("hex");
}

function summarizeRepeatedGroups(groups, { limit = 10 } = {}) {
  return [...groups.values()]
    .filter((group) => group.instances > 1)
    .map((group) => ({
      ...group,
      estimatedDrawCallSavings: Math.max(0, group.sceneNodes - 1) * group.primitives,
    }))
    .sort((a, b) => b.estimatedDrawCallSavings - a.estimatedDrawCallSavings
      || b.instances - a.instances
      || a.signature.localeCompare(b.signature))
    .slice(0, limit)
    .map((group) => ({
      signature: group.signature.slice(0, 16),
      meshes: group.meshes.size,
      instances: group.instances,
      sceneNodes: group.sceneNodes,
      primitivesPerInstance: group.primitives,
      estimatedDrawCallSavings: group.estimatedDrawCallSavings,
    }));
}

function materialCoreValue(material = {}) {
  const pbr = material.pbrMetallicRoughness ?? {};
  return {
    alphaCutoff: material.alphaCutoff ?? 0.5,
    alphaMode: material.alphaMode ?? "OPAQUE",
    baseColorFactor: pbr.baseColorFactor ?? [1, 1, 1, 1],
    doubleSided: material.doubleSided ?? false,
    emissiveFactor: material.emissiveFactor ?? [0, 0, 0],
    metallicFactor: pbr.metallicFactor ?? 1,
    roughnessFactor: pbr.roughnessFactor ?? 1,
  };
}

function primitiveTriangles(primitive, accessors) {
  const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
  const count = accessorIndex === undefined ? 0 : accessors[accessorIndex]?.count ?? 0;
  const mode = primitive.mode ?? 4;
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function collectAccessorReferences(primitive, target) {
  if (primitive.indices !== undefined) target.add(primitive.indices);
  for (const index of Object.values(primitive.attributes ?? {})) target.add(index);
  for (const morphTarget of primitive.targets ?? []) {
    for (const index of Object.values(morphTarget)) target.add(index);
  }
}

function nodeInstanceCount(node, accessors) {
  const attributes = node?.extensions?.EXT_mesh_gpu_instancing?.attributes;
  if (!attributes) return 1;
  const counts = Object.values(attributes)
    .map((accessorIndex) => accessors[accessorIndex]?.count ?? 0)
    .filter((count) => count > 0);
  return counts.length ? Math.min(...counts) : 1;
}

function collectTextureReferences(value, target, parentKey = "") {
  if (!value || typeof value !== "object") return;
  if (parentKey.endsWith("Texture") && Number.isInteger(value.index)) target.add(value.index);
  for (const [key, child] of Object.entries(value)) collectTextureReferences(child, target, key);
}

function textureUsageSignature(material = {}) {
  const usages = [];
  function visit(value, path = "") {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (key.endsWith("Texture") && child && Number.isInteger(child.index)) {
        usages.push({
          path: childPath,
          texCoord: child.texCoord ?? 0,
          transform: stableValue(child.extensions?.KHR_texture_transform ?? null),
        });
      }
      visit(child, childPath);
    }
  }
  visit(material);
  return JSON.stringify(usages.sort((a, b) => a.path.localeCompare(b.path)));
}

function textureSource(texture) {
  return texture.extensions?.EXT_texture_webp?.source
    ?? texture.extensions?.KHR_texture_basisu?.source
    ?? texture.source;
}

function formatBytes(bytes) {
  return `${(bytes / MIB).toFixed(2)} MiB`;
}

function parseGLB(bytes, filePath) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) {
    throw new Error(`${filePath} is not a valid GLB file.`);
  }
  if (bytes.readUInt32LE(4) !== 2) throw new Error(`${filePath} is not glTF 2.0.`);
  if (bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error(`${filePath} has an invalid declared byte length.`);
  }

  let offset = 12;
  let jsonChunk;
  let jsonBytes = 0;
  let binaryOffset = 0;
  let binaryBytes = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error(`${filePath} has a truncated GLB chunk header.`);
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    if (dataEnd > bytes.length) throw new Error(`${filePath} has a truncated GLB chunk.`);
    if (type === 0x4e4f534a) {
      jsonBytes = length;
      jsonChunk = bytes.subarray(dataOffset, dataEnd);
    } else if (type === 0x004e4942) {
      binaryOffset = dataOffset;
      binaryBytes = length;
    }
    offset = dataEnd;
  }
  if (!jsonChunk) throw new Error(`${filePath} does not contain a JSON chunk.`);
  return {
    gltf: JSON.parse(new TextDecoder().decode(jsonChunk).trim()),
    jsonBytes,
    binaryOffset,
    binaryBytes,
  };
}

function finiteVector(vector) {
  return Array.isArray(vector) && vector.length === 3 && vector.every(Number.isFinite);
}

function normalizedNumber(value) {
  if (!Number.isFinite(value)) return value;
  const rounded = Math.round(value * 1e9) / 1e9;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function aggregateBounds(root) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const scene of root.listScenes()) {
    const sceneBounds = getBounds(scene);
    if (!finiteVector(sceneBounds.min) || !finiteVector(sceneBounds.max)) continue;
    found = true;
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], sceneBounds.min[axis]);
      max[axis] = Math.max(max[axis], sceneBounds.max[axis]);
    }
  }
  if (!found) {
    return {
      valid: false,
      min: null,
      max: null,
      size: null,
      center: null,
      diagonal: null,
      distanceFromOrigin: null,
    };
  }
  const size = max.map((value, axis) => value - min[axis]);
  const center = max.map((value, axis) => (value + min[axis]) / 2);
  const normalized = (values) => values.map(normalizedNumber);
  return {
    valid: finiteVector(min) && finiteVector(max) && size.every(Number.isFinite),
    min: normalized(min),
    max: normalized(max),
    size: normalized(size),
    center: normalized(center),
    diagonal: normalizedNumber(Math.hypot(...size)),
    distanceFromOrigin: normalizedNumber(Math.hypot(...center)),
  };
}

function triangleWeightedCameraTarget(root) {
  const weighted = [0, 0, 0];
  let totalWeight = 0;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const localMin = [Infinity, Infinity, Infinity];
    const localMax = [-Infinity, -Infinity, -Infinity];
    let foundPosition = false;
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      if (!position || position.getElementSize() < 3) continue;
      const primitiveMin = position.getMinNormalized([]);
      const primitiveMax = position.getMaxNormalized([]);
      if (!finiteVector(primitiveMin) || !finiteVector(primitiveMax)) continue;
      foundPosition = true;
      for (let axis = 0; axis < 3; axis += 1) {
        localMin[axis] = Math.min(localMin[axis], primitiveMin[axis]);
        localMax[axis] = Math.max(localMax[axis], primitiveMax[axis]);
      }
    }
    if (!foundPosition) continue;
    const localCenter = localMin.map((value, axis) => (value + localMax[axis]) / 2);
    const matrix = node.getWorldMatrix();
    const worldCenter = [
      matrix[0] * localCenter[0] + matrix[4] * localCenter[1] + matrix[8] * localCenter[2] + matrix[12],
      matrix[1] * localCenter[0] + matrix[5] * localCenter[1] + matrix[9] * localCenter[2] + matrix[13],
      matrix[2] * localCenter[0] + matrix[6] * localCenter[1] + matrix[10] * localCenter[2] + matrix[14],
    ];
    if (!worldCenter.every(Number.isFinite)) continue;
    const weight = Math.max(1, mesh.listPrimitives().reduce((sum, primitive) => {
      const accessor = primitive.getIndices() ?? primitive.getAttribute("POSITION");
      const count = accessor?.getCount() ?? 0;
      const mode = primitive.getMode();
      if (mode === 4) return sum + Math.floor(count / 3);
      if (mode === 5 || mode === 6) return sum + Math.max(0, count - 2);
      return sum;
    }, 0));
    for (let axis = 0; axis < 3; axis += 1) weighted[axis] += worldCenter[axis] * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weighted.map((value) => normalizedNumber(value / totalWeight)) : null;
}

function countInvalidNumericValues(root) {
  let count = 0;
  for (const accessor of root.listAccessors()) {
    const array = accessor.getArray();
    if (!array) continue;
    for (let index = 0; index < array.length; index += 1) {
      if (!Number.isFinite(array[index])) count += 1;
    }
  }
  return count;
}

export async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function analyzeGLB(filePath) {
  const bytes = await readFile(filePath);
  const { gltf, jsonBytes, binaryOffset, binaryBytes } = parseGLB(bytes, filePath);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(filePath);
  const root = document.getRoot();
  const nodes = gltf.nodes ?? [];
  const meshes = gltf.meshes ?? [];
  const materials = gltf.materials ?? [];
  const accessors = gltf.accessors ?? [];
  const bufferViews = gltf.bufferViews ?? [];
  const textures = gltf.textures ?? [];
  const images = gltf.images ?? [];
  const decodedAccessors = root.listAccessors();
  const accessorKeys = accessors.map(
    (definition, index) => accessorContentKey(decodedAccessors[index], definition),
  );
  const materialKeys = materials.map(functionalMaterialKey);
  const meshGeometryKeys = meshes.map(
    (mesh) => meshContentKey(mesh, accessorKeys, materialKeys, false),
  );
  const meshGeometryMaterialKeys = meshes.map(
    (mesh) => meshContentKey(mesh, accessorKeys, materialKeys, true),
  );
  const meshMaterialKeys = meshes.map((mesh) => createHash("sha256")
    .update(JSON.stringify((mesh.primitives ?? []).map(
      (primitive) => primitive.material === undefined
        ? null
        : materialKeys[primitive.material] ?? null,
    )))
    .digest("hex"));

  const reachableNodes = new Set();
  const visitNode = (index) => {
    if (reachableNodes.has(index) || !nodes[index]) return;
    reachableNodes.add(index);
    for (const child of nodes[index].children ?? []) visitNode(child);
  };
  for (const scene of gltf.scenes ?? []) {
    for (const nodeIndex of scene.nodes ?? []) visitNode(nodeIndex);
  }

  const usedMeshes = new Set();
  const instanceAccessorIndices = new Set();
  const meshSceneNodeCounts = new Map();
  const meshSceneInstanceCounts = new Map();
  let meshInstances = 0;
  let instancedBatchCount = 0;
  let instancedInstanceCount = 0;
  for (const nodeIndex of reachableNodes) {
    const node = nodes[nodeIndex];
    const meshIndex = node?.mesh;
    if (meshIndex !== undefined) {
      usedMeshes.add(meshIndex);
      const instanceCount = nodeInstanceCount(node, accessors);
      meshInstances += instanceCount;
      meshSceneNodeCounts.set(meshIndex, (meshSceneNodeCounts.get(meshIndex) ?? 0) + 1);
      meshSceneInstanceCounts.set(
        meshIndex,
        (meshSceneInstanceCounts.get(meshIndex) ?? 0) + instanceCount,
      );
      if (node.extensions?.EXT_mesh_gpu_instancing) {
        instancedBatchCount += 1;
        instancedInstanceCount += instanceCount;
      }
      for (const accessorIndex of Object.values(
        node.extensions?.EXT_mesh_gpu_instancing?.attributes ?? {},
      )) instanceAccessorIndices.add(accessorIndex);
    }
  }

  const meshRows = [];
  const meshTriangleCounts = new Map();
  let primitiveCount = 0;
  let storedTriangles = 0;
  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) {
    const mesh = meshes[meshIndex];
    const accessorSet = new Set();
    let triangles = 0;
    for (const primitive of mesh.primitives ?? []) {
      primitiveCount += 1;
      triangles += primitiveTriangles(primitive, accessors);
      collectAccessorReferences(primitive, accessorSet);
    }
    storedTriangles += triangles;
    meshTriangleCounts.set(meshIndex, triangles);
    const viewSet = new Set();
    for (const accessorIndex of accessorSet) {
      const accessor = accessors[accessorIndex];
      if (accessor?.bufferView !== undefined) viewSet.add(accessor.bufferView);
      if (accessor?.sparse?.indices?.bufferView !== undefined) viewSet.add(accessor.sparse.indices.bufferView);
      if (accessor?.sparse?.values?.bufferView !== undefined) viewSet.add(accessor.sparse.values.bufferView);
    }
    const geometryBytes = [...viewSet].reduce(
      (sum, viewIndex) => sum + (bufferViews[viewIndex]?.byteLength ?? 0),
      0,
    );
    meshRows.push({
      meshIndex,
      name: mesh.name || `Mesh ${meshIndex}`,
      geometryBytes,
      triangles,
      primitives: mesh.primitives?.length ?? 0,
    });
  }

  let sceneTriangles = 0;
  let sceneDrawCalls = 0;
  let sceneDrawCallsWithoutInstancing = 0;
  const sceneAttributeCounts = {};
  for (const nodeIndex of reachableNodes) {
    const node = nodes[nodeIndex];
    const meshIndex = node?.mesh;
    if (meshIndex === undefined) continue;
    const instanceCount = nodeInstanceCount(node, accessors);
    sceneTriangles += (meshTriangleCounts.get(meshIndex) ?? 0) * instanceCount;
    for (const primitive of meshes[meshIndex]?.primitives ?? []) {
      const positionIndex = primitive.attributes?.POSITION;
      if (positionIndex !== undefined && (accessors[positionIndex]?.count ?? 0) > 0) {
        sceneDrawCalls += 1;
        sceneDrawCallsWithoutInstancing += nodeInstanceCount(node, accessors);
      }
      for (const [semantic, accessorIndex] of Object.entries(primitive.attributes ?? {})) {
        sceneAttributeCounts[semantic] = (sceneAttributeCounts[semantic] ?? 0)
          + (accessors[accessorIndex]?.count ?? 0) * instanceCount;
      }
    }
  }

  const repeatedGeometryGroups = new Map();
  const repeatedGeometryMaterialGroups = new Map();
  const repeatedMaterialCombinationGroups = new Map();
  for (const meshIndex of usedMeshes) {
    const mesh = meshes[meshIndex];
    const primitives = mesh?.primitives?.length ?? 0;
    const sceneNodes = meshSceneNodeCounts.get(meshIndex) ?? 0;
    const instances = meshSceneInstanceCounts.get(meshIndex) ?? 0;
    for (const [groups, signature] of [
      [repeatedGeometryGroups, meshGeometryKeys[meshIndex]],
      [repeatedGeometryMaterialGroups, meshGeometryMaterialKeys[meshIndex]],
      [repeatedMaterialCombinationGroups, meshMaterialKeys[meshIndex]],
    ]) {
      if (!signature) continue;
      const group = groups.get(signature) ?? {
        signature,
        meshes: new Set(),
        instances: 0,
        sceneNodes: 0,
        primitives,
      };
      group.meshes.add(meshIndex);
      group.instances += instances;
      group.sceneNodes += sceneNodes;
      groups.set(signature, group);
    }
  }
  const instancingCandidates = [...repeatedGeometryMaterialGroups.values()]
    .filter((group) => group.sceneNodes > 1);
  const estimatedInstancingSavings = instancingCandidates.reduce(
    (sum, group) => sum + Math.max(0, group.sceneNodes - 1) * group.primitives,
    0,
  );

  let renderablePrimitives = 0;
  for (const meshIndex of usedMeshes) {
    for (const primitive of meshes[meshIndex]?.primitives ?? []) {
      const positionIndex = primitive.attributes?.POSITION;
      if (positionIndex !== undefined && (accessors[positionIndex]?.count ?? 0) > 0) {
        renderablePrimitives += 1;
      }
    }
  }

  const usedMaterials = new Set();
  const usedAccessors = new Set(instanceAccessorIndices);
  for (const meshIndex of usedMeshes) {
    for (const primitive of meshes[meshIndex]?.primitives ?? []) {
      if (primitive.material !== undefined) usedMaterials.add(primitive.material);
      collectAccessorReferences(primitive, usedAccessors);
    }
  }
  for (const animation of gltf.animations ?? []) {
    for (const sampler of animation.samplers ?? []) {
      if (sampler.input !== undefined) usedAccessors.add(sampler.input);
      if (sampler.output !== undefined) usedAccessors.add(sampler.output);
    }
  }
  for (const skin of gltf.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined) usedAccessors.add(skin.inverseBindMatrices);
  }

  const usedTextures = new Set();
  for (const materialIndex of usedMaterials) collectTextureReferences(materials[materialIndex], usedTextures);
  const usedImages = new Set();
  for (const textureIndex of usedTextures) {
    const source = textureSource(textures[textureIndex] ?? {});
    if (source !== undefined) usedImages.add(source);
  }

  const imageRows = [];
  for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
    const image = images[imageIndex];
    let imageBytes;
    if (image.bufferView !== undefined && binaryOffset) {
      const view = bufferViews[image.bufferView];
      const start = binaryOffset + (view?.byteOffset ?? 0);
      imageBytes = bytes.subarray(start, start + (view?.byteLength ?? 0));
    } else if (image.uri?.startsWith("data:")) {
      imageBytes = Buffer.from(image.uri.split(",")[1] ?? "", "base64");
    }

    let width = null;
    let height = null;
    let hasTransparency = false;
    if (imageBytes?.length) {
      try {
        const metadata = await sharp(imageBytes).metadata();
        width = metadata.width ?? null;
        height = metadata.height ?? null;
        if (metadata.hasAlpha) {
          const stats = await sharp(imageBytes).stats();
          hasTransparency = Boolean(stats.channels[3] && stats.channels[3].min < 255);
        }
      } catch {
        // Unsupported image formats remain valid glTF resources.
      }
    }
    imageRows.push({
      imageIndex,
      name: image.name || image.uri || `Image ${imageIndex}`,
      hasStableIdentity: Boolean(image.name || (image.uri && !image.uri.startsWith("data:"))),
      mimeType: image.mimeType ?? null,
      bytes: imageBytes?.length ?? 0,
      width,
      height,
      hasTransparency,
      oversized: false,
      hash: imageBytes?.length ? createHash("sha256").update(imageBytes).digest("hex") : null,
    });
  }

  const decodedTextures = root.listTextures();
  for (let textureIndex = 0; textureIndex < decodedTextures.length; textureIndex += 1) {
    const imageIndex = textureSource(textures[textureIndex] ?? {});
    const row = imageRows[imageIndex];
    if (!row) continue;
    const imageBytes = decodedTextures[textureIndex].getImage();
    row.mimeType ||= decodedTextures[textureIndex].getMimeType() || null;
    if (!imageBytes || (row.width && row.height)) continue;
    try {
      const metadata = await sharp(imageBytes).metadata();
      row.bytes = imageBytes.byteLength;
      row.width = metadata.width ?? null;
      row.height = metadata.height ?? null;
      if (metadata.hasAlpha) {
        const stats = await sharp(imageBytes).stats();
        row.hasTransparency = Boolean(stats.channels[3] && stats.channels[3].min < 255);
      }
      row.hash = createHash("sha256").update(imageBytes).digest("hex");
    } catch {
      // Keep unknown dimensions for codecs unsupported by Sharp.
    }
  }
  for (const row of imageRows) row.oversized = Math.max(row.width ?? 0, row.height ?? 0) > 2048;

  const functionalMaterialCount = new Set(materials.map(functionalMaterialKey)).size;
  const materialCoreSignatures = [...new Set(
    [...usedMaterials].map((materialIndex) => JSON.stringify(materialCoreValue(materials[materialIndex]))),
  )].sort();
  const textureUsageSignatures = [...new Set(
    [...usedMaterials].map((materialIndex) => textureUsageSignature(materials[materialIndex])),
  )].sort();
  const textureBytes = imageRows.reduce((sum, image) => sum + image.bytes, 0);
  const estimatedTextureGPUBytes = imageRows.reduce((sum, image) => {
    if (!image.width || !image.height) return sum;
    // Browser-decoded color textures generally occupy RGBA8, plus ~1/3 for mip levels.
    return sum + Math.ceil(image.width * image.height * 4 * 4 / 3);
  }, 0);
  const alphaModeCounts = { OPAQUE: 0, MASK: 0, BLEND: 0 };
  for (const materialIndex of usedMaterials) {
    const mode = materials[materialIndex]?.alphaMode ?? "OPAQUE";
    alphaModeCounts[mode] = (alphaModeCounts[mode] ?? 0) + 1;
  }
  const unused = {
    nodes: nodes.length - reachableNodes.size,
    meshes: meshes.length - usedMeshes.size,
    materials: materials.length - usedMaterials.size,
    accessors: accessors.length - usedAccessors.size,
    textures: textures.length - usedTextures.size,
    images: images.length - usedImages.size,
  };
  const imageHashes = imageRows.map((image) => image.hash).filter(Boolean);
  const invalidNumericValues = countInvalidNumericValues(root);
  if ((gltf.extensionsUsed ?? []).includes("EXT_mesh_gpu_instancing")) {
    // Core getBounds() does not expand EXT_mesh_gpu_instancing transforms.
    // Expand them only in this in-memory analysis document; the GLB is untouched.
    await document.transform(uninstance());
  }
  const bounds = aggregateBounds(root);
  const cameraTarget = triangleWeightedCameraTarget(root) ?? bounds.center;
  const externalResourceURIs = [
    ...(gltf.buffers ?? []).map((buffer) => buffer.uri),
    ...images.map((image) => image.uri),
  ].filter((uri) => uri && !uri.startsWith("data:"));

  return {
    path: filePath,
    gltfVersion: String(gltf.asset?.version ?? ""),
    totalBytes: bytes.length,
    jsonBytes,
    binaryBytes,
    scenes: gltf.scenes?.length ?? 0,
    nodes: nodes.length,
    meshes: meshes.length,
    meshInstances,
    instancedBatchCount,
    instancedInstanceCount,
    primitives: primitiveCount,
    renderablePrimitives,
    sceneDrawCalls,
    sceneDrawCallsWithoutInstancing,
    estimatedDrawCallsAfterInstancing: Math.max(0, sceneDrawCalls - estimatedInstancingSavings),
    repeatedGeometryGroups: [...repeatedGeometryGroups.values()]
      .filter((group) => group.instances > 1).length,
    repeatedGeometryMaterialGroups: [...repeatedGeometryMaterialGroups.values()]
      .filter((group) => group.instances > 1).length,
    repeatedMaterialCombinationGroups: [...repeatedMaterialCombinationGroups.values()]
      .filter((group) => group.meshes.size > 1).length,
    repeatedGeometryInstances: [...repeatedGeometryMaterialGroups.values()]
      .filter((group) => group.instances > 1)
      .reduce((sum, group) => sum + group.instances, 0),
    estimatedInstancingSavings,
    largestRepeatedGeometryGroups: summarizeRepeatedGroups(repeatedGeometryMaterialGroups),
    materials: materials.length,
    functionallyUniqueMaterials: functionalMaterialCount,
    duplicateMaterials: materials.length - functionalMaterialCount,
    materialCoreSignatures,
    textureUsageSignatures,
    accessors: accessors.length,
    animations: gltf.animations?.length ?? 0,
    textures: textures.length,
    images: images.length,
    textureBytes,
    estimatedTextureGPUBytes,
    textureFormats: [...new Set(imageRows.map((image) => image.mimeType).filter(Boolean))].sort(),
    maxTextureWidth: Math.max(0, ...imageRows.map((image) => image.width ?? 0)),
    maxTextureHeight: Math.max(0, ...imageRows.map((image) => image.height ?? 0)),
    transparentTextureCount: imageRows.filter((image) => image.hasTransparency).length,
    alphaModeCounts,
    storedTriangles,
    sceneTriangles,
    sceneAttributeCounts: Object.fromEntries(
      Object.entries(sceneAttributeCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    averageTrianglesPerPrimitive: primitiveCount ? storedTriangles / primitiveCount : 0,
    invalidNumericValues,
    bounds,
    cameraTarget,
    unused,
    oversizedTextureCount: imageRows.filter((image) => image.oversized).length,
    duplicateImageCount: imageHashes.length - new Set(imageHashes).size,
    textureDetails: [...imageRows].sort((a, b) => a.imageIndex - b.imageIndex),
    largestMeshes: meshRows.sort((a, b) => b.geometryBytes - a.geometryBytes).slice(0, 20),
    largestTextures: imageRows.sort((a, b) => b.bytes - a.bytes).slice(0, 20),
    extensionsUsed: [...(gltf.extensionsUsed ?? [])].sort(),
    extensionsRequired: [...(gltf.extensionsRequired ?? [])].sort(),
    externalResourceURIs: [...new Set(externalResourceURIs)].sort(),
  };
}

export function optimizationReasons(analysis) {
  const reasons = [];
  if (analysis.jsonBytes > Math.max(5 * MIB, analysis.totalBytes * 0.15)) {
    reasons.push(`JSON metadata is ${formatBytes(analysis.jsonBytes)}`);
  }
  if (
    analysis.duplicateMaterials > 50
    || analysis.materials > Math.max(256, analysis.functionallyUniqueMaterials * 2)
  ) {
    reasons.push(`${analysis.duplicateMaterials.toLocaleString()} functionally duplicated materials`);
  }
  if (analysis.primitives > 2_000 && analysis.averageTrianglesPerPrimitive < 20) {
    reasons.push(
      `${analysis.primitives.toLocaleString()} fragmented primitives (${analysis.averageTrianglesPerPrimitive.toFixed(1)} triangles each)`,
    );
  }
  if (analysis.oversizedTextureCount) reasons.push(`${analysis.oversizedTextureCount} textures exceed 2048 px`);
  if (analysis.duplicateImageCount) reasons.push(`${analysis.duplicateImageCount} duplicated embedded images`);
  const unusedTotal = Object.values(analysis.unused).reduce((sum, count) => sum + count, 0);
  if (unusedTotal) reasons.push(`${unusedTotal} unused scene resources`);
  if (analysis.textureBytes > 20 * MIB) reasons.push(`embedded textures use ${formatBytes(analysis.textureBytes)}`);
  return reasons;
}

export function printableSummary(analysis) {
  return {
    size: formatBytes(analysis.totalBytes),
    json: formatBytes(analysis.jsonBytes),
    primitives: analysis.primitives,
    materials: analysis.materials,
    functionalMaterials: analysis.functionallyUniqueMaterials,
    renderedTriangles: analysis.sceneTriangles,
    textures: formatBytes(analysis.textureBytes),
    oversizedTextures: analysis.oversizedTextureCount,
    bounds: analysis.bounds,
    unused: analysis.unused,
  };
}
