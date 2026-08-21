import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as root from "../dist/index.js";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  readonly exports: Record<string, unknown>;
};

test("built root exports preserve graph APIs and remove imperative APIs", () => {
  assert.equal(typeof root.createWorkflowGraphTool, "function");
  assert.equal(typeof root.createStructuredOutputTool, "function");
  assert.equal("createWorkflowTool" in root, false);
  assert.equal("runWorkflow" in root, false);
  assert.equal("WorkflowAgent" in root, false);
  assert.equal("createWorkflowSnapshot" in root, false);
  assert.equal("renderWorkflowText" in root, false);
});

test("package exports preserve workflow_graph and remove the workflow subpath", () => {
  assert.equal("./workflow" in packageJson.exports, false);
  assert.ok("./workflow-graph" in packageJson.exports);
  assert.ok("." in packageJson.exports);
});
