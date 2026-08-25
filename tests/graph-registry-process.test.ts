import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { GraphRunRegistry } from "../src/graph-registry.js";
import type { NodeExecutor } from "../src/graph-runtime.js";

const childStatusScript = `
  import { GraphRunRegistry } from './src/graph-registry.ts';
  const result = new GraphRunRegistry().status(process.env.OLD_RUN_ID);
  process.stdout.write(JSON.stringify(result));
`;

function runFreshProcess(runId: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", childStatusScript], {
      cwd: process.cwd(),
      env: { ...process.env, OLD_RUN_ID: runId },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const executor: NodeExecutor = {
  async execute() {
    return { ok: true, output: { finalText: "done" } };
  },
};

test("a fresh process cannot resolve a run owned by the old process-local registry", async () => {
  const registry = new GraphRunRegistry();
  const started = registry.start(
    {
      version: 1,
      id: "process-boundary",
      name: "process-boundary",
      nodes: [{ kind: "agent", id: "node", prompt: "node" }],
      edges: [],
    },
    { model: { provider: "test", modelId: "parent" }, thinking: "medium" },
    { executor, runId: "old-process-run" },
  );
  assert.equal(started.ok, true);
  assert.equal(registry.has("old-process-run"), true);

  const fresh = await runFreshProcess("old-process-run");
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.deepEqual(JSON.parse(fresh.stdout), {
    ok: false,
    error: { code: "run_not_found", message: "run old-process-run not found" },
  });
});
