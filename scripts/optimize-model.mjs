import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Logger,
  NodeIO,
  PropertyType,
} from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTTextureWebP } from "@gltf-transform/extensions";
import {
  compressTexture,
  dedup,
  flatten,
  getTextureColorSpace,
  instance,
  join,
  prune,
} from "@gltf-transform/functions";
import sharp from "sharp";
import { VIEWER_SAFE_PROFILE } from "./publisher-profile.mjs";

function countPrimitiveTriangles(primitive) {
  const count = primitive.getIndices()?.getCount()
    ?? primitive.getAttribute("POSITION")?.getCount()
    ?? 0;
  const mode = primitive.getMode();
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function collectStats(document) {
  const root = document.getRoot();
  const meshes = root.listMeshes();
  const primitives = meshes.flatMap((mesh) => mesh.listPrimitives());
  let sceneTriangles = 0;

  function visitNode(node) {
    const mesh = node.getMesh();
    if (mesh) {
      const batch = node.getExtension("EXT_mesh_gpu_instancing");
      const instanceCount = batch
        ? Math.min(...batch.listAttributes().map((accessor) => accessor.getCount()))
        : 1;
      sceneTriangles += instanceCount * mesh.listPrimitives().reduce(
        (total, primitive) => total + countPrimitiveTriangles(primitive),
        0,
      );
    }
    for (const child of node.listChildren()) visitNode(child);
  }
  for (const scene of root.listScenes()) {
    for (const child of scene.listChildren()) visitNode(child);
  }

  return {
    scenes: root.listScenes().length,
    nodes: root.listNodes().length,
    meshes: meshes.length,
    primitives: primitives.length,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    accessors: root.listAccessors().length,
    storedTriangles: primitives.reduce(
      (total, primitive) => total + countPrimitiveTriangles(primitive),
      0,
    ),
    sceneTriangles,
    textureBytes: root.listTextures().reduce(
      (total, texture) => total + (texture.getImage()?.byteLength ?? 0),
      0,
    ),
  };
}

function normalizeJoinedNormals(document) {
  const visited = new Set();
  let normalizedVectors = 0;
  let zeroLengthVectors = 0;

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const normal = primitive.getAttribute("NORMAL");
      if (!normal || visited.has(normal)) continue;
      visited.add(normal);
      const array = normal.getArray();
      if (!(array instanceof Float32Array)) continue;

      let modified = false;
      for (let index = 0; index < array.length; index += 3) {
        const x = array[index];
        const y = array[index + 1];
        const z = array[index + 2];
        const length = Math.hypot(x, y, z);
        if (!Number.isFinite(length) || length <= 1e-12) {
          zeroLengthVectors += 1;
          continue;
        }
        if (Math.abs(length - 1) <= 1e-6) continue;
        array[index] = x / length;
        array[index + 1] = y / length;
        array[index + 2] = z / length;
        normalizedVectors += 1;
        modified = true;
      }
      if (modified) normal.setArray(array);
    }
  }

  if (zeroLengthVectors > 0) {
    throw new Error(`Join produced ${zeroLengthVectors} zero-length normal vectors.`);
  }
  if (normalizedVectors > 0) {
    console.info(`Normalized ${normalizedVectors} transformed normal vectors after join.`);
  }
}

export async function optimizeModel({
  inputPath,
  outputPath,
  reportPath = null,
  profile = VIEWER_SAFE_PROFILE,
} = {}) {
  if (!inputPath || !outputPath) {
    throw new Error("optimizeModel requires explicit inputPath and outputPath.");
  }
  if (profile.name !== "viewer-safe") {
    throw new Error(`Unsupported optimization profile: ${profile.name}`);
  }

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  io.setLogger(new Logger(Logger.Verbosity.WARN));
  console.info(`Reading ${inputPath}...`);
  const document = await io.read(inputPath);
  const before = collectStats(document);
  const memorySafeMetadataPath = before.nodes > 100_000 && before.materials > 5_000;
  console.info("Before transforms:", before);

  // Ignore exporter-generated names, but retain all render properties, texture
  // relationships, extensions, and extras when comparing materials.
  await document.transform(
    dedup({
      keepUniqueNames: false,
      propertyTypes: [PropertyType.MATERIAL],
    }),
  );

  if (memorySafeMetadataPath) {
    // Extremely fragmented SketchUp exports can exceed V8's maximum Set size
    // inside join. Deduplicate in bounded passes, flatten world transforms, and
    // batch repeated meshes with model-viewer-compatible GPU instancing.
    console.info("Using memory-safe instancing path; preserving rendered triangles.");
    await document.transform(
      prune({
        keepAttributes: true,
        keepExtras: false,
        keepLeaves: false,
        keepSolidTextures: true,
      }),
      dedup({
        keepUniqueNames: false,
        propertyTypes: [PropertyType.ACCESSOR],
      }),
      dedup({
        keepUniqueNames: false,
        propertyTypes: [PropertyType.MESH],
      }),
      flatten(),
      instance({ min: 2 }),
    );
  } else {
    // Preserve Mesh/Node boundaries and join only compatible Primitives within
    // their existing Mesh.
    await document.transform(
      join({
        keepMeshes: true,
        keepNamed: false,
        cleanup: false,
      }),
      prune({
        keepAttributes: true,
        keepExtras: false,
        keepLeaves: false,
        keepSolidTextures: true,
      }),
      dedup({
        keepUniqueNames: false,
        propertyTypes: [
          PropertyType.ACCESSOR,
          PropertyType.MESH,
          PropertyType.TEXTURE,
          PropertyType.MATERIAL,
        ],
      }),
    );
    normalizeJoinedNormals(document);
  }

  for (const texture of document.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) continue;

    const mimeType = texture.getMimeType();
    if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) continue;

    const metadata = await sharp(image).metadata();
    const oversized = Math.max(metadata.width ?? 0, metadata.height ?? 0)
      > profile.maxTextureSize;
    const needsWebP = mimeType !== "image/webp";
    if (!oversized && !needsWebP) continue;

    const colorTexture = getTextureColorSpace(texture) === "srgb";
    await compressTexture(texture, {
      encoder: sharp,
      targetFormat: "webp",
      // glTF Transform uses a 0-100 effort scale and maps 100 to Sharp's WebP
      // effort 6. The previous value 6 effectively mapped to effort 0.
      effort: profile.webpEffort,
      ...(oversized
        ? { resize: [profile.maxTextureSize, profile.maxTextureSize] }
        : {}),
      ...(colorTexture
        ? { quality: profile.colorTextureQuality }
        : { lossless: true }),
    });
  }

  if (document.getRoot().listTextures().some((texture) => texture.getMimeType() === "image/webp")) {
    const existingWebPExtension = document
      .getRoot()
      .listExtensionsUsed()
      .find((extension) => extension.extensionName === EXTTextureWebP.EXTENSION_NAME);
    (existingWebPExtension ?? document.createExtension(EXTTextureWebP)).setRequired(true);
  }

  await document.transform(
    dedup({
      keepUniqueNames: false,
      propertyTypes: [PropertyType.TEXTURE, PropertyType.MATERIAL],
    }),
    prune({
      keepAttributes: true,
      keepExtras: false,
      keepLeaves: false,
      keepSolidTextures: true,
    }),
  );

  const after = collectStats(document);
  if (profile.preserveRenderedTriangles && after.sceneTriangles !== before.sceneTriangles) {
    throw new Error(
      `Rendered scene triangle count changed from ${before.sceneTriangles} to ${after.sceneTriangles}. Refusing output.`,
    );
  }

  console.info("After transforms:", after);
  console.info(`Writing ${outputPath}...`);
  await io.write(outputPath, document);
  if (reportPath) {
    await writeFile(
      reportPath,
      `${JSON.stringify({
        profile: profile.name,
        strategy: memorySafeMetadataPath ? "memory-safe-metadata" : "full-viewer-safe",
        input: path.basename(inputPath),
        output: path.basename(outputPath),
        before,
        after,
      }, null, 2)}\n`,
      "utf8",
    );
  }
  console.info("Optimization completed successfully without geometry simplification.");
  return { before, after };
}

const isCLI = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCLI) {
  const inputPath = process.argv[2] ?? "./model-source-backup.glb";
  const outputPath = process.argv[3] ?? "./model-optimized.glb";
  const reportPath = process.argv[4] ?? "./optimization-transform-report.json";
  await optimizeModel({ inputPath, outputPath, reportPath });
}
