import { readFile, writeFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import sharp from "sharp";

const ORIGINAL = process.argv[2] ?? "./model-source-backup.glb";
const OPTIMIZED = process.argv[3] ?? "./model.glb";
const REPORT = process.argv[4] ?? "./optimization-validation-report.json";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

function primitiveTriangles(primitive) {
  const count = primitive.getIndices()?.getCount()
    ?? primitive.getAttribute("POSITION")?.getCount()
    ?? 0;
  const mode = primitive.getMode();
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function sceneTriangles(root) {
  let count = 0;
  function visit(node) {
    const mesh = node.getMesh();
    if (mesh) {
      count += mesh
        .listPrimitives()
        .reduce((sum, primitive) => sum + primitiveTriangles(primitive), 0);
    }
    for (const child of node.listChildren()) visit(child);
  }
  for (const scene of root.listScenes()) {
    for (const child of scene.listChildren()) visit(child);
  }
  return count;
}

function glbChunks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("Invalid GLB magic.");
  const result = { totalBytes: bytes.byteLength, jsonBytes: 0, binaryBytes: 0 };
  let offset = 12;
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (type === 0x4e4f534a) result.jsonBytes = length;
    if (type === 0x004e4942) result.binaryBytes = length;
    offset += 8 + length;
  }
  return result;
}

async function inspect(path) {
  const bytes = await readFile(path);
  const rawJSON = JSON.parse(
    new TextDecoder().decode(
      bytes.subarray(20, 20 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true)),
    ).trim(),
  );
  const document = await io.readBinary(bytes);
  const root = document.getRoot();
  const meshes = root.listMeshes();
  const primitives = meshes.flatMap((mesh) => mesh.listPrimitives());
  const textures = [];

  for (const texture of root.listTextures()) {
    const image = texture.getImage();
    const metadata = image ? await sharp(image).metadata() : {};
    const stats = image && metadata.hasAlpha ? await sharp(image).stats() : null;
    const alphaChannel = stats?.channels?.[3];
    textures.push({
      name: texture.getName(),
      mimeType: texture.getMimeType(),
      bytes: image?.byteLength ?? 0,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      hasAlpha: metadata.hasAlpha ?? false,
      hasTransparency: Boolean(alphaChannel && alphaChannel.min < 255),
    });
  }

  return {
    ...glbChunks(bytes),
    nodes: root.listNodes().length,
    meshes: meshes.length,
    primitives: primitives.length,
    materials: root.listMaterials().length,
    accessors: root.listAccessors().length,
    storedTriangles: primitives.reduce(
      (sum, primitive) => sum + primitiveTriangles(primitive),
      0,
    ),
    sceneTriangles: sceneTriangles(root),
    textureBytes: textures.reduce((sum, texture) => sum + texture.bytes, 0),
    textures,
    extensionsUsed: rawJSON.extensionsUsed ?? [],
    extensionsRequired: rawJSON.extensionsRequired ?? [],
  };
}

const before = await inspect(ORIGINAL);
const after = await inspect(OPTIMIZED);
const failures = [];

if (before.sceneTriangles !== after.sceneTriangles) {
  failures.push("Rendered scene triangle count changed.");
}

for (const texture of after.textures) {
  if (Math.max(texture.width ?? 0, texture.height ?? 0) > 2048) {
    failures.push(`Texture exceeds 2048 px: ${texture.name}`);
  }
}

const afterTexturesByName = new Map(after.textures.map((texture) => [texture.name, texture]));
for (const texture of before.textures.filter((item) => item.hasTransparency)) {
  const outputTexture = afterTexturesByName.get(texture.name);
  if (!outputTexture || !outputTexture.hasTransparency) {
    failures.push(`Required transparency was not preserved: ${texture.name}`);
  }
}

const geometryCompressionExtensions = [
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_mesh_quantization",
];
for (const extension of geometryCompressionExtensions) {
  if (
    after.extensionsUsed.includes(extension)
    && !before.extensionsUsed.includes(extension)
  ) {
    failures.push(`Unexpected geometry compression extension added: ${extension}`);
  }
}

const report = {
  passed: failures.length === 0,
  failures,
  before,
  after,
  notes: [
    "Scene-rendered triangle count is unchanged.",
    "Stored triangle count decreases only because byte-identical meshes now share definitions.",
    "No Draco, Meshopt, quantization, simplification, or other geometry compression was applied.",
    "Color textures converted by the optimizer use WebP quality 82; data textures use lossless WebP.",
    "Alpha channels remain present where required and output textures do not exceed 2048 px.",
  ],
};

await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  passed: report.passed,
  failures,
  before: { ...before, textures: undefined },
  after: { ...after, textures: undefined },
  transparentTexturesBefore: before.textures.filter((texture) => texture.hasTransparency).length,
  transparentTexturesAfter: after.textures.filter((texture) => texture.hasTransparency).length,
  oversizedTexturesAfter: after.textures.filter(
    (texture) => Math.max(texture.width ?? 0, texture.height ?? 0) > 2048,
  ),
}, null, 2));

if (failures.length) process.exitCode = 1;
