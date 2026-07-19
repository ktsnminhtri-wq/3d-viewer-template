import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import {
  GITHUB_FILE_LIMIT,
  MIB,
  analyzeGLB,
  optimizationReasons,
  printableSummary,
} from "./glb-utils.mjs";

const ROOT = process.cwd();
const MODEL = path.join(ROOT, "model.glb");
const BACKUP = path.join(ROOT, "model-source-backup.glb");
const CANDIDATE = path.join(ROOT, "model-optimized.glb");
const OPTIMIZER = path.join(ROOT, "scripts", "optimize-model.mjs");
const VALIDATOR = path.join(ROOT, "scripts", "validate-model.mjs");
const GLTF_CLI = path.join(
  ROOT,
  "node_modules",
  "@gltf-transform",
  "cli",
  "bin",
  "cli.js",
);

function formatMiB(bytes) {
  return `${(bytes / MIB).toFixed(2)} MiB`;
}

function run(command, args, { capture = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error(
        `${command} ${args.join(" ")} failed with exit code ${code}.\n${stdout}${stderr}`,
      ));
    });
  });
}

async function runNode(script, args = []) {
  await run(process.execPath, ["--max-old-space-size=4096", script, ...args]);
}

async function git(args, options) {
  return run("git", args, options);
}

async function assertBackupIsIgnored() {
  const result = await git(
    ["check-ignore", "-q", "model-source-backup.glb"],
    { capture: true, allowFailure: true },
  );
  if (result.code !== 0) {
    throw new Error(
      "model-source-backup.glb is not excluded by .gitignore. Deployment stopped.",
    );
  }
}

async function validateSpec(filePath) {
  const result = await run(
    process.execPath,
    [GLTF_CLI, "validate", filePath],
    { capture: true, allowFailure: true },
  );
  if (result.code !== 0 || /No errors found\./i.test(result.stdout) === false) {
    throw new Error(`glTF specification validation failed.\n${result.stdout}${result.stderr}`);
  }
  console.info("glTF specification validation: PASS");
}

async function validateComparison(sourcePath, outputPath) {
  await runNode(VALIDATOR, [sourcePath, outputPath]);
  await validateSpec(outputPath);
}

async function validateWebsite() {
  const indexPath = path.join(ROOT, "index.html");
  const indexHTML = await readFile(indexPath, "utf8");
  if (!/src=["']\.\/model\.glb["']/.test(indexHTML)) {
    throw new Error('index.html must load the model from src="./model.glb".');
  }

  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
      const allowed = new Set([
        "index.html",
        "styles.css",
        "app.js",
        "model.glb",
        "assets/spruit-sunrise-1k-hdr.jpg",
      ]);
      if (!allowed.has(relativePath)) {
        response.writeHead(404).end();
        return;
      }
      const filePath = path.join(ROOT, relativePath);
      const fileStats = await stat(filePath);
      response.setHeader("Content-Length", String(fileStats.size));
      response.writeHead(200);
      if (request.method === "HEAD") response.end();
      else createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(500).end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    const baseURL = `http://127.0.0.1:${address.port}`;
    const indexResponse = await fetch(`${baseURL}/index.html`);
    const modelResponse = await fetch(`${baseURL}/model.glb`, { method: "HEAD" });
    if (!indexResponse.ok || !modelResponse.ok) {
      throw new Error("Local static server could not serve index.html and model.glb.");
    }
    if (Number(modelResponse.headers.get("content-length")) !== (await stat(MODEL)).size) {
      throw new Error("Local server returned an unexpected model.glb byte length.");
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.info("Local website validation: PASS (index.html → ./model.glb)");
}

function githubPagesURL(remoteURL) {
  const normalized = remoteURL.trim().replace(/\.git$/, "");
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (!match) return "Unable to derive GitHub Pages URL from origin.";
  const [, owner, repository] = match;
  return repository.toLowerCase() === `${owner.toLowerCase()}.github.io`
    ? `https://${owner}.github.io/`
    : `https://${owner}.github.io/${repository}/`;
}

function printLargestContributors(analysis) {
  console.error("\nLargest meshes by geometry storage:");
  console.table(analysis.largestMeshes.slice(0, 10).map((mesh) => ({
    mesh: mesh.name,
    geometry: formatMiB(mesh.geometryBytes),
    triangles: mesh.triangles,
    primitives: mesh.primitives,
  })));
  console.error("Largest embedded textures:");
  console.table(analysis.largestTextures.slice(0, 10).map((texture) => ({
    texture: texture.name,
    size: formatMiB(texture.bytes),
    resolution: texture.width && texture.height
      ? `${texture.width}×${texture.height}`
      : "unknown",
  })));
  console.error(
    "SketchUp action required: simplify the highest-triangle furniture/components, "
    + "replace detailed background assets with low-poly versions, purge unused components "
    + "and materials, reuse shared materials, and reduce source texture dimensions before export.",
  );
}

async function commitAndPush(originalBytes, finalBytes) {
  await assertBackupIsIgnored();
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { capture: true })).stdout.trim();
  if (branch !== "main") {
    throw new Error(`Deployment must run from main, not ${branch}.`);
  }

  await git(["add", "-A"]);
  const stagedOutput = (await git(
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    { capture: true },
  )).stdout.trim();
  const stagedFiles = stagedOutput ? stagedOutput.split(/\r?\n/) : [];
  const forbidden = /^(?:node_modules\/|model-original\.glb$|model-source-backup\.glb$|model-optimized\.glb$)/i;
  for (const relativePath of stagedFiles) {
    if (forbidden.test(relativePath)) {
      throw new Error(`Forbidden deployment file was staged: ${relativePath}`);
    }
    const stagedPath = path.join(ROOT, relativePath);
    try {
      const fileStats = await stat(stagedPath);
      if (fileStats.size > GITHUB_FILE_LIMIT) {
        throw new Error(`Refusing to commit file over 100 MiB: ${relativePath}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  if (stagedFiles.length) {
    const automationIncluded = stagedFiles.includes("scripts/deploy-model.mjs");
    const message = automationIncluded
      ? "Automate GLB optimization and deployment"
      : `Deploy validated 3D model (${formatMiB(originalBytes)} → ${formatMiB(finalBytes)})`;
    await git(["commit", "-m", message]);
  } else {
    console.info("No file changes to commit.");
  }
  await git(["push", "origin", "main"]);
  return (await git(["remote", "get-url", "origin"], { capture: true })).stdout.trim();
}

let beforeAnalysis;
let afterAnalysis;
let candidateAnalysis;
let validationResult = "NOT RUN";

async function main() {
  await access(MODEL);
  await assertBackupIsIgnored();

  const initialStats = await stat(MODEL);
  console.info(`Found model.glb (${formatMiB(initialStats.size)}).`);
  await copyFile(MODEL, BACKUP);
  console.info("Created local backup: model-source-backup.glb");

  beforeAnalysis = await analyzeGLB(BACKUP);
  console.info("Source analysis:", printableSummary(beforeAnalysis));
  const reasons = optimizationReasons(beforeAnalysis);
  let shouldOptimize;
  if (beforeAnalysis.totalBytes > GITHUB_FILE_LIMIT) {
    shouldOptimize = true;
    console.info("Model is over 100 MiB; optimization is mandatory.");
  } else if (beforeAnalysis.totalBytes >= 50 * MIB) {
    shouldOptimize = true;
    console.info("Model is between 50 and 100 MiB; running normal optimization.");
  } else {
    shouldOptimize = reasons.length > 0;
    console.info(shouldOptimize
      ? `Model is below 50 MiB but optimization is justified: ${reasons.join("; ")}.`
      : "Model is below 50 MiB with no clear waste; validation only.");
  }

  if (shouldOptimize) {
    await rm(CANDIDATE, { force: true });
    await runNode(OPTIMIZER, [BACKUP, CANDIDATE]);
    candidateAnalysis = await analyzeGLB(CANDIDATE);
    console.info("Optimized candidate:", printableSummary(candidateAnalysis));
    if (candidateAnalysis.totalBytes > GITHUB_FILE_LIMIT) {
      printLargestContributors(candidateAnalysis);
      throw new Error(
        `Optimization produced ${formatMiB(candidateAnalysis.totalBytes)}, still over 100 MiB. Nothing was committed or pushed.`,
      );
    }
    await validateComparison(BACKUP, CANDIDATE);
    await copyFile(CANDIDATE, MODEL);
    await rm(CANDIDATE, { force: true });
  } else {
    await validateComparison(BACKUP, MODEL);
  }

  afterAnalysis = await analyzeGLB(MODEL);
  if (afterAnalysis.totalBytes > GITHUB_FILE_LIMIT) {
    printLargestContributors(afterAnalysis);
    throw new Error("Final model.glb exceeds 100 MiB. Nothing was committed or pushed.");
  }
  if (afterAnalysis.sceneTriangles !== beforeAnalysis.sceneTriangles) {
    throw new Error("Rendered triangle count changed. Nothing was committed or pushed.");
  }
  validationResult = "PASS";
  await validateWebsite();

  const remoteURL = await commitAndPush(beforeAnalysis.totalBytes, afterAnalysis.totalBytes);
  const reduction = beforeAnalysis.totalBytes
    ? (1 - afterAnalysis.totalBytes / beforeAnalysis.totalBytes) * 100
    : 0;

  console.info("\nDeployment summary");
  console.info(`Original size:       ${formatMiB(beforeAnalysis.totalBytes)}`);
  console.info(`Optimized size:      ${formatMiB(afterAnalysis.totalBytes)}`);
  console.info(`Reduction:           ${reduction.toFixed(2)}%`);
  console.info(`Primitives:          ${beforeAnalysis.primitives.toLocaleString()} → ${afterAnalysis.primitives.toLocaleString()}`);
  console.info(`Materials:           ${beforeAnalysis.materials.toLocaleString()} → ${afterAnalysis.materials.toLocaleString()}`);
  console.info(`Rendered triangles:  ${beforeAnalysis.sceneTriangles.toLocaleString()} → ${afterAnalysis.sceneTriangles.toLocaleString()}`);
  console.info(`Validation:          ${validationResult}`);
  console.info(`GitHub Pages:        ${githubPagesURL(remoteURL)}`);
}

try {
  await main();
} catch (error) {
  console.error(`\nDEPLOYMENT STOPPED SAFELY\n${error.message}`);
  if (
    beforeAnalysis
    && (beforeAnalysis.totalBytes > GITHUB_FILE_LIMIT || candidateAnalysis?.totalBytes > GITHUB_FILE_LIMIT)
  ) {
    printLargestContributors(candidateAnalysis ?? beforeAnalysis);
  }
  console.error(`Validation: ${validationResult}`);
  process.exitCode = 1;
}
