import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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

function collectTextureReferences(value, target, parentKey = "") {
  if (!value || typeof value !== "object") return;
  if (
    parentKey.endsWith("Texture")
    && Number.isInteger(value.index)
  ) {
    target.add(value.index);
  }
  for (const [key, child] of Object.entries(value)) {
    collectTextureReferences(child, target, key);
  }
}

function textureSource(texture) {
  return texture.extensions?.EXT_texture_webp?.source
    ?? texture.extensions?.KHR_texture_basisu?.source
    ?? texture.source;
}

function formatBytes(bytes) {
  return `${(bytes / MIB).toFixed(2)} MiB`;
}

export async function analyzeGLB(filePath) {
  const bytes = await readFile(filePath);
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) {
    throw new Error(`${filePath} is not a valid GLB file.`);
  }
  if (bytes.readUInt32LE(4) !== 2) {
    throw new Error(`${filePath} is not glTF 2.0.`);
  }
  if (bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error(`${filePath} has an invalid declared byte length.`);
  }

  let offset = 12;
  let jsonChunk;
  let jsonBytes = 0;
  let binaryOffset = 0;
  let binaryBytes = 0;
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (type === 0x4e4f534a) {
      jsonBytes = length;
      jsonChunk = bytes.subarray(dataOffset, dataOffset + length);
    } else if (type === 0x004e4942) {
      binaryOffset = dataOffset;
      binaryBytes = length;
    }
    offset = dataOffset + length;
  }
  if (!jsonChunk) throw new Error(`${filePath} does not contain a JSON chunk.`);

  const gltf = JSON.parse(new TextDecoder().decode(jsonChunk).trim());
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
  for (const nodeIndex of reachableNodes) {
    const meshIndex = nodes[nodeIndex]?.mesh;
    if (meshIndex !== undefined) usedMeshes.add(meshIndex);
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
      if (accessor?.sparse?.indices?.bufferView !== undefined) {
        viewSet.add(accessor.sparse.indices.bufferView);
      }
      if (accessor?.sparse?.values?.bufferView !== undefined) {
        viewSet.add(accessor.sparse.values.bufferView);
      }
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
  for (const nodeIndex of reachableNodes) {
    const meshIndex = nodes[nodeIndex]?.mesh;
    if (meshIndex !== undefined) sceneTriangles += meshTriangleCounts.get(meshIndex) ?? 0;
  }

  const usedMaterials = new Set();
  const usedAccessors = new Set();
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
  for (const materialIndex of usedMaterials) {
    collectTextureReferences(materials[materialIndex], usedTextures);
  }
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
        // Unsupported image formats remain valid glTF resources; size is still reported.
      }
    }
    imageRows.push({
      imageIndex,
      name: image.name || image.uri || `Image ${imageIndex}`,
      mimeType: image.mimeType ?? null,
      bytes: imageBytes?.length ?? 0,
      width,
      height,
      hasTransparency,
      oversized: Math.max(width ?? 0, height ?? 0) > 2048,
      hash: imageBytes?.length
        ? createHash("sha256").update(imageBytes).digest("hex")
        : null,
    });
  }

  const functionalMaterialCount = new Set(
    materials.map(functionalMaterialKey),
  ).size;
  const textureBytes = imageRows.reduce((sum, image) => sum + image.bytes, 0);
  const unused = {
    nodes: nodes.length - reachableNodes.size,
    meshes: meshes.length - usedMeshes.size,
    materials: materials.length - usedMaterials.size,
    accessors: accessors.length - usedAccessors.size,
    textures: textures.length - usedTextures.size,
    images: images.length - usedImages.size,
  };

  const imageHashes = imageRows.map((image) => image.hash).filter(Boolean);

  return {
    path: filePath,
    totalBytes: bytes.length,
    jsonBytes,
    binaryBytes,
    nodes: nodes.length,
    meshes: meshes.length,
    primitives: primitiveCount,
    materials: materials.length,
    functionallyUniqueMaterials: functionalMaterialCount,
    duplicateMaterials: materials.length - functionalMaterialCount,
    accessors: accessors.length,
    textures: textures.length,
    images: images.length,
    textureBytes,
    storedTriangles,
    sceneTriangles,
    averageTrianglesPerPrimitive: primitiveCount
      ? storedTriangles / primitiveCount
      : 0,
    unused,
    oversizedTextureCount: imageRows.filter((image) => image.oversized).length,
    duplicateImageCount: imageHashes.length - new Set(imageHashes).size,
    largestMeshes: meshRows
      .sort((a, b) => b.geometryBytes - a.geometryBytes)
      .slice(0, 20),
    largestTextures: imageRows
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 20),
    extensionsUsed: gltf.extensionsUsed ?? [],
    extensionsRequired: gltf.extensionsRequired ?? [],
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
    reasons.push(
      `${analysis.duplicateMaterials.toLocaleString()} functionally duplicated materials`,
    );
  }
  if (
    analysis.primitives > 2_000
    && analysis.averageTrianglesPerPrimitive < 20
  ) {
    reasons.push(
      `${analysis.primitives.toLocaleString()} fragmented primitives (${analysis.averageTrianglesPerPrimitive.toFixed(1)} triangles each)`,
    );
  }
  if (analysis.oversizedTextureCount) {
    reasons.push(`${analysis.oversizedTextureCount} textures exceed 2048 px`);
  }
  if (analysis.duplicateImageCount) {
    reasons.push(`${analysis.duplicateImageCount} duplicated embedded images`);
  }
  const unusedTotal = Object.values(analysis.unused).reduce((sum, count) => sum + count, 0);
  if (unusedTotal) reasons.push(`${unusedTotal} unused scene resources`);
  if (analysis.textureBytes > 20 * MIB) {
    reasons.push(`embedded textures use ${formatBytes(analysis.textureBytes)}`);
  }
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
    unused: analysis.unused,
  };
}
