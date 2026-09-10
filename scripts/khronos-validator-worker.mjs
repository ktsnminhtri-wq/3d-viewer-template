import { readFile } from "node:fs/promises";
import path from "node:path";
import validator from "gltf-validator";

const filePath = process.argv[2] ? path.resolve(process.argv[2]) : null;

if (!filePath) {
  console.error("Missing GLB path.");
  process.exitCode = 1;
} else {
  try {
    const bytes = await readFile(filePath);
    const report = await validator.validateBytes(new Uint8Array(bytes), {
      maxIssues: 100,
      writeTimestamp: false,
      externalResourceFunction: async (uri) => readFile(
        path.resolve(path.dirname(filePath), decodeURIComponent(uri)),
      ),
    });
    const issues = report.issues || {};
    const summary = {
      numErrors: issues.numErrors || 0,
      numWarnings: issues.numWarnings || 0,
      numInfos: issues.numInfos || 0,
      numHints: issues.numHints || 0,
      truncated: Boolean(issues.truncated),
      messages: (issues.messages || []).slice(0, 100),
    };
    process.stdout.write(JSON.stringify(summary));
    if (summary.numErrors > 0) process.exitCode = 2;
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  }
}
