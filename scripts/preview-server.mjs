import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, watch as watchFiles } from "node:fs";
import {
  access,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./glb-utils.mjs";
import {
  bakeLightingIntoViewer,
  readLightingConfig,
  writeLightingConfig,
} from "./lighting-config.mjs";
import { runKhronosValidation } from "./validate-model.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIRECTORY, "..");
const RECEIPT_NAME = ".preview-validation.json";
const VISUAL_FILES = [
  "index.html",
  "styles.css",
  "app.js",
  "sketch.css",
  "sketch-controller.js",
  "sketch-spatial-model.js",
  "lighting-config.json",
  "preview-lighting-studio.css",
  "preview-lighting-studio.js",
  "dist/current/model.glb",
  "dist/current/metadata.json",
];
const PUBLIC_ROOT_FILES = new Set([
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
]);

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

async function visualFiles(root) {
  const assets = (await listFiles(path.join(root, "assets"), "assets")).sort();
  return [...VISUAL_FILES, ...assets];
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function visualHashes(root) {
  const hashes = {};
  for (const relativePath of await visualFiles(root)) {
    hashes[relativePath] = await hashFile(path.join(root, relativePath));
  }
  return hashes;
}

function fingerprint(hashes) {
  return createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
}

export async function validatePublishedArtifact({
  root = PROJECT_ROOT,
  runSpecValidation = true,
} = {}) {
  const modelPath = path.join(root, "dist", "current", "model.glb");
  const metadataPath = path.join(root, "dist", "current", "metadata.json");
  await access(modelPath).catch(() => {
    throw new Error("Published artifact is missing. Run `npm run publish -- <source.glb>` first.");
  });
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(`Published metadata is missing or invalid: ${error.message}`);
  }
  if (metadata.schemaVersion !== 1 || metadata.validation?.passed !== true) {
    throw new Error("Published metadata does not contain a successful schemaVersion 1 validation result.");
  }
  const modelHash = await sha256File(modelPath);
  const modelStats = await stat(modelPath);
  if (metadata.output?.sha256 !== modelHash || metadata.output?.sizeBytes !== modelStats.size) {
    throw new Error("dist/current/model.glb does not match metadata.json. Publish it again.");
  }
  if (runSpecValidation) await runKhronosValidation(modelPath, { projectRoot: root });
  return { metadata, modelPath, metadataPath };
}

export async function validateProductionViewer(root = PROJECT_ROOT) {
  const html = await readFile(path.join(root, "index.html"), "utf8");
  if (!/data-default-model=["']\.\/model\.glb["']/.test(html)) {
    throw new Error('index.html must keep data-default-model="./model.glb" as its fallback.');
  }
  if (/lightingStudio|data-preview-only/i.test(html)) {
    throw new Error("Production index.html must not contain Preview Lighting Studio markup.");
  }
}

export async function writePreviewReceipt(root = PROJECT_ROOT) {
  await validatePublishedArtifact({ root, runSpecValidation: false });
  await validateProductionViewer(root);
  const files = await visualHashes(root);
  const receipt = {
    version: 2,
    passed: true,
    fingerprint: fingerprint(files),
    files,
  };
  await writeFile(
    path.join(root, RECEIPT_NAME),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  return receipt;
}

export async function verifyPreviewReceipt(root = PROJECT_ROOT) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(path.join(root, RECEIPT_NAME), "utf8"));
  } catch {
    throw new Error("Preview approval receipt is missing. Run `npm run preview` before deploying.");
  }
  const files = await visualHashes(root);
  if (receipt.version !== 2 || receipt.passed !== true || receipt.fingerprint !== fingerprint(files)) {
    throw new Error("Published artifact or viewer changed after preview. Run `npm run preview` again.");
  }
  return receipt;
}

function contentType(filePath) {
  const types = {
    ".css": "text/css; charset=utf-8",
    ".glb": "model/gltf-binary",
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

function safePublicPath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath).replace(/^\/+/, "") || "index.html";
  } catch {
    return null;
  }
  const relative = decoded.replaceAll("\\", "/");
  const allowed = PUBLIC_ROOT_FILES.has(relative)
    || relative.startsWith("assets/")
    || relative === "dist/current/model.glb"
    || relative === "dist/current/metadata.json";
  if (!allowed) return null;
  const resolved = path.resolve(root, relative);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  return resolved.startsWith(rootPrefix) ? resolved : null;
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

export function createStaticServer({
  root = PROJECT_ROOT,
  preview = false,
  liveReloadClients = null,
  onLightingSaved = null,
} = {}) {
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (preview && pathname === "/__preview_lighting" && request.method === "POST") {
        if (!onLightingSaved) throw new Error("Lighting save handler is unavailable.");
        const config = await onLightingSaved(await readJSONBody(request));
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
        }).end(JSON.stringify(config));
        return;
      }
      if (preview && pathname === "/__preview_events" && liveReloadClients) {
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
      const filePath = safePublicPath(root, pathname);
      if (!filePath) {
        response.writeHead(404).end();
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
      } else if (preview && path.basename(filePath).toLowerCase() === "index.html") {
        const html = await readFile(filePath, "utf8");
        const previewAssets = [
          '<link rel="stylesheet" href="./preview-lighting-studio.css" data-preview-only>',
          '<script type="module" src="./preview-lighting-studio.js" data-preview-only></script>',
          '<script data-preview-only>new EventSource("./__preview_events").onmessage=()=>location.reload();</script>',
        ].join("");
        response.writeHead(200).end(html.replace("</body>", `${previewAssets}</body>`));
      } else {
        response.setHeader("Content-Length", String(fileStats.size));
        response.writeHead(200);
        createReadStream(filePath).pipe(response);
      }
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end(error.message ?? "Server error");
    }
  });
}

export function listen(server, port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

export function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function openBrowser(url, noOpen) {
  if (noOpen) return;
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

function isWatchedFile(filename) {
  if (!filename) return false;
  const relative = String(filename).replaceAll("\\", "/").replace(/^\.\//, "");
  return VISUAL_FILES.includes(relative) || relative.startsWith("assets/");
}

export async function startPreview({
  root = PROJECT_ROOT,
  port = Number(process.env.PREVIEW_PORT || 8000),
  noOpen = false,
} = {}) {
  await validatePublishedArtifact({ root });
  await bakeLightingIntoViewer(root, await readLightingConfig(root, { create: true }));
  let receipt = await writePreviewReceipt(root);
  const clients = new Set();
  let suppressWatch = false;
  const server = createStaticServer({
    root,
    preview: true,
    liveReloadClients: clients,
    onLightingSaved: async (value) => {
      suppressWatch = true;
      try {
        const config = await writeLightingConfig(root, value);
        await bakeLightingIntoViewer(root, config);
        receipt = await writePreviewReceipt(root);
        console.info("Lighting saved; published GLB was not modified.");
        return config;
      } finally {
        setTimeout(() => { suppressWatch = false; }, 1200);
      }
    },
  });
  await listen(server, port);
  const url = `http://localhost:${port}/?model=./dist/current/model.glb`;
  console.info(`\nPreview URL: ${url}`);
  console.info("Serving dist/current. Press Ctrl+C to stop.");
  openBrowser(url, noOpen);

  let timer;
  let checking = false;
  let pending = false;
  const refresh = async () => {
    if (checking) {
      pending = true;
      return;
    }
    checking = true;
    try {
      const current = fingerprint(await visualHashes(root));
      if (current === receipt.fingerprint) return;
      await validatePublishedArtifact({ root, runSpecValidation: false });
      await validateProductionViewer(root);
      receipt = await writePreviewReceipt(root);
      for (const client of clients) client.write("data: reload\n\n");
      console.info("Published artifact/viewer changed; browser refresh requested.");
    } catch (error) {
      await rm(path.join(root, RECEIPT_NAME), { force: true });
      console.error(`Preview validation failed: ${error.message}`);
    } finally {
      checking = false;
      if (pending) {
        pending = false;
        void refresh();
      }
    }
  };
  const watcher = watchFiles(root, { recursive: true }, (_event, filename) => {
    if (suppressWatch || !isWatchedFile(filename)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 500);
  });

  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  clearTimeout(timer);
  watcher.close();
  for (const client of clients) client.end();
  await closeServer(server);
  console.info("Preview stopped. No optimization, source mutation, commit, or push was performed.");
}

const isCLI = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCLI) {
  try {
    await startPreview({ noOpen: process.argv.includes("--no-open") });
  } catch (error) {
    console.error(`\nPREVIEW STOPPED\n${error.message}`);
    process.exitCode = 1;
  }
}
