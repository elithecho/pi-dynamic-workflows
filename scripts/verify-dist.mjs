import { access } from "node:fs/promises";
import { resolve } from "node:path";

const required = ["dist/index.js", "dist/index.d.ts"];
const stale = [
  "dist/workflow.js",
  "dist/workflow-tool.js",
  "dist/workflow-tool.d.ts",
  "dist/agent.js",
  "dist/agent.d.ts",
  "dist/display.js",
  "dist/display.d.ts",
];

for (const relativePath of required) {
  await access(resolve(relativePath));
}

const present = [];
for (const relativePath of stale) {
  try {
    await access(resolve(relativePath));
    present.push(relativePath);
  } catch {
    // The assertion is that these removed legacy artifacts are absent.
  }
}

if (present.length > 0) {
  throw new Error(`dist contains removed legacy artifacts: ${present.join(", ")}`);
}

console.log("dist verification passed: no legacy workflow artifacts");
