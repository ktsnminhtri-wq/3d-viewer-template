import { randomUUID } from "node:crypto";
import { copyFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GITHUB_FILE_LIMIT } from "./glb-utils.mjs";
import { bakeLightingIntoViewer, readLightingConfig } from "./lighting-config.mjs";
import {
  closeServer,
  createStaticServer,
  listen,
  validateProductionViewer,
  validatePublishedArtifact,
  verifyPreviewReceipt,
} from "./preview-server.mjs";
import { runKhronosValidation } from "./validate-model.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED_MODEL = path.join(ROOT, "dist", "current", "model.glb");
const PRODUCTION_MODEL = path.join(ROOT, "model.glb");
const PUBLISHED_MODEL_GIT_PATH = "dist/current/model.glb";
const PUBLISHED_METADATA_GIT_PATH = "dist/current/metadata.json";
const DEPLOY_PATHS = [
  ".gitignore",
  "AGENTS.md",
  "README.md",
  "package.json",
  "package-lock.json",
  "index.html",
  "styles.css",
  "app.js",
  "sketch.css",
  "sketch-controller.js",
  "sketch-spatial-model.js",
  "lighting-config.json",
  "preview-lighting-studio.css",
  "preview-lighting-studio.js",
  "model.glb",
  PUBLISHED_MODEL_GIT_PATH,
  PUBLISHED_METADATA_GIT_PATH,
  "assets/spruit-sunrise-1k-hdr.jpg",
  "scripts/deploy-model.mjs",
  "scripts/glb-utils.mjs",
  "scripts/lighting-config.mjs",
  "scripts/optimize-model.mjs",
  "scripts/preview-server.mjs",
  "scripts/publish-model.mjs",
  "scripts/publisher-core.mjs",
  "scripts/publisher-profile.mjs",
  "scripts/validate-model.mjs",
];

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
      else reject(new Error(`${command} ${args.join(" ")} failed.\n${stdout}${stderr}`));
    });
  });
}

function git(args, options) {
  return run("git", args, options);
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

async function installProductionModel() {
  const token = randomUUID();
  const nextPath = path.join(ROOT, `.deploy-next-${token}.glb`);
  const previousPath = path.join(ROOT, `.deploy-previous-${token}.glb`);
  let hadPrevious = false;
  await copyFile(PUBLISHED_MODEL, nextPath);
  try {
    try {
      await rename(PRODUCTION_MODEL, previousPath);
      hadPrevious = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(nextPath, PRODUCTION_MODEL);
  } catch (error) {
    await rm(nextPath, { force: true });
    if (hadPrevious) await rename(previousPath, PRODUCTION_MODEL);
    throw error;
  }
  return {
    commit: () => rm(previousPath, { force: true }),
    rollback: async () => {
      await rm(PRODUCTION_MODEL, { force: true });
      if (hadPrevious) await rename(previousPath, PRODUCTION_MODEL);
    },
  };
}

async function validateLocalProduction(metadata) {
  await validateProductionViewer(ROOT);
  await runKhronosValidation(PRODUCTION_MODEL, { projectRoot: ROOT });
  const server = createStaticServer({ root: ROOT, preview: false });
  await listen(server, 0);
  try {
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const version = metadata.output.sha256.slice(0, 12);
    const [indexResponse, appResponse, modelResponse, publishedModelResponse, metadataResponse] = await Promise.all([
      fetch(`${baseURL}/?model=./dist/current/model.glb&v=${version}`),
      fetch(`${baseURL}/app.js`),
      fetch(`${baseURL}/model.glb`, { method: "HEAD" }),
      fetch(`${baseURL}/dist/current/model.glb`, { method: "HEAD" }),
      fetch(`${baseURL}/dist/current/metadata.json`),
    ]);
    if (!indexResponse.ok || !appResponse.ok || !modelResponse.ok
      || !publishedModelResponse.ok || !metadataResponse.ok) {
      throw new Error("Local production server could not serve the viewer and published artifact.");
    }
    if (Number(modelResponse.headers.get("content-length")) !== (await stat(PRODUCTION_MODEL)).size) {
      throw new Error("Local production model byte length is incorrect.");
    }
    if (Number(publishedModelResponse.headers.get("content-length")) !== metadata.output.sizeBytes) {
      throw new Error("Published model byte length is incorrect.");
    }
    const servedMetadata = await metadataResponse.json();
    if (servedMetadata.validation?.passed !== true
      || servedMetadata.output?.sha256 !== metadata.output.sha256) {
      throw new Error("Published metadata served by the website is invalid.");
    }
    if (!(await appResponse.text()).includes('search.get("v")')) {
      throw new Error("Viewer cache-busting support is missing.");
    }
  } finally {
    await closeServer(server);
  }
}

async function listStagedFiles() {
  const output = (await git([
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMRD",
  ], { capture: true })).stdout.trim();
  return output ? output.split(/\r?\n/) : [];
}

async function assertGitReadyForDeployment() {
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { capture: true })).stdout.trim();
  if (branch !== "main") throw new Error(`GitHub deployment must run from main, not ${branch}.`);
  const alreadyStaged = await listStagedFiles();
  if (alreadyStaged.length) {
    throw new Error(`Deployment found pre-staged Git changes: ${alreadyStaged.join(", ")}. Commit or unstage them first.`);
  }
}

async function commitAndPush() {
  await assertGitReadyForDeployment();
  await git(["add", "-A", "--", ...DEPLOY_PATHS]);
  const stagedFiles = await listStagedFiles();
  const allowedPublishedFiles = new Set([PUBLISHED_MODEL_GIT_PATH, PUBLISHED_METADATA_GIT_PATH]);
  const forbidden = /^(?:node_modules\/|model-original\.glb$|model-new\.glb$|model-source-backup\.glb$|model-optimized\.glb$|\.preview-validation\.json$|\.deploy-)/i;
  for (const relativePath of stagedFiles) {
    if (forbidden.test(relativePath)
      || (relativePath.startsWith("dist/") && !allowedPublishedFiles.has(relativePath))) {
      throw new Error(`Forbidden deployment file was staged: ${relativePath}`);
    }
    try {
      if ((await stat(path.join(ROOT, relativePath))).size > GITHUB_FILE_LIMIT) {
        throw new Error(`Refusing to commit a file over 100 MiB: ${relativePath}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (stagedFiles.length) {
    await git(["commit", "-m", "Publish validated GLB artifact"]);
  } else {
    console.info("No deployment changes to commit.");
  }
  await git(["push", "origin", "main"]);
  return (await git(["remote", "get-url", "origin"], { capture: true })).stdout.trim();
}

async function main() {
  await assertGitReadyForDeployment();
  const { metadata } = await validatePublishedArtifact({ root: ROOT });
  if (metadata.output.sizeBytes > GITHUB_FILE_LIMIT) {
    throw new Error("Published model exceeds GitHub's 100 MiB file limit.");
  }
  await verifyPreviewReceipt(ROOT);
  await bakeLightingIntoViewer(ROOT, await readLightingConfig(ROOT, { create: true }));
  await verifyPreviewReceipt(ROOT);

  const installation = await installProductionModel();
  try {
    await validateLocalProduction(metadata);
    await installation.commit();
  } catch (error) {
    await installation.rollback();
    throw error;
  }

  const remoteURL = await commitAndPush();
  const pagesURL = githubPagesURL(remoteURL);
  const version = metadata.output.sha256.slice(0, 12);
  console.info("\nDeployment completed from dist/current.");
  console.info(`Model size:   ${(metadata.output.sizeBytes / (1024 * 1024)).toFixed(2)} MiB`);
  console.info(`Model SHA:    ${metadata.output.sha256}`);
  console.info(`Viewer:       ${pagesURL}?model=./dist/current/model.glb&v=${version}`);
  console.info(`Model:        ${pagesURL}dist/current/model.glb?v=${version}`);
  console.info(`Metadata:     ${pagesURL}dist/current/metadata.json?v=${version}`);
}

try {
  await main();
} catch (error) {
  console.error(`\nDEPLOYMENT STOPPED SAFELY\n${error.message}`);
  process.exitCode = 1;
}
