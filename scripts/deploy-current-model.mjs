import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { fileURLToPath } from "node:url";
import { deployModel } from "./deploy-model.mjs";
import { writePreviewReceipt } from "./preview-server.mjs";
import {
  openURL,
  printMetadataSummary,
  publishQuietly,
  reportWorkflowError,
  validateSourceArgument,
  waitForPublishedSHA,
} from "./one-click-workflow.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const LOG_PATH = process.env.DEPLOY_MODEL_LOG
  ? path.resolve(process.env.DEPLOY_MODEL_LOG)
  : path.join(PROJECT_ROOT, "logs", "deploy-model-last.log");

function installDiagnosticLogger() {
  mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  if (!process.env.DEPLOY_MODEL_LOG) writeFileSync(LOG_PATH, "", "utf8");
  appendFileSync(LOG_PATH, [
    "",
    `Node timestamp: ${new Date().toISOString()}`,
    `Received file: ${process.argv[2] ?? "<none>"}`,
    `Repo path: ${PROJECT_ROOT}`,
    `Node version: ${process.version}`,
    `Node executable: ${process.execPath}`,
    `Current directory: ${process.cwd()}`,
    `Command arguments: ${JSON.stringify(process.argv)}`,
    "",
  ].join("\n"), "utf8");
  for (const method of ["log", "info", "warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      appendFileSync(LOG_PATH, `[${method.toUpperCase()}] ${format(...args)}\n`, "utf8");
    };
  }
}

installDiagnosticLogger();

function safeCommitSubject(value) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
}

async function main() {
  const sourcePath = await validateSourceArgument(process.argv[2]);
  const flags = new Set(process.argv.slice(3));
  const dryRun = flags.has("--dry-run");
  const noOpen = flags.has("--no-open") || process.env.ONE_CLICK_NO_OPEN === "1";

  console.info("[1/4] Publishing model...");
  const { metadata } = await publishQuietly(sourcePath);

  console.info("[2/4] Validation passed.\n");
  printMetadataSummary(metadata);

  // A one-click deploy has no long-running preview session. Generate the same
  // deterministic validation receipt after publish so the safe deploy adapter
  // can prove that the artifact and production viewer still match.
  await writePreviewReceipt();

  console.info(dryRun
    ? "\n[3/4] Validating GitHub deployment (dry run)..."
    : "\n[3/4] Deploying to GitHub...");
  const shortSHA = metadata.output.sha256.slice(0, 12);
  const commitMessage = safeCommitSubject(`Publish ${path.basename(sourcePath)} (${shortSHA})`);
  const result = await deployModel({
    artifactOnly: false,
    commitMessage,
    dryRun,
  });

  console.info(dryRun ? "[4/4] Dry run passed. No commit or push was made." : "[4/4] Done.");
  console.info(`\nViewer:   ${result.viewerURL}`);
  console.info(`Model:    ${result.modelURL}`);
  console.info(`Metadata: ${result.metadataURL}`);

  if (dryRun) return;

  console.info("\nGitHub Pages may need a short time to update.");
  if (noOpen) return;
  const ready = await waitForPublishedSHA(result.metadataURL, metadata.output.sha256);
  if (ready) {
    if (!openURL(result.viewerURL)) console.info(`Open this URL manually: ${result.viewerURL}`);
  } else {
    console.info("GitHub Pages is still updating. Open the Viewer URL above after about one minute.");
  }
}

try {
  await main();
  console.info("Node exit code: 0");
} catch (error) {
  reportWorkflowError("DEPLOY STOPPED SAFELY", error);
  console.error(error.stack ?? String(error));
  console.error("Node exit code: 1");
  process.exitCode = 1;
}
