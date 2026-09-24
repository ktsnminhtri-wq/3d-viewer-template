import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { fileURLToPath } from "node:url";
import { startPreview } from "./preview-server.mjs";
import {
  printMetadataSummary,
  publishQuietly,
  reportWorkflowError,
  validateSourceArgument,
} from "./one-click-workflow.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const LOG_PATH = process.env.TEST_MODEL_LOG
  ? path.resolve(process.env.TEST_MODEL_LOG)
  : path.join(PROJECT_ROOT, "logs", "test-model-last.log");

function installDiagnosticLogger() {
  mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  if (!process.env.TEST_MODEL_LOG) writeFileSync(LOG_PATH, "", "utf8");
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

async function main() {
  const sourcePath = await validateSourceArgument(process.argv[2]);
  const flags = new Set(process.argv.slice(3));

  console.info("[1/3] Publishing...");
  const { metadata } = await publishQuietly(sourcePath);

  console.info("[2/3] Validation passed.\n");
  printMetadataSummary(metadata);

  if (flags.has("--publish-only") || process.env.ONE_CLICK_PUBLISH_ONLY === "1") return;

  console.info("\n[3/3] Starting preview...");
  console.info("Local viewer:");
  console.info("http://localhost:8000/?model=./dist/current/model.glb");
  console.info("Press Ctrl+C to stop preview.");
  try {
    await startPreview({
      noOpen: flags.has("--no-open") || process.env.ONE_CLICK_NO_OPEN === "1",
    });
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      throw new Error(
        "Port 8000 đang được sử dụng. Hãy dừng cửa sổ preview cũ bằng Ctrl+C rồi thử lại. Không có process nào bị tự động tắt.",
      );
    }
    throw error;
  }
}

try {
  await main();
  console.info("Node exit code: 0");
} catch (error) {
  reportWorkflowError("TEST STOPPED SAFELY", error);
  console.error(error.stack ?? String(error));
  console.error("Node exit code: 1");
  process.exitCode = 1;
}
