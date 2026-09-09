import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishModel } from "./publisher-core.mjs";

const isCLI = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCLI) {
  try {
    await publishModel(process.argv[2]);
  } catch (error) {
    console.error(`\nPUBLISH FAILED\n${error.message}`);
    process.exitCode = 1;
  }
}
