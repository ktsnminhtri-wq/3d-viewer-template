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
  let meshInstances = 0;
  for (const nodeIndex of reachableNodes) {
    const node = nodes[nodeIndex];
    const meshIndex = node?.mesh;
    if (meshIndex !== undefined) {
      usedMeshes.add(meshIndex);
      meshInstances += nodeInstanceCount(node, accessors);
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
  for (const nodeIndex of reachableNodes) {
    const node = nodes[nodeIndex];
    const meshIndex = node?.mesh;
    if (meshIndex === undefined) continue;
    sceneTriangles += (meshTriangleCounts.get(meshIndex) ?? 0) * nodeInstanceCount(node, accessors);
    for (const primitive of meshes[meshIndex]?.primitives ?? []) {
      const positionIndex = primitive.attributes?.POSITION;
      if (positionIndex !== undefined && (accessors[positionIndex]?.count ?? 0) > 0) {
        sceneDrawCalls += 1;
      }
    }
  }

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
    primitives: primitiveCount,
    renderablePrimitives,
    sceneDrawCalls,
    materials: materials.length,
    functionallyUniqueMaterials: functionalMaterialCount,
    duplicateMaterials: materials.length - functionalMaterialCount,
    materialCoreSignatures,
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
    averageTrianglesPerPrimitive: primitiveCount ? storedTriangles / primitiveCount : 0,
    invalidNumericValues,
    bounds,
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
