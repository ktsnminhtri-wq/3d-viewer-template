import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, watch as watchFiles } from "node:fs";
import {
  access,
  copyFile,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
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
import {
  bakeLightingIntoViewer,
  readLightingConfig,
  writeLightingConfig,
} from "./lighting-config.mjs";

const ROOT = process.cwd();
const MODEL = path.join(ROOT, "model.glb");
const INCOMING_MODEL = path.join(ROOT, "model-new.glb");
const BACKUP = path.join(ROOT, "model-source-backup.glb");
const CANDIDATE = path.join(ROOT, "model-optimized.glb");
const RECEIPT = path.join(ROOT, ".preview-validation.json");
const OPTIMIZER = path.join(ROOT, "scripts", "optimize-model.mjs");
const VALIDATOR = path.join(ROOT, "scripts", "validate-model.mjs");
const GLTF_CLI = path.join(ROOT, "node_modules", "@gltf-transform", "cli", "bin", "cli.js");
const PREVIEW_MODE = process.argv.includes("--preview");
const NO_OPEN = process.argv.includes("--no-open");
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT || 8000);
const CORE_VISUAL_FILES = [
  "model.glb",
  "index.html",
  "styles.css",
  "app.js",
  "sketch.css",
  "sketch-controller.js",
  "sketch-spatial-model.js",
  "lighting-config.json",
  "preview-lighting-studio.css",
  "preview-lighting-studio.js",
];

let beforeAnalysis;
let afterAnalysis;
let candidateAnalysis;
let validationResult = "NOT RUN";

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
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}.\n${stdout}${stderr}`));
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
  const result = await git(["check-ignore", "-q", "model-source-backup.glb"], {
    capture: true,
    allowFailure: true,
  });
  if (result.code !== 0) {
    throw new Error("model-source-backup.glb is not excluded by .gitignore. Workflow stopped.");
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function validateSpec(filePath) {
  const result = await run(process.execPath, [GLTF_CLI, "validate", filePath], {
    capture: true,
    allowFailure: true,
  });
  if (result.code !== 0 || !/No errors found\./i.test(result.stdout)) {
    throw new Error(`glTF specification validation failed.\n${result.stdout}${result.stderr}`);
  }
  console.info("glTF specification validation: PASS");
}

async function validateComparison(sourcePath, outputPath) {
  await runNode(VALIDATOR, [sourcePath, outputPath]);
  await validateSpec(outputPath);
}

async function validateWebsite() {
  const indexHTML = await readFile(path.join(ROOT, "index.html"), "utf8");
  if (!/src=["']\.\/model\.glb["']/.test(indexHTML)) {
    throw new Error('index.html must load the model from src="./model.glb".');
  }
  if (/lightingStudio|preview-lighting-studio/i.test(indexHTML)) {
    throw new Error("The production index.html must not contain Preview Lighting Studio.");
  }

  const server = createStaticServer();
  await listen(server, 0, "127.0.0.1");
  try {
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const indexResponse = await fetch(`${baseURL}/index.html`);
    const modelResponse = await fetch(`${baseURL}/model.glb`, { method: "HEAD" });
    if (!indexResponse.ok || !modelResponse.ok) {
      throw new Error("Local static server could not serve index.html and model.glb.");
    }
    if (Number(modelResponse.headers.get("content-length")) !== (await stat(MODEL)).size) {
      throw new Error("Local server returned an unexpected model.glb byte length.");
    }
  } finally {
    await closeServer(server);
  }
  console.info("Local website validation: PASS (index.html -> ./model.glb)");
}

async function listFiles(directory, prefix = "") {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const output = [];
    for (const entry of entries) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) output.push(...await listFiles(path.join(directory, entry.name), relative));
      else if (entry.isFile()) output.push(relative);
    }
    return output;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function visualFiles() {
  const assets = (await listFiles(path.join(ROOT, "assets"), "assets")).sort();
  return [...CORE_VISUAL_FILES, ...assets];
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function visualHashes() {
  const hashes = {};
  for (const relativePath of await visualFiles()) {
    hashes[relativePath] = await hashFile(path.join(ROOT, relativePath));
  }
  return hashes;
}

function hashesFingerprint(hashes) {
  return createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
}

async function writePreviewReceipt() {
  const files = await visualHashes();
  const receipt = {
    version: 1,
    passed: true,
    validatedAt: new Date().toISOString(),
    fingerprint: hashesFingerprint(files),
    files,
    model: printableSummary(afterAnalysis),
  };
  await writeFile(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

async function verifyPreviewReceipt() {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(RECEIPT, "utf8"));
  } catch {
    throw new Error("Preview validation is missing. Run `npm run preview`, review the viewer, then stop it before deploying.");
  }
  const files = await visualHashes();
  const fingerprint = hashesFingerprint(files);
  if (receipt.version !== 1 || receipt.passed !== true || receipt.fingerprint !== fingerprint) {
    throw new Error("The model or viewer changed after the last successful preview. Run `npm run preview` again before deploying.");
  }
  console.info(`Preview validation: PASS (${receipt.validatedAt})`);
  return receipt;
}

function contentType(filePath) {
  const types = {
    ".css": "text/css; charset=utf-8",
    ".glb": "model/gltf-binary",
    ".hdr": "application/octet-stream",
    ".html": "text/html; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  return types[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function safeLocalPath(urlPath) {
  const decoded = decodeURIComponent(urlPath).replace(/^\/+/, "") || "index.html";
  const normalized = path.normalize(decoded);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) return null;
  const resolved = path.resolve(ROOT, normalized);
  return resolved.startsWith(`${path.resolve(ROOT)}${path.sep}`) ? resolved : null;
}

async function readJSONBody(request, maxBytes = 8192) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createStaticServer({ liveReloadClients, onLightingSaved } = {}) {
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (pathname === "/__preview_lighting" && request.method === "POST" && onLightingSaved) {
        const config = await onLightingSaved(await readJSONBody(request));
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
        }).end(JSON.stringify(config));
        return;
      }
      if (pathname === "/__preview_events" && liveReloadClients) {
        response.writeHead(200, {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
        });
        response.write(": connected\n\n");
        liveReloadClients.add(response);
        request.on("close", () => liveReloadClients.delete(response));
        return;
      }
      const filePath = safeLocalPath(pathname);
      if (!filePath) {
        response.writeHead(403).end();
        return;
      }
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", contentType(filePath));
      if (request.method === "HEAD") {
        response.setHeader("Content-Length", String(fileStats.size));
        response.writeHead(200).end();
      } else if (path.basename(filePath).toLowerCase() === "index.html" && liveReloadClients) {
        const html = await readFile(filePath, "utf8");
        const previewAssets = [
          '<link rel="stylesheet" href="./preview-lighting-studio.css" data-preview-only>',
          '<script type="module" src="./preview-lighting-studio.js" data-preview-only></script>',
          '<script data-preview-only>new EventSource("./__preview_events").onmessage=()=>location.reload();</script>',
        ].join("");
        const injected = html.includes("</body>")
          ? html.replace("</body>", `${previewAssets}</body>`)
          : `${html}${previewAssets}`;
        response.writeHead(200).end(injected);
      } else {
        response.setHeader("Content-Length", String(fileStats.size));
        response.writeHead(200);
        createReadStream(filePath).pipe(response);
      }
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end();
    }
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function openBrowser(url) {
  if (NO_OPEN) return;
  let command;
  let args;
  if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => console.info(`Open this URL manually: ${url}`));
    child.unref();
  } catch {
    console.info(`Open this URL manually: ${url}`);
  }
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
    resolution: texture.width && texture.height ? `${texture.width}x${texture.height}` : "unknown",
  })));
  console.error("SketchUp action required: simplify the highest-triangle furniture/components, replace detailed background assets with low-poly versions, purge unused components and materials, reuse shared materials, and reduce source texture dimensions before export.");
}

async function prepareAndValidateModel() {
  validationResult = "NOT RUN";
  await assertBackupIsIgnored();
  const hasIncomingModel = await fileExists(INCOMING_MODEL);
  const sourceModel = hasIncomingModel ? INCOMING_MODEL : MODEL;
  if (!hasIncomingModel) await access(MODEL);

  const sourceName = hasIncomingModel ? "model-new.glb" : "model.glb";
  console.info(`Found ${sourceName} (${formatMiB((await stat(sourceModel)).size)}).`);
  await copyFile(sourceModel, BACKUP);
  console.info(`Created model-source-backup.glb from ${sourceName}.`);

  beforeAnalysis = await analyzeGLB(BACKUP);
  console.info("Source analysis:", printableSummary(beforeAnalysis));
  const reasons = optimizationReasons(beforeAnalysis);
  let shouldOptimize;
  if (hasIncomingModel) {
    shouldOptimize = true;
    console.info("New SketchUp export detected; optimization is mandatory.");
  } else if (beforeAnalysis.totalBytes > GITHUB_FILE_LIMIT) {
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
      throw new Error(`Optimization produced ${formatMiB(candidateAnalysis.totalBytes)}, still over 100 MiB.`);
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
    throw new Error("Final model.glb exceeds 100 MiB.");
  }
  if (afterAnalysis.sceneTriangles !== beforeAnalysis.sceneTriangles) {
    throw new Error("Rendered triangle count changed.");
  }
  await validateWebsite();
  if (hasIncomingModel) {
    await rm(INCOMING_MODEL);
    console.info("Optimization and validation succeeded; deleted model-new.glb.");
  }
  validationResult = "PASS";
  return { beforeAnalysis, afterAnalysis };
}

async function commitAndPush(originalBytes, finalBytes) {
  await assertBackupIsIgnored();
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { capture: true })).stdout.trim();
  if (branch !== "main") throw new Error(`Deployment must run from main, not ${branch}.`);

  await git(["add", "-A"]);
  const stagedOutput = (await git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { capture: true })).stdout.trim();
  const stagedFiles = stagedOutput ? stagedOutput.split(/\r?\n/) : [];
  const forbidden = /^(?:node_modules\/|model-original\.glb$|model-new\.glb$|model-source-backup\.glb$|model-optimized\.glb$|\.preview-validation\.json$)/i;
  for (const relativePath of stagedFiles) {
    if (forbidden.test(relativePath)) throw new Error(`Forbidden deployment file was staged: ${relativePath}`);
    try {
      if ((await stat(path.join(ROOT, relativePath))).size > GITHUB_FILE_LIMIT) {
        throw new Error(`Refusing to commit file over 100 MiB: ${relativePath}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  if (stagedFiles.length) {
    await git(["commit", "-m", "Add safe preview and deployment workflow"]);
  } else {
    console.info("No file changes to commit.");
  }
  await git(["push", "origin", "main"]);
  return (await git(["remote", "get-url", "origin"], { capture: true })).stdout.trim();
}

function printSummary(title) {
  const reduction = beforeAnalysis.totalBytes
    ? (1 - afterAnalysis.totalBytes / beforeAnalysis.totalBytes) * 100
    : 0;
  console.info(`\n${title}`);
  console.info(`Original size:       ${formatMiB(beforeAnalysis.totalBytes)}`);
  console.info(`Optimized size:      ${formatMiB(afterAnalysis.totalBytes)}`);
  console.info(`Reduction:           ${reduction.toFixed(2)}%`);
  console.info(`Primitives:          ${beforeAnalysis.primitives.toLocaleString()} -> ${afterAnalysis.primitives.toLocaleString()}`);
  console.info(`Materials:           ${beforeAnalysis.materials.toLocaleString()} -> ${afterAnalysis.materials.toLocaleString()}`);
  console.info(`Rendered triangles:  ${beforeAnalysis.sceneTriangles.toLocaleString()} -> ${afterAnalysis.sceneTriangles.toLocaleString()}`);
  console.info(`Validation:          ${validationResult}`);
}

function isWatchedFile(filename) {
  if (!filename) return false;
  const relative = String(filename).replaceAll("\\", "/").replace(/^\.\//, "");
  return relative === "model-new.glb"
    || CORE_VISUAL_FILES.includes(relative)
    || relative.startsWith("assets/");
}

async function previewMain() {
  const initialLighting = await readLightingConfig(ROOT, { create: true });
  await bakeLightingIntoViewer(ROOT, initialLighting);
  await prepareAndValidateModel();
  let receipt = await writePreviewReceipt();
  printSummary("Preview validation summary");

  const clients = new Set();
  let suppressWatch = false;
  const server = createStaticServer({
    liveReloadClients: clients,
    onLightingSaved: async (value) => {
      suppressWatch = true;
      try {
        const config = await writeLightingConfig(ROOT, value);
        await bakeLightingIntoViewer(ROOT, config);
        await validateWebsite();
        receipt = await writePreviewReceipt();
        console.info("Lighting settings saved and production viewer updated.");
        return config;
      } finally {
        setTimeout(() => { suppressWatch = false; }, 1200);
      }
    },
  });
  await listen(server, PREVIEW_PORT, "127.0.0.1");
  const url = `http://localhost:${PREVIEW_PORT}`;
  console.info(`\nPreview URL: ${url}`);
  console.info("Watching model and viewer files. Press Ctrl+C to stop.");
  openBrowser(url);

  let timer;
  let rebuilding = false;
  let pending = false;
  const rebuild = async () => {
    if (rebuilding) {
      pending = true;
      return;
    }
    rebuilding = true;
    try {
      const current = hashesFingerprint(await visualHashes());
      if (current === receipt.fingerprint && !(await fileExists(INCOMING_MODEL))) return;
      console.info("\nVisual file change detected; rebuilding preview...");
      await bakeLightingIntoViewer(ROOT, await readLightingConfig(ROOT, { create: true }));
      await prepareAndValidateModel();
      receipt = await writePreviewReceipt();
      for (const client of clients) client.write("data: reload\n\n");
      console.info("Preview rebuilt and browser refresh requested.");
    } catch (error) {
      validationResult = "FAIL";
      await rm(RECEIPT, { force: true });
      console.error(`Preview rebuild failed: ${error.message}`);
      console.error("Deployment remains locked until a preview succeeds.");
    } finally {
      rebuilding = false;
      if (pending) {
        pending = false;
        void rebuild();
      }
    }
  };
  const watcher = watchFiles(ROOT, { recursive: true }, (_event, filename) => {
    if (suppressWatch || !isWatchedFile(filename)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 750);
  });

  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  clearTimeout(timer);
  watcher.close();
  for (const client of clients) client.end();
  await closeServer(server);
  console.info("Preview stopped. No commit or push was performed.");
}

async function deployMain() {
  const lighting = await readLightingConfig(ROOT, { create: true });
  await bakeLightingIntoViewer(ROOT, lighting);
  console.info("Production lighting baked from lighting-config.json.");
  await verifyPreviewReceipt();
  await prepareAndValidateModel();
  await verifyPreviewReceipt();
  const remoteURL = await commitAndPush(beforeAnalysis.totalBytes, afterAnalysis.totalBytes);
  printSummary("Deployment summary");
  console.info(`GitHub Pages:        ${githubPagesURL(remoteURL)}`);
}

try {
  if (PREVIEW_MODE) await previewMain();
  else await deployMain();
} catch (error) {
  const label = PREVIEW_MODE ? "PREVIEW STOPPED" : "DEPLOYMENT STOPPED SAFELY";
  console.error(`\n${label}\n${error.message}`);
  if (beforeAnalysis && (beforeAnalysis.totalBytes > GITHUB_FILE_LIMIT || candidateAnalysis?.totalBytes > GITHUB_FILE_LIMIT)) {
    printLargestContributors(candidateAnalysis ?? beforeAnalysis);
  }
  console.error(`Validation: ${validationResult}`);
  process.exitCode = 1;
}
