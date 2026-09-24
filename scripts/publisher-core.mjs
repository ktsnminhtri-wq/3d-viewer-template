import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeGLB, sha256File } from "./glb-utils.mjs";
import { optimizeModel } from "./optimize-model.mjs";
import { VIEWER_SAFE_PROFILE } from "./publisher-profile.mjs";
import {
  evaluatePublishability,
  runKhronosValidation,
  validateCandidate,
} from "./validate-model.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(MODULE_DIRECTORY, "..");

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function stableWarnings(warnings) {
  const unique = new Map();
  for (const warning of warnings) unique.set(`${warning.code}\0${warning.message}`, warning);
  return [...unique.values()].sort(
    (a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message),
  );
}

async function copyExternalResources(sourcePath, tempSourcePath, analysis) {
  const sourceDirectory = path.dirname(sourcePath);
  const tempDirectory = path.dirname(tempSourcePath);
  for (const uri of analysis.externalResourceURIs) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith("//")) {
      throw new Error(`Remote external GLB resource is not supported by local publish: ${uri}`);
    }
    const decoded = decodeURIComponent(uri.split(/[?#]/, 1)[0]).replaceAll("/", path.sep);
    const sourceResource = path.resolve(sourceDirectory, decoded);
    if (!isWithin(sourceDirectory, sourceResource)) {
      throw new Error(`External GLB resource escapes the source directory: ${uri}`);
    }
    const tempResource = path.resolve(tempDirectory, decoded);
    if (!isWithin(tempDirectory, tempResource)) {
      throw new Error(`Unsafe external GLB resource path: ${uri}`);
    }
    await mkdir(path.dirname(tempResource), { recursive: true });
    await copyFile(sourceResource, tempResource);
  }
}

function metadataFrom({
  sourcePath,
  sourceHash,
  outputHash,
  before,
  after,
  profile,
  warnings,
  optimization,
  preprocessingTimings,
}) {
  return {
    schemaVersion: 2,
    complexityClass: optimization.complexity.complexityClass,
    complexityMetrics: optimization.complexity.metrics,
    optimizationPath: optimization.optimizationPath,
    preprocessingTimingsMs: { ...preprocessingTimings },
    primitivesBefore: before.primitives,
    primitivesAfter: after.primitives,
    geometriesBefore: before.renderablePrimitives,
    geometriesAfter: after.renderablePrimitives,
    estimatedDrawCallsBefore: before.sceneDrawCalls,
    estimatedDrawCallsAfter: after.sceneDrawCalls,
    mergedPrimitiveCount: optimization.consolidation.mergedPrimitiveCount,
    consolidationGroupCount: optimization.consolidation.consolidationGroupCount,
    trianglesBefore: before.sceneTriangles,
    trianglesAfter: after.sceneTriangles,
    source: {
      name: path.basename(sourcePath),
      sizeBytes: before.totalBytes,
      sha256: sourceHash,
    },
    output: {
      name: "model.glb",
      sizeBytes: after.totalBytes,
      sha256: outputHash,
    },
    gltfVersion: after.gltfVersion,
    counts: {
      scenes: after.scenes,
      nodes: after.nodes,
      meshes: after.meshes,
      meshInstances: after.meshInstances,
      primitives: after.primitives,
      drawCalls: after.sceneDrawCalls,
      storedTriangles: after.storedTriangles,
      renderedTriangles: after.sceneTriangles,
      materials: after.materials,
      textures: after.textures,
      animations: after.animations,
    },
    bounds: {
      min: after.bounds.min,
      max: after.bounds.max,
      size: after.bounds.size,
      center: after.bounds.center,
      cameraTarget: after.cameraTarget,
      distanceFromOrigin: after.bounds.distanceFromOrigin,
    },
    textures: {
      totalBytes: after.textureBytes,
      formats: after.textureFormats,
      maxWidth: after.maxTextureWidth,
      maxHeight: after.maxTextureHeight,
      transparentCount: after.transparentTextureCount,
      oversizedCount: after.oversizedTextureCount,
      duplicateCount: after.duplicateImageCount,
      estimatedGPUBytesRGBA8WithMipmaps: after.estimatedTextureGPUBytes,
    },
    materials: {
      alphaModeCounts: after.alphaModeCounts,
      blendedCount: after.alphaModeCounts.BLEND ?? 0,
      maskedCount: after.alphaModeCounts.MASK ?? 0,
    },
    extensions: {
      used: after.extensionsUsed,
      required: after.extensionsRequired,
    },
    optimizationProfile: {
      name: profile.name,
      maxTextureSize: profile.maxTextureSize,
      colorTextureQuality: profile.colorTextureQuality,
      webpEffort: profile.webpEffort,
      preserveRenderedTriangles: profile.preserveRenderedTriangles,
      runtimeInstancing: profile.runtimeInstancing,
      minimumInstanceCount: profile.minimumInstanceCount,
    },
    runtimeOptimization: {
      removedNodes: Math.max(0, before.nodes - after.nodes),
      mergedMeshes: Math.max(0, before.meshes - after.meshes),
      mergedPrimitives: Math.max(0, before.primitives - after.primitives),
      repeatedGeometryGroups: after.repeatedGeometryMaterialGroups,
      repeatedGeometryInstances: after.repeatedGeometryInstances,
      instancingUsed: after.instancedBatchCount > 0,
      instanceBatches: after.instancedBatchCount,
      instancesBatched: after.instancedInstanceCount,
      estimatedDrawCallsBefore: before.sceneDrawCalls,
      estimatedDrawCallsAfter: after.sceneDrawCalls,
      estimatedDrawCallsWithoutInstancing: after.sceneDrawCallsWithoutInstancing,
      estimatedDrawCallSavingsFromInstancing:
        after.sceneDrawCallsWithoutInstancing - after.sceneDrawCalls,
      estimatedDrawCallsIfInstanced: after.estimatedDrawCallsAfterInstancing,
      potentialDrawCallSavingsFromInstancing: after.estimatedInstancingSavings,
      repeatedGeometryTopGroups: after.largestRepeatedGeometryGroups,
      consolidation: optimization.consolidation,
    },
    validation: {
      passed: true,
      warnings: stableWarnings(warnings),
    },
  };
}

async function replaceCurrentDirectory(stageDirectory, currentDirectory) {
  const distDirectory = path.dirname(currentDirectory);
  const previousDirectory = path.join(distDirectory, `.current-previous-${randomUUID()}`);
  const hadCurrent = await pathExists(currentDirectory);
  if (hadCurrent) await rename(currentDirectory, previousDirectory);
  try {
    await rename(stageDirectory, currentDirectory);
  } catch (error) {
    if (hadCurrent && await pathExists(previousDirectory)) {
      await rename(previousDirectory, currentDirectory);
    }
    throw error;
  }
  if (hadCurrent) {
    await rm(previousDirectory, { recursive: true, force: true }).catch((error) => {
      console.warn(`Published successfully, but could not remove previous artifact: ${error.message}`);
    });
  }
}

export async function publishModel(sourceArgument, {
  projectRoot = PROJECT_ROOT,
  outputDirectory = path.join(projectRoot, "dist", "current"),
  profile = VIEWER_SAFE_PROFILE,
} = {}) {
  if (!sourceArgument || typeof sourceArgument !== "string") {
    throw new Error('Missing source GLB. Usage: npm run publish -- "D:\\Models\\villa.glb"');
  }
  const sourcePath = path.resolve(sourceArgument);
  if (path.extname(sourcePath).toLowerCase() !== ".glb") {
    throw new Error(`Source must use the .glb extension: ${sourceArgument}`);
  }
  const sourceStats = await stat(sourcePath).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`Source GLB does not exist: ${sourceArgument}`);
    throw error;
  });
  if (!sourceStats.isFile()) throw new Error(`Source GLB is not a file: ${sourceArgument}`);
  if (isWithin(outputDirectory, sourcePath)) {
    throw new Error("Source cannot be inside dist/current because publishing replaces that directory.");
  }

  const publishStarted = performance.now();
  const preprocessingTimings = {};
  async function timed(stage, operation) {
    const started = performance.now();
    const result = await operation();
    preprocessingTimings[stage] = Math.round(performance.now() - started);
    console.info(`Stage ${stage}: ${preprocessingTimings[stage]} ms`);
    return result;
  }

  const sourceHash = await timed("sourceHash", () => sha256File(sourcePath));
  const jobDirectory = await timed(
    "workspacePreparation",
    () => mkdtemp(path.join(os.tmpdir(), "glb-publisher-")),
  );
  const tempSourcePath = path.join(jobDirectory, "source.glb");
  const candidatePath = path.join(jobDirectory, "candidate.glb");
  const transformReportPath = path.join(jobDirectory, "optimization.json");
  let stageDirectory = null;

  try {
    console.info(`Preflight: ${path.basename(sourcePath)} (${formatMiB(sourceStats.size)})`);
    const sourceAnalysis = await timed("sourceAnalysis", () => analyzeGLB(sourcePath));
    await timed("sourceValidation", () => runKhronosValidation(sourcePath, { projectRoot }));
    const preflight = await timed(
      "sourcePreflight",
      () => evaluatePublishability(sourceAnalysis, { profile, candidate: false }),
    );
    if (preflight.errors.length) {
      throw new Error(`Source preflight failed:\n${preflight.errors.map((item) => `- ${item.code}: ${item.message}`).join("\n")}`);
    }
    console.info("Source center:", sourceAnalysis.bounds.center);
    console.info("Source size:", sourceAnalysis.bounds.size);
    console.info(`Distance from origin: ${sourceAnalysis.bounds.distanceFromOrigin}`);

    await timed("workspaceCopy", async () => {
      await copyFile(sourcePath, tempSourcePath);
      await copyExternalResources(sourcePath, tempSourcePath, sourceAnalysis);
    });
    const optimization = await timed("optimizationTotal", () => optimizeModel({
      inputPath: tempSourcePath,
      outputPath: candidatePath,
      reportPath: transformReportPath,
      profile,
      sourceAnalysis,
    }));
    for (const [stage, duration] of Object.entries(optimization.timings)) {
      preprocessingTimings[`optimize.${stage}`] = duration;
    }

    const candidateAnalysis = await timed("candidateAnalysis", () => analyzeGLB(candidatePath));
    const validation = await timed("finalValidation", () => validateCandidate({
      sourcePath: tempSourcePath,
      candidatePath,
      sourceAnalysis,
      candidateAnalysis,
      profile,
      projectRoot,
    }));
    const currentSourceHash = await timed("sourceHashVerification", () => sha256File(sourcePath));
    if (currentSourceHash !== sourceHash) {
      throw new Error("Source GLB changed while publishing. Output was not installed.");
    }

    const outputHash = await timed("outputHash", () => sha256File(candidatePath));
    preprocessingTimings.totalBeforeMetadata = Math.round(performance.now() - publishStarted);
    const metadata = await timed("metadataCreation", () => metadataFrom({
      sourcePath,
      sourceHash,
      outputHash,
      before: sourceAnalysis,
      after: candidateAnalysis,
      profile,
      warnings: [...preflight.warnings, ...validation.warnings],
      optimization,
      preprocessingTimings,
    }));
    metadata.preprocessingTimingsMs = { ...preprocessingTimings };

    const distDirectory = path.dirname(outputDirectory);
    await timed("artifactInstall", async () => {
      await mkdir(distDirectory, { recursive: true });
      stageDirectory = await mkdtemp(path.join(distDirectory, ".current-stage-"));
      await copyFile(candidatePath, path.join(stageDirectory, "model.glb"));
      await writeFile(
        path.join(stageDirectory, "metadata.json"),
        `${JSON.stringify(metadata, null, 2)}\n`,
        "utf8",
      );
      await replaceCurrentDirectory(stageDirectory, outputDirectory);
    });
    stageDirectory = null;

    const reduction = sourceAnalysis.totalBytes
      ? (1 - candidateAnalysis.totalBytes / sourceAnalysis.totalBytes) * 100
      : 0;
    console.info("\nPublish completed successfully.");
    console.info(`Source:      ${formatMiB(sourceAnalysis.totalBytes)} (${sourceHash})`);
    console.info(`Output:      ${formatMiB(candidateAnalysis.totalBytes)} (${outputHash})`);
    console.info(`Reduction:   ${reduction.toFixed(2)}%`);
    console.info(`Primitives:  ${sourceAnalysis.primitives} -> ${candidateAnalysis.primitives}`);
    console.info(`Materials:   ${sourceAnalysis.materials} -> ${candidateAnalysis.materials}`);
    console.info(`Output path: ${outputDirectory}`);
    return { sourceAnalysis, candidateAnalysis, metadata, outputDirectory };
  } finally {
    if (stageDirectory) {
      await rm(stageDirectory, { recursive: true, force: true }).catch((error) => {
        console.warn(`Could not remove staged output: ${error.message}`);
      });
    }
    await rm(jobDirectory, { recursive: true, force: true }).catch((error) => {
      console.warn(`Could not remove temporary publish workspace: ${error.message}`);
    });
  }
}

export async function readPublishedMetadata({
  outputDirectory = path.join(PROJECT_ROOT, "dist", "current"),
} = {}) {
  return JSON.parse(await readFile(path.join(outputDirectory, "metadata.json"), "utf8"));
}
