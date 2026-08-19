/**
 * Graph-1 registry tests: process-local run registry over the pure runtime.
 *
 * A tiny two-node graph (a -> b) runs through a fake executor that records
 * calls and optionally defers completion. Parents are normally guaranteed by
 * the tool adapter; the missing-parent test intentionally violates that to
 * verify the engine's construction guard surfaces as an operation error.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  GraphContractError,
  type GraphSpec,
  type InvokingParentExecutionContext,
  type ModelRegistryLike,
} from "../src/graph.js";
import { GraphRunRegistry } from "../src/graph-registry.js";
import type { NodeExecutionRequest, NodeExecutor } from "../src/graph-runtime.js";

const parent: InvokingParentExecutionContext = {
  model: { provider: "test", modelId: "m" },
  thinking: "medium",
};

const modelRegistry: ModelRegistryLike = { find: () => ({ id: "m" }) };

function chainedGraph(): GraphSpec {
  return {
    version: 1,
    id: "chain",
    name: "two chained agents",
    nodes: [
      { kind: "agent", id: "a", prompt: "First." },
      { kind: "agent", id: "b", prompt: "Second." },
    ],
    edges: [{ id: "a-b", from: "a", to: "b" }],
  };
}

interface RecordedCall {
  readonly nodeId: string;
  readonly attempt: number;
  readonly inputs: NodeExecutionRequest["inputArtifacts"];
}

interface FakeExecutorOptions {
  /** nodeId -> finalText; missing nodes resolve with an empty finalText. */
  readonly finalText?: Readonly<Record<string, string>>;
  /** Called before resolving; returning a never-settling promise defers the node. */
  readonly defer?: (nodeId: string) => Promise<void>;
}

function createExecutor(options: FakeExecutorOptions = {}): NodeExecutor & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async execute(request: NodeExecutionRequest) {
      calls.push({ nodeId: request.node.id, attempt: request.attempt, inputs: request.inputArtifacts });
      await options.defer?.(request.node.id);
      return { ok: true, output: { finalText: options.finalText?.[request.node.id] ?? "" } };
    },
  };
}

const forever = new Promise<void>(() => {});
const noop = (): Promise<void> => forever;

test("start stores the run and returns running without waiting for node completion", async () => {
  const registry = new GraphRunRegistry();
  const executor = createExecutor({ defer: noop });
  // `start` returns synchronously; were it awaiting completion it could never
  // return while the executor defers the first node forever.
  const result = registry.start(chainedGraph(), parent, { executor });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const runId = result.result.runId;
  assert.equal(result.result.state, "running");
  assert.equal(registry.has(runId), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    executor.calls.map((call) => call.nodeId),
    ["a"],
  );
  const status = registry.status(runId);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.result.run.state, "running");
});

test("status observes the started run", async () => {
  const registry = new GraphRunRegistry();
  const result = registry.start(chainedGraph(), parent, { executor: createExecutor(), modelRegistry });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const runId = result.result.runId;
  const first = registry.status(runId);
  const second = registry.status(runId);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(first.result.run.runId, runId);
    assert.equal(second.result.run.runId, runId);
  }
  await registry.wait(runId);
});

test("wait resolves completed with a terminal snapshot", async () => {
  const registry = new GraphRunRegistry();
  const result = registry.start(chainedGraph(), parent, {
    executor: createExecutor({ finalText: { a: "ok", b: "ok" } }),
    modelRegistry,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const waited = await registry.wait(result.result.runId);
  assert.equal(waited.ok, true);
  if (!waited.ok) throw new Error("unreachable");
  assert.equal(waited.result.completed, true);
  assert.equal(waited.result.run.state, "succeeded");
});

test("wait with a timeout reports an incomplete run that is still running", async () => {
  const registry = new GraphRunRegistry();
  const result = registry.start(chainedGraph(), parent, { executor: createExecutor({ defer: noop }) });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  // The deferred node never settles, so the timeout always wins.
  const waited = await registry.wait(result.result.runId, 5);
  assert.equal(waited.ok, true);
  if (!waited.ok) throw new Error("unreachable");
  assert.equal(waited.result.completed, false);
  assert.equal(waited.result.run.state, "running");
});

test("cancel transitions the run and blocks further admission", async () => {
  const registry = new GraphRunRegistry();
  const executor = createExecutor({ defer: noop });
  const result = registry.start(chainedGraph(), parent, { executor });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const runId = result.result.runId;
  await new Promise((resolve) => setTimeout(resolve, 10)); // let node a be admitted
  assert.deepEqual(
    executor.calls.map((call) => call.nodeId),
    ["a"],
  );
  const cancelled = registry.cancel(runId);
  assert.equal(cancelled.ok, true);
  if (!cancelled.ok) throw new Error("unreachable");
  const cancellation = cancelled.result;
  assert.equal(cancellation.accepted, true);
  if (!cancellation.accepted) throw new Error("unreachable");
  assert.equal(cancellation.run.state, "cancelled");
  assert.ok(cancellation.run.nodes.every((node) => node.state !== "running"));
  const again = registry.cancel(runId);
  assert.equal(again.ok, true);
  if (!again.ok) throw new Error("unreachable");
  const rejection = again.result;
  assert.equal(rejection.accepted, false);
  if (rejection.accepted) throw new Error("unreachable");
  assert.equal(rejection.error.code, "cancel_rejected");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    executor.calls.every((call) => call.nodeId === "a"),
    "node b must never be admitted",
  );
  const snapshot = registry.snapshot(runId);
  if (snapshot === undefined) throw new Error("unreachable: cancelled run snapshot missing");
  assert.ok(snapshot.nodes.every((node) => node.state !== "running"));
});

test("unknown runs report run_not_found", async () => {
  const registry = new GraphRunRegistry();
  assert.equal(registry.has("missing"), false);
  assert.equal(registry.snapshot("missing"), undefined);
  assert.deepEqual(registry.status("missing"), {
    ok: false,
    error: { code: "run_not_found", message: "run missing not found" },
  });
  assert.deepEqual(await registry.wait("missing"), {
    ok: false,
    error: { code: "run_not_found", message: "run missing not found" },
  });
  assert.deepEqual(registry.cancel("missing"), {
    ok: false,
    error: { code: "run_not_found", message: "run missing not found" },
  });
});

test("start with an invalid graph input returns invalid_graph without throwing", () => {
  const registry = new GraphRunRegistry();
  const result = registry.start("not a graph", parent, { executor: createExecutor() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.error.code, "invalid_graph");
  assert.ok(result.error.message.length > 0);
});

test("registry retains completed runs", async () => {
  const registry = new GraphRunRegistry();
  const result = registry.start(chainedGraph(), parent, { executor: createExecutor(), modelRegistry });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const runId = result.result.runId;
  const waited = await registry.wait(runId);
  assert.equal(waited.ok, true);
  if (!waited.ok) throw new Error("unreachable");
  assert.equal(waited.result.completed, true);
  assert.equal(waited.result.run.state, "succeeded");
  const snapshot = registry.snapshot(runId);
  if (snapshot === undefined) throw new Error("unreachable: completed run snapshot missing");
  assert.equal(snapshot.state, "succeeded");
  const status = registry.status(runId);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.result.run.state, "succeeded");
  assert.equal(registry.has(runId), true);
});

test("start without a parent model returns missing_parent_model", () => {
  const registry = new GraphRunRegistry();
  // Parents are normally guaranteed by the tool adapter; this exercises the
  // engine's resolveExecutionContext guard during handle construction.
  const badParent = { model: undefined as any, thinking: undefined as any };
  const result = registry.start(chainedGraph(), badParent, { executor: createExecutor(), modelRegistry });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.error.code, "missing_parent_model");
  // The registry passes the contract error's code and message through.
  assert.equal(
    result.error.message,
    new GraphContractError("missing_parent_model", "invoking parent model is required").message,
  );
});
