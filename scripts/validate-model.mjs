import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeGLB } from "./glb-utils.mjs";
import { VIEWER_SAFE_PROFILE } from "./publisher-profile.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(MODULE_DIRECTORY, "..");

function run(command, args, { cwd = DEFAULT_PROJECT_ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function issue(code, message) {
  return { code, message };
}

function sortIssues(issues) {
  return issues.sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}

export async function runKhronosValidation(filePath, { projectRoot = DEFAULT_PROJECT_ROOT } = {}) {
  const workerPath = path.join(projectRoot, "scripts", "khronos-validator-worker.mjs");
  const result = await run(process.execPath, [
    "--max-old-space-size=8192",
    workerPath,
    filePath,
  ], { cwd: projectRoot });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = null;
  }
  if (result.code !== 0 || !report || report.numErrors > 0) {
    throw new Error(`Khronos glTF validation failed for ${path.basename(filePath)}.\n${result.stdout}${result.stderr}`);
  }
  return { passed: true, ...report };
}

export function evaluatePublishability(analysis, {
  profile = VIEWER_SAFE_PROFILE,
  candidate = false,
} = {}) {
  const errors = [];
  const warnings = [];

  if (analysis.scenes < 1) errors.push(issue("NO_SCENE", "The GLB does not contain a scene."));
  if (analysis.renderablePrimitives < 1) {
    errors.push(issue("NO_RENDERABLE_PRIMITIVE", "No scene-reachable primitive contains POSITION data."));
  }
  if (analysis.invalidNumericValues > 0) {
    errors.push(issue(
      "INVALID_NUMERIC_DATA",
      `${analysis.invalidNumericValues} accessor values are NaN or Infinity.`,
    ));
  }
  if (!analysis.bounds.valid || !analysis.bounds.size?.every(Number.isFinite)) {
    errors.push(issue("INVALID_BOUNDS", "World-space model bounds are missing or non-finite."));
  } else {
    const diagonal = analysis.bounds.diagonal;
    if (diagonal === 0) warnings.push(issue("DEGENERATE_BOUNDS", "Model bounds have zero diagonal."));
    if (diagonal > 10_000_000) {
      warnings.push(issue("VERY_LARGE_BOUNDS", `Model bounds diagonal is ${diagonal}.`));
    } else if (diagonal > 0 && diagonal < 0.000001) {
      warnings.push(issue("VERY_SMALL_BOUNDS", `Model bounds diagonal is ${diagonal}.`));
    }
    const originLimit = Math.max(diagonal * 1_000, 1_000_000);
    if (analysis.bounds.distanceFromOrigin > originLimit) {
      warnings.push(issue(
        "FAR_FROM_ORIGIN",
        `Model center is ${analysis.bounds.distanceFromOrigin} units from the world origin.`,
      ));
    }
  }

  if (analysis.externalResourceURIs.length) {
    warnings.push(issue(
      "EXTERNAL_RESOURCES",
      `GLB references ${analysis.externalResourceURIs.length} external resource(s); they will be embedded in output.`,
    ));
  }
  const texturesOverProfileLimit = analysis.textureDetails.filter(
    (texture) => Math.max(texture.width ?? 0, texture.height ?? 0) > profile.maxTextureSize,
  ).length;
  if (texturesOverProfileLimit) {
    const message = `${texturesOverProfileLimit} texture(s) exceed ${profile.maxTextureSize}px.`;
    if (candidate) errors.push(issue("TEXTURE_LIMIT_EXCEEDED", message));
    else warnings.push(issue("SOURCE_TEXTURE_RESIZE_REQUIRED", message));
  }
  return { errors: sortIssues(errors), warnings: sortIssues(warnings) };
}

function boundsClose(before, after) {
  if (!before.valid || !after.valid) return false;
  const scale = Math.max(
    1,
    before.diagonal ?? 0,
    after.diagonal ?? 0,
    before.distanceFromOrigin ?? 0,
    after.distanceFromOrigin ?? 0,
  );
  const tolerance = scale * 0.000001;
  return [...before.min, ...before.max].every((value, index) => {
    const other = index < 3 ? after.min[index] : after.max[index - 3];
    return Math.abs(value - other) <= tolerance;
  });
}

function transparencyChecks(before, after) {
  const failures = [];
  const warnings = [];
  const beforeNameCounts = new Map();
  const afterNameCounts = new Map();
  for (const texture of before.textureDetails) {
    if (texture.name) beforeNameCounts.set(texture.name, (beforeNameCounts.get(texture.name) ?? 0) + 1);
  }
  for (const texture of after.textureDetails) {
    if (texture.name) afterNameCounts.set(texture.name, (afterNameCounts.get(texture.name) ?? 0) + 1);
  }
  let unverifiable = 0;
  for (const texture of before.textureDetails.filter((item) => item.hasTransparency)) {
    const reliableName = texture.hasStableIdentity
      && texture.name
      && beforeNameCounts.get(texture.name) === 1
      && afterNameCounts.get(texture.name) === 1;
    if (!reliableName) {
      unverifiable += 1;
      continue;
    }
    const output = after.textureDetails.find((item) => item.name === texture.name);
    if (!output?.hasTransparency) {
      failures.push(issue(
        "TRANSPARENCY_NOT_PRESERVED",
        `Transparent texture is no longer transparent: ${texture.name}`,
      ));
    }
  }
  if (unverifiable) {
    warnings.push(issue(
      "TRANSPARENCY_IDENTITY_UNVERIFIABLE",
      `${unverifiable} transparent texture(s) could not be matched reliably by a unique name.`,
    ));
  }
  return { failures, warnings };
}

export async function validateCandidate({
  sourcePath,
  candidatePath,
  sourceAnalysis = null,
  candidateAnalysis = null,
  profile = VIEWER_SAFE_PROFILE,
  projectRoot = DEFAULT_PROJECT_ROOT,
  reportPath = null,
} = {}) {
  if (!sourcePath || !candidatePath) {
    throw new Error("validateCandidate requires sourcePath and candidatePath.");
  }
  await runKhronosValidation(candidatePath, { projectRoot });
  const before = sourceAnalysis ?? await analyzeGLB(sourcePath);
  const after = candidateAnalysis ?? await analyzeGLB(candidatePath);
  const candidateIssues = evaluatePublishability(after, { profile, candidate: true });
  const failures = [...candidateIssues.errors];
  const warnings = [...candidateIssues.warnings];

  if (profile.preserveRenderedTriangles && before.sceneTriangles !== after.sceneTriangles) {
    failures.push(issue(
      "RENDERED_TRIANGLES_CHANGED",
      `Rendered triangle count changed from ${before.sceneTriangles} to ${after.sceneTriangles}.`,
    ));
  }
  if (!boundsClose(before.bounds, after.bounds)) {
    failures.push(issue("BOUNDS_CHANGED", "World-space bounds changed beyond the validation tolerance."));
  }

  const afterMaterialSignatures = new Set(after.materialCoreSignatures);
  for (const signature of before.materialCoreSignatures) {
    if (!afterMaterialSignatures.has(signature)) {
      failures.push(issue(
        "CORE_MATERIAL_CHANGED",
        `A source material core property set is missing in output: ${signature}`,
      ));
    }
  }

  const allowedAdded = new Set(profile.allowedAddedRequiredExtensions);
  for (const extension of after.extensionsRequired) {
    if (!before.extensionsRequired.includes(extension) && !allowedAdded.has(extension)) {
      failures.push(issue(
        "UNEXPECTED_REQUIRED_EXTENSION",
        `Optimizer added unsupported required extension: ${extension}`,
      ));
    }
  }

  const transparency = transparencyChecks(before, after);
  failures.push(...transparency.failures);
  warnings.push(...transparency.warnings);
  sortIssues(failures);
  sortIssues(warnings);

  const report = {
    passed: failures.length === 0,
    profile: profile.name,
    failures,
    warnings,
    before,
    after,
  };
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (failures.length) {
    throw new Error(`Candidate validation failed:\n${failures.map((item) => `- ${item.code}: ${item.message}`).join("\n")}`);
  }
  return report;
}

const isCLI = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCLI) {
  const sourcePath = process.argv[2] ?? "./model-source-backup.glb";
  const candidatePath = process.argv[3] ?? "./model.glb";
  const reportPath = process.argv[4] ?? "./optimization-validation-report.json";
  const report = await validateCandidate({ sourcePath, candidatePath, reportPath });
  console.log(JSON.stringify({
    passed: report.passed,
    failures: report.failures,
    warnings: report.warnings,
    before: {
      sizeBytes: report.before.totalBytes,
      primitives: report.before.primitives,
      materials: report.before.materials,
      renderedTriangles: report.before.sceneTriangles,
    },
    after: {
      sizeBytes: report.after.totalBytes,
      primitives: report.after.primitives,
      materials: report.after.materials,
      renderedTriangles: report.after.sceneTriangles,
    },
  }, null, 2));
}
