import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { format } from "node:util";
import { publishModel, PROJECT_ROOT } from "./publisher-core.mjs";

export function formatMiB(bytes) {
  return `${(Number(bytes) / (1024 * 1024)).toFixed(2)} MiB`;
}

export async function validateSourceArgument(sourceArgument) {
  if (!sourceArgument) {
    throw new Error("Hãy kéo một file .glb vào BAT file.");
  }

  const sourcePath = path.resolve(sourceArgument);
  if (path.extname(sourcePath).toLowerCase() !== ".glb") {
    throw new Error(`File nguồn phải có phần mở rộng .glb: ${sourceArgument}`);
  }

  const sourceStats = await stat(sourcePath).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(`Không tìm thấy file GLB: ${sourceArgument}`);
    }
    throw error;
  });
  if (!sourceStats.isFile()) {
    throw new Error(`Đường dẫn không phải là một file: ${sourceArgument}`);
  }

  return sourcePath;
}

function captureConsole() {
  const messages = [];
  const originals = new Map();
  for (const method of ["log", "info", "warn", "error"]) {
    originals.set(method, console[method]);
    console[method] = (...args) => messages.push(format(...args));
  }
  return {
    messages,
    restore() {
      for (const [method, original] of originals) console[method] = original;
    },
  };
}

export async function publishQuietly(sourcePath, { projectRoot = PROJECT_ROOT } = {}) {
  const capture = captureConsole();
  try {
    return await publishModel(sourcePath, { projectRoot });
  } catch (error) {
    if (capture.messages.length) {
      error.publisherDetails = capture.messages.join("\n");
    }
    throw error;
  } finally {
    capture.restore();
  }
}

export function printMetadataSummary(metadata) {
  const warnings = metadata.validation?.warnings ?? [];
  const runtime = metadata.runtimeOptimization ?? {};
  console.info("--------------------------------");
  console.info("MODEL READY");
  console.info(`Source:          ${metadata.source.name}`);
  console.info(`Complexity:      ${metadata.complexityClass ?? "UNKNOWN"}`);
  console.info(`Path:            ${metadata.optimizationPath ?? "legacy"}`);
  console.info(`Input size:      ${formatMiB(metadata.source.sizeBytes)}`);
  console.info(`Output size:     ${formatMiB(metadata.output.sizeBytes)}`);
  console.info(`Output SHA:      ${metadata.output.sha256}`);
  console.info(
    `Triangles:       ${(metadata.trianglesBefore ?? metadata.counts.renderedTriangles ?? 0).toLocaleString("en-US")}`
    + ` -> ${(metadata.trianglesAfter ?? metadata.counts.renderedTriangles ?? 0).toLocaleString("en-US")}`,
  );
  console.info(`Nodes:           ${(metadata.counts.nodes ?? 0).toLocaleString("en-US")}`);
  console.info(`Meshes:          ${(metadata.counts.meshes ?? 0).toLocaleString("en-US")}`);
  console.info(
    `Primitives:      ${(metadata.primitivesBefore ?? metadata.counts.primitives ?? 0).toLocaleString("en-US")}`
    + ` -> ${(metadata.primitivesAfter ?? metadata.counts.primitives ?? 0).toLocaleString("en-US")}`,
  );
  console.info(
    `Geometries:      ${(metadata.geometriesBefore ?? metadata.counts.primitives ?? 0).toLocaleString("en-US")}`
    + ` -> ${(metadata.geometriesAfter ?? metadata.counts.primitives ?? 0).toLocaleString("en-US")}`,
  );
  console.info(
    `Draw calls est.: ${(metadata.estimatedDrawCallsBefore ?? metadata.counts.drawCalls ?? 0).toLocaleString("en-US")}`
    + ` -> ${(metadata.estimatedDrawCallsAfter ?? metadata.counts.drawCalls ?? 0).toLocaleString("en-US")}`,
  );
  console.info(`Merged prims:    ${(metadata.mergedPrimitiveCount ?? 0).toLocaleString("en-US")}`);
  console.info(`Merge groups:    ${(metadata.consolidationGroupCount ?? 0).toLocaleString("en-US")}`);
  console.info(`Build time:      ${((metadata.preprocessingTimingsMs?.totalBeforeMetadata ?? 0) / 1000).toFixed(2)} s`);
  console.info(`Textures:        ${(metadata.counts.textures ?? 0).toLocaleString("en-US")}`);
  console.info(`Texture GPU est.: ${formatMiB(metadata.textures?.estimatedGPUBytesRGBA8WithMipmaps ?? 0)}`);
  if (metadata.runtimeOptimization) {
    console.info("Runtime optimization:");
    console.info(`  Nodes removed:   ${(runtime.removedNodes ?? 0).toLocaleString("en-US")}`);
    console.info(`  Meshes merged:   ${(runtime.mergedMeshes ?? 0).toLocaleString("en-US")}`);
    console.info(`  Primitives merged: ${(runtime.mergedPrimitives ?? 0).toLocaleString("en-US")}`);
    console.info(`  Instance batches: ${(runtime.instanceBatches ?? 0).toLocaleString("en-US")}`);
    console.info(`  Repeated groups:  ${(runtime.repeatedGeometryGroups ?? 0).toLocaleString("en-US")}`);
    console.info(
      `  Draw calls:      ${(runtime.estimatedDrawCallsBefore ?? 0).toLocaleString("en-US")}`
      + ` -> ${(runtime.estimatedDrawCallsAfter ?? 0).toLocaleString("en-US")}`,
    );
    if (!runtime.instancingUsed && (runtime.potentialDrawCallSavingsFromInstancing ?? 0) > 0) {
      console.info(
        `  Instancing opportunity (not applied): ${(runtime.potentialDrawCallSavingsFromInstancing).toLocaleString("en-US")}`,
      );
    }
  }
  const timings = metadata.preprocessingTimingsMs ?? {};
  if (Object.keys(timings).length) {
    console.info("Stage timings:");
    for (const [stage, duration] of Object.entries(timings)) {
      console.info(`  ${stage}: ${duration} ms`);
    }
  }
  if (!warnings.length) {
    console.info("Warnings:   none");
    console.info("--------------------------------");
    return;
  }
  console.info(`Warnings:   ${warnings.length}`);
  for (const warning of warnings) {
    console.info(`  - ${warning.code}: ${warning.message}`);
  }
  console.info("--------------------------------");
}

export function reportWorkflowError(title, error) {
  console.error(`\n${title}`);
  console.error(error.message);
  if (error.publisherDetails) {
    console.error("\nPublisher details:");
    console.error(error.publisherDetails);
  }
}

export function openURL(url) {
  if (process.platform !== "win32") return false;
  try {
    const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function waitForPublishedSHA(metadataURL, expectedSHA, {
  timeoutMs = 90_000,
  intervalMs = 3_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const checkURL = new URL(metadataURL);
      checkURL.searchParams.set("check", String(Date.now()));
      const response = await fetch(checkURL, {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok && (await response.json()).output?.sha256 === expectedSHA) return true;
    } catch {
      // GitHub Pages may still be rebuilding. Retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
