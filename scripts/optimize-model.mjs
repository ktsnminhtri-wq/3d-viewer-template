import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Logger,
  NodeIO,
  PropertyType,
} from "@gltf-transform/core";
import {
  ALL_EXTENSIONS,
  EXTMeshGPUInstancing,
  EXTTextureWebP,
} from "@gltf-transform/extensions";
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
import {
  classifyModelComplexity,
  COMPLEXITY_CLASSES,
  optimizationPathFor,
} from "./publisher-complexity.mjs";
import { consolidateTrianglePrimitives } from "./primitive-consolidation.mjs";
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
    averageTrianglesPerPrimitive: primitives.length
      ? primitives.reduce((total, primitive) => total + countPrimitiveTriangles(primitive), 0)
        / primitives.length
      : 0,
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

function normalizeNodeRotations(document) {
  let normalizedRotations = 0;
  let normalizedInstanceRotations = 0;

  for (const node of document.getRoot().listNodes()) {
    const rotation = node.getRotation();
    const length = Math.hypot(...rotation);
    if (!Number.isFinite(length) || length <= 1e-12) {
      throw new Error(`Optimizer produced an invalid rotation quaternion on node "${node.getName()}".`);
    }
    if (Math.abs(length - 1) > 1e-10) {
      node.setRotation(rotation.map((value) => value / length));
      normalizedRotations += 1;
    }

    const batchRotation = node
      .getExtension("EXT_mesh_gpu_instancing")
      ?.getAttribute("ROTATION");
    const array = batchRotation?.getArray();
    if (!(array instanceof Float32Array)) continue;
    for (let index = 0; index < array.length; index += 4) {
      const instanceLength = Math.hypot(
        array[index],
        array[index + 1],
        array[index + 2],
        array[index + 3],
      );
      if (!Number.isFinite(instanceLength) || instanceLength <= 1e-12) {
        throw new Error("Optimizer produced an invalid instanced rotation quaternion.");
      }
      if (Math.abs(instanceLength - 1) <= 1e-6) continue;
      for (let component = 0; component < 4; component += 1) {
        array[index + component] /= instanceLength;
      }
      normalizedInstanceRotations += 1;
    }
    if (normalizedInstanceRotations > 0) batchRotation.setArray(array);
  }

  if (normalizedRotations > 0) {
    console.info(`Normalized ${normalizedRotations} node rotation quaternion(s) after transforms.`);
  }
  if (normalizedInstanceRotations > 0) {
    console.info(`Normalized ${normalizedInstanceRotations} instanced rotation quaternion(s) after transforms.`);
  }
}

export async function optimizeModel({
  inputPath,
  outputPath,
  reportPath = null,
  profile = VIEWER_SAFE_PROFILE,
  sourceAnalysis = null,
} = {}) {
  if (!inputPath || !outputPath) {
    throw new Error("optimizeModel requires explicit inputPath and outputPath.");
  }
  if (profile.name !== "viewer-safe") {
    throw new Error(`Unsupported optimization profile: ${profile.name}`);
  }

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  io.setLogger(new Logger(Logger.Verbosity.WARN));
  const timings = {};
  async function timed(stage, operation) {
    const started = performance.now();
    const result = await operation();
    timings[stage] = Math.round(performance.now() - started);
    console.info(`Stage ${stage}: ${timings[stage]} ms`);
    return result;
  }
  console.info(`Reading ${inputPath}...`);
  const document = await timed("read", () => io.read(inputPath));
  const before = await timed("collectBefore", () => collectStats(document));
  const classification = classifyModelComplexity(sourceAnalysis ?? before);
  const optimizationPath = optimizationPathFor(classification.complexityClass);
  const scalableConsolidation = [
    COMPLEXITY_CLASSES.LARGE,
    COMPLEXITY_CLASSES.HIGHLY_FRAGMENTED,
  ].includes(classification.complexityClass);
  const joinAcrossSiblingMeshes = before.primitives > 2_000;
  let consolidation = {
    inputPrimitives: before.primitives,
    outputPrimitives: before.primitives,
    consolidationGroupCount: 0,
    joinedPrimitiveCount: 0,
    mergedPrimitiveCount: 0,
  };
  console.info(`Complexity: ${classification.complexityClass}`);
  console.info(`Optimization path: ${optimizationPath}`);
  console.info("Before transforms:", before);

  // Ignore exporter-generated names, but retain all render properties, texture
  // relationships, extensions, and extras when comparing materials.
  await timed("dedupMaterialsInitial", () => document.transform(
    dedup({
      keepUniqueNames: false,
      propertyTypes: [PropertyType.MATERIAL],
    }),
  ));

  if (scalableConsolidation) {
    // Consolidate each shared Mesh definition once before global accessor/mesh
    // deduplication. This keeps the algorithm linear in primitive count and
    // avoids join() cloning work across every scene Node.
    consolidation = await timed(
      "primitiveConsolidation",
      () => consolidateTrianglePrimitives(document),
    );
    await timed("pruneStructure", () => document.transform(prune({
        keepAttributes: true,
        keepExtras: false,
        keepLeaves: false,
        keepSolidTextures: true,
      })));
    await timed("dedupAccessors", () => document.transform(dedup({
        keepUniqueNames: false,
        propertyTypes: [PropertyType.ACCESSOR],
      })));
    await timed("dedupMeshes", () => document.transform(dedup({
        keepUniqueNames: false,
        propertyTypes: [PropertyType.MESH],
      })));
    await timed("flatten", () => document.transform(flatten()));
    if (profile.runtimeInstancing) {
      await timed("instance", () => document.transform(instance({ min: profile.minimumInstanceCount })));
    }
  } else if (classification.complexityClass === COMPLEXITY_CLASSES.MEDIUM) {
    // Join compatible static sibling meshes within each hierarchy level. This
    // avoids one global building mesh while still batching exact materials and
    // preserving world-space geometry.
    await timed("join", () => document.transform(join({
        keepMeshes: !joinAcrossSiblingMeshes,
        keepNamed: false,
        cleanup: false,
      })));
    await timed("pruneStructure", () => document.transform(prune({
        keepAttributes: true,
        keepExtras: false,
        keepLeaves: false,
        keepSolidTextures: true,
      })));
    await timed("dedupStructure", () => document.transform(dedup({
        keepUniqueNames: false,
        propertyTypes: [
          PropertyType.ACCESSOR,
          PropertyType.MESH,
          PropertyType.TEXTURE,
          PropertyType.MATERIAL,
        ],
      })));
    await timed("normalizeJoinedNormals", () => normalizeJoinedNormals(document));
    if (profile.runtimeInstancing) {
      await timed("flatten", () => document.transform(flatten()));
      await timed("instance", () => document.transform(instance({ min: profile.minimumInstanceCount })));
    }
  } else {
    // SMALL: retain the original mesh layout and only perform correctness-safe
    // cleanup. Do not pay for join, accessor hashing, flatten, or consolidation.
    await timed("pruneStructure", () => document.transform(prune({
      keepAttributes: true,
      keepExtras: false,
      keepLeaves: false,
      keepSolidTextures: true,
    })));
  }

  await timed("textures", async () => {
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
  });

  if (document.getRoot().listTextures().some((texture) => texture.getMimeType() === "image/webp")) {
    const existingWebPExtension = document
      .getRoot()
      .listExtensionsUsed()
      .find((extension) => extension.extensionName === EXTTextureWebP.EXTENSION_NAME);
    (existingWebPExtension ?? document.createExtension(EXTTextureWebP)).setRequired(true);
  }

  await timed("dedupTexturesMaterialsFinal", () => document.transform(dedup({
      keepUniqueNames: false,
      propertyTypes: [PropertyType.TEXTURE, PropertyType.MATERIAL],
    })));
  await timed("pruneFinal", () => document.transform(prune({
      keepAttributes: true,
      keepExtras: false,
      keepLeaves: false,
      keepSolidTextures: true,
    })));

  // Transform flattening/joining can introduce small floating-point drift in
  // decomposed node rotations. glTF requires every stored quaternion to be a
  // unit quaternion, so normalize only that representation before validation.
  await timed("normalizeRotations", () => normalizeNodeRotations(document));

  const instancingExtension = document
    .getRoot()
    .listExtensionsUsed()
    .find((extension) => extension.extensionName === EXTMeshGPUInstancing.EXTENSION_NAME);
  if (instancingExtension) instancingExtension.setRequired(true);

  const after = await timed("collectAfter", () => collectStats(document));
  if (profile.preserveRenderedTriangles && after.sceneTriangles !== before.sceneTriangles) {
    throw new Error(
      `Rendered scene triangle count changed from ${before.sceneTriangles} to ${after.sceneTriangles}. Refusing output.`,
    );
  }

  console.info("After transforms:", after);
  console.info(`Writing ${outputPath}...`);
  await timed("write", () => io.write(outputPath, document));
  if (reportPath) {
    await writeFile(
      reportPath,
      `${JSON.stringify({
        profile: profile.name,
        strategy: optimizationPath,
        complexity: classification,
        consolidation,
        input: path.basename(inputPath),
        output: path.basename(outputPath),
        before,
        after,
        timings,
      }, null, 2)}\n`,
      "utf8",
    );
  }
  console.info("Optimization completed successfully without geometry simplification.");
  return {
    before,
    after,
    timings,
    complexity: classification,
    optimizationPath,
    consolidation,
  };
}

const isCLI = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCLI) {
  const inputPath = process.argv[2] ?? "./model-source-backup.glb";
  const outputPath = process.argv[3] ?? "./model-optimized.glb";
  const reportPath = process.argv[4] ?? "./optimization-transform-report.json";
  await optimizeModel({ inputPath, outputPath, reportPath });
}
