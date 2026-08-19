/**
 * Graph-1 runtime tests: pure graph execution with fake executors.
 *
 * No Pi sessions, no network: every agent node runs through {@link FakeExecutor}
 * so the engine's scheduling, routing, joins, retries, skips, cancellation,
 * concurrency, budgets, artifacts, and lifecycle events are exercised
 * deterministically.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type GraphRunHandle,
  type NodeExecutor,
  type NodeExecutorResult,
  type RoutedArtifact,
  runGraph,
  startGraphRun,
} from "../src/graph-runtime.js";
import {
  GraphContractError,
  type GraphLifecycleEvent,
  type GraphRunSnapshot,
  type GraphSpec,
  type GraphWaitResult,
  type JsonValue,
  type NodeExecutionRequest,
  type NodeSnapshot,
  type Usage,
} from "../src/index.js";

const parent = { model: { provider: "test", modelId: "parent" }, thinking: "medium" as const };

function reviewGraph(): GraphSpec {
  return {
    version: 1,
    id: "review",
    name: "staged review",
    defaults: { model: parent.model, thinking: parent.thinking },
    nodes: [
      { kind: "agent", id: "implementation", prompt: "Implement the change." },
      { kind: "agent", id: "review-1", prompt: "Review the implementation." },
      { kind: "agent", id: "remediation", prompt: "Address the review." },
      { kind: "agent", id: "review-2", prompt: "Review the remediation." },
      { kind: "deterministic", id: "final-verification", operation: "join" },
    ],
    edges: [
      { id: "implementation-review", from: "implementation", to: "review-1" },
      {
        id: "review-pass",
        from: "review-1",
        to: "final-verification",
        route: {
          kind: "predicate",
          predicate: {
            type: "finalText",
            regex: { source: "finalText", pattern: "<verdict>\\s*pass\\s*</verdict>" },
          },
        },
      },
      { id: "review-remediation", from: "review-1", to: "remediation", route: { kind: "otherwise" } },
      { id: "remediation-review", from: "remediation", to: "review-2" },
      { id: "review-2-final", from: "review-2", to: "final-verification" },
    ],
    budgets: { maxConcurrency: 2, maxAttempts: 4 },
  };
}

interface FakeOutcome {
  readonly finalText?: string;
  readonly structuredOutput?: JsonValue;
  readonly usage?: Usage;
  readonly error?: string;
}

interface FakeExecutorOptions {
  /** nodeId → outcome. Missing nodes resolve with an empty finalText. */
  outcomes?: Record<string, FakeOutcome>;
  /** nodeId → number of initial failures before succeeding. */
  failFirst?: Record<string, number>;
  /** nodeId → make every execution never settle (for cancellation). */
  pending?: ReadonlySet<string>;
  /** Artificial per-execution delay before resolving. */
  delayMs?: number;
  onStart?: (request: NodeExecutionRequest) => void;
}

class FakeExecutor implements NodeExecutor {
  readonly received = new Map<string, readonly RoutedArtifact[]>();
  readonly attempts = new Map<string, number>();
  readonly startOrder: string[] = [];
  readonly concurrentInFlight = { max: 0, current: 0 };
  calls = 0;
  readonly failures = new Map<string, number>();

  private readonly outcomes: Record<string, FakeOutcome>;
  private readonly failFirst: Record<string, number>;
  private readonly pending: ReadonlySet<string>;
  private readonly delayMs: number;
  private readonly onStart?: (request: NodeExecutionRequest) => void;

  constructor(options: FakeExecutorOptions = {}) {
    this.outcomes = options.outcomes ?? {};
    this.failFirst = options.failFirst ?? {};
    this.pending = options.pending ?? new Set();
    this.delayMs = options.delayMs ?? 0;
    this.onStart = options.onStart;
  }

  async execute(request: NodeExecutionRequest): Promise<NodeExecutorResult> {
    this.calls += 1;
    const nodeId = request.node.id;
    this.received.set(nodeId, request.inputArtifacts);
    this.attempts.set(nodeId, (this.attempts.get(nodeId) ?? 0) + 1);
    this.startOrder.push(nodeId);
    this.concurrentInFlight.current += 1;
    this.concurrentInFlight.max = Math.max(this.concurrentInFlight.max, this.concurrentInFlight.current);
    this.onStart?.(request);
    if (this.pending.has(nodeId)) {
      // Never settles; the engine races this against its abort signal.
      return new Promise<NodeExecutorResult>(() => {});
    }
    const failedSoFar = this.failures.get(nodeId) ?? 0;
    this.failures.set(nodeId, failedSoFar + 1);
    const willFail = failedSoFar < (this.failFirst[nodeId] ?? 0);
    const outcome = this.outcomes[nodeId] ?? { finalText: `${nodeId} done` };
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.concurrentInFlight.current -= 1;
    if (willFail) {
      return { ok: false, error: { code: "invalid_state", message: outcome.error ?? "fake failure", nodeId } };
    }
    return {
      ok: true,
      output: {
        finalText: outcome.finalText ?? `${nodeId} done`,
        ...(outcome.structuredOutput !== undefined ? { structuredOutput: outcome.structuredOutput } : {}),
      },
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
    };
  }
}

function nodeIn(snapshot: GraphRunSnapshot, nodeId: string): NodeSnapshot | undefined {
  return snapshot.nodes.find((node) => node.id === nodeId);
}

function nodeState(snapshot: GraphRunSnapshot, nodeId: string): NodeSnapshot["state"] | undefined {
  return nodeIn(snapshot, nodeId)?.state;
}

function skipReason(snapshot: GraphRunSnapshot, nodeId: string) {
  return nodeIn(snapshot, nodeId)?.skipReason;
}

function handleNodeState(handle: GraphRunHandle, nodeId: string): NodeSnapshot["state"] | undefined {
  return handle.snapshot().nodes.find((node) => node.id === nodeId)?.state;
}

async function waitUntilNodeState(handle: GraphRunHandle, nodeId: string, state: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (handleNodeState(handle, nodeId) === state) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`node ${nodeId} never reached ${state}`);
}

test("pass path: review-1 verdict pass skips remediation and review-2, final join runs", async () => {
  const graph = reviewGraph();
  const executor = new FakeExecutor({
    outcomes: {
      implementation: { finalText: "implemented" },
      "review-1": { finalText: "<verdict>pass</verdict>" },
    },
  });
  const snapshot = await runGraph(graph, { executor, parentContext: parent });
  assert.equal(snapshot.state, "succeeded");
  assert.equal(executor.calls, 2, "only implementation and review-1 run");
  assert.equal(nodeState(snapshot, "implementation"), "succeeded");
  assert.equal(nodeState(snapshot, "review-1"), "succeeded");
  assert.equal(nodeState(snapshot, "remediation"), "skipped");
  assert.equal(skipReason(snapshot, "remediation"), "route_not_selected");
  assert.equal(nodeState(snapshot, "review-2"), "skipped");
  assert.equal(skipReason(snapshot, "review-2"), "route_not_selected");
  assert.equal(nodeState(snapshot, "final-verification"), "succeeded");
  // Skipped nodes stay visible in the snapshot with reasons.
  const skipped = snapshot.nodes.filter((node) => node.state === "skipped");
  assert.equal(skipped.length, 2);
});

test("no-match path: remediation receives review-1 finalText, review-2 runs, join succeeds", async () => {
  const graph = reviewGraph();
  const executor = new FakeExecutor({
    outcomes: {
      implementation: { finalText: "implemented" },
      "review-1": { finalText: "<verdict>fail</verdict>" },
      remediation: { finalText: "revised" },
      "review-2": { finalText: "<verdict>pass</verdict>" },
    },
  });
  const snapshot = await runGraph(graph, { executor, parentContext: parent });
  assert.equal(snapshot.state, "succeeded");
  assert.equal(executor.calls, 4, "all four agents run on the non-pass route");
  assert.equal(nodeState(snapshot, "remediation"), "succeeded");
  assert.equal(nodeState(snapshot, "review-2"), "succeeded");
  assert.equal(nodeState(snapshot, "final-verification"), "succeeded");
});

test("malformed regex and invalid graphs fail validation before any executor call", async () => {
  const graph = reviewGraph();
  const bad = {
    ...graph,
    edges: graph.edges.map((edge) =>
      edge.id === "review-pass"
        ? {
            ...edge,
            route: {
              kind: "predicate" as const,
              predicate: { type: "finalText" as const, regex: { source: "finalText" as const, pattern: "(" } },
            },
          }
        : edge,
    ),
  };
  const executor = new FakeExecutor();
  await assert.rejects(
    () => runGraph(bad, { executor, parentContext: parent }),
    (error: unknown) => error instanceof GraphContractError && error.code === "invalid_regex",
  );
  await assert.rejects(
    () => runGraph({ ...graph, id: "bad id" }, { executor, parentContext: parent }),
    (error: unknown) => error instanceof GraphContractError && error.code === "invalid_graph",
  );
  assert.equal(executor.calls, 0);
});

test("startGraphRun requires an executor", () => {
  assert.throws(
    () => startGraphRun(reviewGraph(), { parentContext: parent } as never),
    (error: unknown) => error instanceof GraphContractError && error.code === "invalid_graph",
  );
});

test("preflight rejects an unavailable model before execution", async () => {
  const executor = new FakeExecutor();
  const emptyRegistry = { find: () => undefined };
  assert.throws(
    () => startGraphRun(reviewGraph(), { executor, parentContext: parent, modelRegistry: emptyRegistry }),
    (error: unknown) => error instanceof GraphContractError && error.code === "model_unavailable",
  );
  assert.equal(executor.calls, 0);
});

test("failure with retries: maxAttempts honored, waiting_retry observable, dependents skipped", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "retry",
    name: "retry",
    nodes: [
      { kind: "agent", id: "flaky", prompt: "flaky", retry: { maxAttempts: 3, backoffMs: 5 } },
      { kind: "agent", id: "consumer", prompt: "consumer" },
    ],
    edges: [{ id: "flaky-consumer", from: "flaky", to: "consumer" }],
  };
  const executor = new FakeExecutor({
    failFirst: { flaky: 3 },
    outcomes: { flaky: { error: "permanent" } },
  });
  const events: GraphLifecycleEvent[] = [];
  const snapshot = await runGraph(graph, {
    executor,
    parentContext: parent,
    onEvent: (event) => events.push(event),
  });
  assert.equal(snapshot.state, "failed");
  assert.equal(executor.attempts.get("flaky"), 3, "exactly three attempts");
  const flaky = snapshot.nodes.find((node) => node.id === "flaky");
  assert.equal(flaky?.state, "failed");
  assert.ok(flaky && "error" in flaky && flaky.error.code === "invalid_state");
  assert.equal(nodeState(snapshot, "consumer"), "skipped");
  assert.equal(skipReason(snapshot, "consumer"), "dependency_failed");
  const sawWaiting = events.some(
    (event) => event.type === "node_state_changed" && event.node.id === "flaky" && event.node.state === "waiting_retry",
  );
  assert.equal(sawWaiting, true, "waiting_retry was observable between attempts");
});

test("retry recovers on a later attempt and the run succeeds", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "retry-recover",
    name: "retry recover",
    nodes: [{ kind: "agent", id: "flaky", prompt: "flaky", retry: { maxAttempts: 3, backoffMs: 2 } }],
    edges: [],
  };
  const executor = new FakeExecutor({
    failFirst: { flaky: 2 },
    outcomes: { flaky: { finalText: "recovered" } },
  });
  const snapshot = await runGraph(graph, { executor, parentContext: parent });
  assert.equal(snapshot.state, "succeeded");
  const flaky = snapshot.nodes.find((node) => node.id === "flaky");
  assert.equal(flaky?.attempt, 3, "third attempt succeeded");
  assert.equal(flaky?.state, "succeeded");
});

test("cancellation mid-run: in-flight nodes cancelled, unadmitted skipped, run cancelled", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "cancel",
    name: "cancel",
    nodes: [
      { kind: "agent", id: "a", prompt: "a" },
      { kind: "agent", id: "b", prompt: "b" },
      { kind: "agent", id: "c", prompt: "c" },
    ],
    edges: [{ id: "a-b", from: "a", to: "b" }],
    budgets: { maxConcurrency: 1 },
  };
  const executor = new FakeExecutor({ pending: new Set(["a"]) });
  const handle = startGraphRun(graph, { executor, parentContext: parent });
  await waitUntilNodeState(handle, "a", "running");
  const result = handle.cancel("requested");
  assert.equal(result.accepted, true);
  const snapshot = await handle.done;
  assert.equal(snapshot.state, "cancelled");
  assert.equal(snapshot.cancellation?.reason, "requested");
  assert.equal(handleNodeState(handle, "a"), "cancelled");
  assert.equal(handleNodeState(handle, "b"), "skipped");
  assert.equal(handleNodeState(handle, "c"), "skipped");
  const late = handle.cancel();
  assert.equal(late.accepted, false);
  assert.equal(late.error.code, "cancel_rejected");
});

test("cancellation during retry backoff: waiting_retry node is cancelled", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "cancel-retry",
    name: "cancel retry",
    nodes: [{ kind: "agent", id: "flaky", prompt: "flaky", retry: { maxAttempts: 3, backoffMs: 120 } }],
    edges: [],
  };
  const executor = new FakeExecutor({ failFirst: { flaky: 3 }, outcomes: { flaky: { error: "boom" } } });
  const handle = startGraphRun(graph, { executor, parentContext: parent });
  await waitUntilNodeState(handle, "flaky", "waiting_retry");
  const result = handle.cancel();
  assert.equal(result.accepted, true);
  const snapshot = await handle.done;
  assert.equal(snapshot.state, "cancelled");
  assert.equal(handleNodeState(handle, "flaky"), "cancelled");
});

test("graph-owned concurrency never exceeds maxConcurrency and admission is deterministic", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "parallel",
    name: "parallel",
    nodes: ["a", "b", "c", "d"].map((id) => ({ kind: "agent" as const, id, prompt: id })),
    edges: [],
    budgets: { maxConcurrency: 2, maxAttempts: 1 },
  };
  const executor = new FakeExecutor({ delayMs: 15 });
  const snapshot = await runGraph(graph, { executor, parentContext: parent });
  assert.equal(snapshot.state, "succeeded");
  assert.ok(executor.concurrentInFlight.max <= 2, `max in flight was ${executor.concurrentInFlight.max}`);
  assert.deepEqual(executor.startOrder, ["a", "b", "c", "d"], "declaration-order admission");
});

test("budget exhaustion stops admission and skips remaining nodes", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "budget",
    name: "budget",
    nodes: [
      { kind: "agent", id: "root", prompt: "root" },
      { kind: "agent", id: "next", prompt: "next" },
    ],
    edges: [{ id: "root-next", from: "root", to: "next" }],
    budgets: { maxOutputTokens: 10, maxConcurrency: 2 },
  };
  const executor = new FakeExecutor({
    outcomes: {
      root: { finalText: "root", usage: { inputTokens: 1, outputTokens: 100, totalTokens: 101 } },
      next: { finalText: "next" },
    },
  });
  const snapshot = await runGraph(graph, { executor, parentContext: parent });
  assert.equal(snapshot.state, "cancelled");
  assert.equal(snapshot.cancellation?.reason, "budget_exhausted");
  assert.equal(nodeState(snapshot, "root"), "succeeded");
  assert.equal(nodeState(snapshot, "next"), "skipped");
  assert.equal(skipReason(snapshot, "next"), "budget_exhausted");
  assert.equal(executor.calls, 1, "only the over-budget root ran");
});

test("deterministic join/publish nodes produce artifacts consumed downstream", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "deterministic",
    name: "deterministic",
    nodes: [
      { kind: "agent", id: "a", prompt: "a" },
      { kind: "agent", id: "b", prompt: "b" },
      { kind: "deterministic", id: "join", operation: "join" },
      {
        kind: "deterministic",
        id: "publish",
        operation: "publish",
        inputArtifacts: [{ nodeId: "join", output: "value" }],
      },
      {
        kind: "agent",
        id: "consumer",
        prompt: "consume",
        inputArtifacts: [{ nodeId: "publish", output: "value" }],
      },
    ],
    edges: [
      { id: "a-join", from: "a", to: "join" },
      { id: "b-join", from: "b", to: "join" },
      { id: "join-publish", from: "join", to: "publish" },
      { id: "publish-consumer", from: "publish", to: "consumer" },
    ],
  };
  const executor = new FakeExecutor({
    outcomes: { a: { finalText: "from-a" }, b: { finalText: "from-b" }, consumer: { finalText: "consumed" } },
  });
  const snapshot = await runGraph(graph, { executor, parentContext: parent });
  assert.equal(snapshot.state, "succeeded");
  const joinNode = snapshot.nodes.find((node) => node.id === "join");
  assert.equal(joinNode?.state, "succeeded");
  assert.equal(joinNode?.attempt, 1, "deterministic nodes report attempt 1 after executing");
  const joinArtifact = snapshot.artifacts.find((artifact) => artifact.nodeId === "join");
  assert.ok(joinArtifact, "join produced an artifact");
  assert.deepEqual(joinArtifact.value, { a: "from-a", b: "from-b" }, "join aggregates active incoming finalText");
  const publishArtifact = snapshot.artifacts.find((artifact) => artifact.nodeId === "publish");
  assert.ok(publishArtifact);
  assert.deepEqual(publishArtifact.value, joinArtifact.value, "publish re-publishes the join value");
  const consumerInputs = executor.received.get("consumer") ?? [];
  assert.equal(consumerInputs.length, 1);
  assert.equal(consumerInputs[0]?.ref.nodeId, "publish");
  assert.equal(consumerInputs[0]?.ref.output, "value");
  assert.deepEqual(consumerInputs[0]?.value, joinArtifact.value);
  assert.equal(Object.isFrozen(consumerInputs[0]?.artifact), true, "routed artifacts are immutable");
});

test("executor-received artifacts are deeply frozen", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "frozen",
    name: "frozen",
    nodes: [
      { kind: "agent", id: "producer", prompt: "producer" },
      {
        kind: "agent",
        id: "consumer",
        prompt: "consumer",
        inputArtifacts: [{ nodeId: "producer", output: "finalText" }],
      },
    ],
    edges: [{ id: "producer-consumer", from: "producer", to: "consumer" }],
  };
  const executor = new FakeExecutor({
    outcomes: { producer: { finalText: "payload", structuredOutput: { nested: { deep: 1 } } } },
  });
  await runGraph(graph, { executor, parentContext: parent });
  const consumerInput = executor.received.get("consumer")?.[0];
  assert.ok(consumerInput);
  assert.equal(Object.isFrozen(consumerInput.artifact.value), true);
  assert.throws(() => {
    (consumerInput.artifact.value as { nested: { deep: number } }).nested.deep = 99;
  }, TypeError);
});

test("json predicate routes over structured output select the expected branch", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "json-route",
    name: "json route",
    nodes: [
      { kind: "agent", id: "check", prompt: "check", outputs: ["structuredOutput"] },
      { kind: "agent", id: "pass-branch", prompt: "pass" },
      { kind: "agent", id: "fail-branch", prompt: "fail" },
    ],
    edges: [
      {
        id: "check-pass",
        from: "check",
        to: "pass-branch",
        route: {
          kind: "predicate",
          predicate: { type: "json", predicate: { source: "json", path: "/verdict", equals: "pass" } },
        },
      },
      { id: "check-fail", from: "check", to: "fail-branch", route: { kind: "otherwise" } },
    ],
  };
  const executor = new FakeExecutor({
    outcomes: {
      check: { finalText: "checked", structuredOutput: { verdict: "pass" } },
      "pass-branch": { finalText: "passed" },
      "fail-branch": { finalText: "failed" },
    },
  });
  const snapshot = await runGraph(graph, { executor, parentContext: parent });
  assert.equal(snapshot.state, "succeeded");
  assert.equal(nodeState(snapshot, "pass-branch"), "succeeded");
  assert.equal(nodeState(snapshot, "fail-branch"), "skipped");
  assert.equal(skipReason(snapshot, "fail-branch"), "route_not_selected");
});

test("lifecycle events start with run_started and end with a terminal run event", async () => {
  const graph = reviewGraph();
  const executor = new FakeExecutor({
    outcomes: {
      implementation: { finalText: "implemented" },
      "review-1": { finalText: "<verdict>pass</verdict>" },
    },
  });
  const events: GraphLifecycleEvent[] = [];
  await runGraph(graph, { executor, parentContext: parent, onEvent: (event) => events.push(event) });
  assert.equal(events[0]?.type, "run_started");
  const terminal = events[events.length - 1];
  assert.ok(terminal && (terminal.type === "run_completed" || terminal.type === "run_failed"));
  const nodeEvents = events.filter((event) => event.type === "node_state_changed") as GraphEventWithNodes[];
  assert.ok(nodeEvents.length > 0);
});

test("wait observes the same run and reports completion", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "wait",
    name: "wait",
    nodes: [{ kind: "agent", id: "a", prompt: "a" }],
    edges: [],
  };
  const executor = new FakeExecutor({ delayMs: 30 });
  const handle = startGraphRun(graph, { executor, parentContext: parent });
  const early: GraphWaitResult = await handle.wait(5);
  assert.equal(early.completed, false);
  const done: GraphWaitResult = await handle.wait();
  assert.equal(done.completed, true);
  assert.equal(done.run.state, "succeeded");
});

test("run handles expose stable runId and events", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "stable",
    name: "stable",
    nodes: [{ kind: "agent", id: "a", prompt: "a" }],
    edges: [],
  };
  const executor = new FakeExecutor();
  const handle = startGraphRun(graph, { executor, parentContext: parent, runId: "custom-run" });
  assert.equal(handle.runId, "custom-run");
  const snapshot = await handle.done;
  assert.equal(snapshot.runId, "custom-run");
  assert.equal(snapshot.graphId, "stable");
  assert.ok(handle.events().length >= 2);
});

test("node failure while budget is exhausted still fails the run", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "budget-fail",
    name: "budget fail",
    nodes: [
      { kind: "agent", id: "heavy", prompt: "heavy", retry: { maxAttempts: 1 } },
      { kind: "agent", id: "flaky", prompt: "flaky", retry: { maxAttempts: 1 } },
      { kind: "agent", id: "consumer", prompt: "consumer" },
    ],
    edges: [
      { id: "heavy-consumer", from: "heavy", to: "consumer" },
      { id: "flaky-consumer", from: "flaky", to: "consumer" },
    ],
    budgets: { maxOutputTokens: 10, maxConcurrency: 2 },
  };
  const executor = new FakeExecutor({
    failFirst: { flaky: 1 },
    outcomes: {
      heavy: { finalText: "heavy", usage: { inputTokens: 1, outputTokens: 100, totalTokens: 101 } },
      flaky: { finalText: "never" },
      consumer: { finalText: "consumed" },
    },
  });
  const snapshot = await runGraph(graph, { executor, parentContext: parent });
  assert.equal(snapshot.state, "failed", "a real node failure wins over budget exhaustion");
  const flaky = snapshot.nodes.find((node) => node.id === "flaky");
  assert.equal(flaky?.state, "failed");
  assert.equal(nodeState(snapshot, "consumer"), "skipped");
  // The consumer's dependency actually failed, so dependency_failed is the
  // accurate reason even though the run is simultaneously budget-exhausted.
  assert.equal(skipReason(snapshot, "consumer"), "dependency_failed");
});

test("budget exhaustion never aborts an in-flight node", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "budget-inflight",
    name: "budget in flight",
    nodes: [
      { kind: "agent", id: "fast", prompt: "fast" },
      { kind: "agent", id: "slow", prompt: "slow" },
    ],
    edges: [],
    budgets: { maxConcurrency: 2, maxOutputTokens: 10 },
  };
  const delayingExecutor = new FakeExecutor({
    outcomes: {
      fast: { finalText: "fast", usage: { inputTokens: 1, outputTokens: 100, totalTokens: 101 } },
      slow: { finalText: "slow" },
    },
  });
  // Pace each node independently so fast exhausts the budget while slow is
  // still in flight: delay every execution, then un-delay the resolve by
  // letting the fake's timer do the work (delayMs applies to all nodes, so use
  // execution guards to let fast finish first).
  let fastResolved = false;
  const original = delayingExecutor.execute.bind(delayingExecutor);
  delayingExecutor.execute = async (request) => {
    if (request.node.id === "fast" && !fastResolved) {
      const result = await original(request);
      fastResolved = true;
      return result;
    }
    if (request.node.id === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return original(request);
    }
    return original(request);
  };
  const snapshot = await runGraph(graph, { executor: delayingExecutor, parentContext: parent });
  assert.equal(snapshot.state, "cancelled");
  assert.equal(snapshot.cancellation?.reason, "budget_exhausted");
  assert.equal(nodeState(snapshot, "fast"), "succeeded");
  assert.equal(nodeState(snapshot, "slow"), "succeeded", "in-flight node completed despite the budget stop");
});

test("parentSignal abort cancels the run with reason parent_aborted", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "parent-abort",
    name: "parent abort",
    nodes: [{ kind: "agent", id: "a", prompt: "a" }],
    edges: [],
  };
  const parentController = new AbortController();
  const executor = new FakeExecutor({ pending: new Set(["a"]) });
  const handle = startGraphRun(graph, {
    executor,
    parentContext: parent,
    parentSignal: parentController.signal,
  });
  await waitUntilNodeState(handle, "a", "running");
  parentController.abort();
  const snapshot = await handle.done;
  assert.equal(snapshot.state, "cancelled");
  assert.equal(snapshot.cancellation?.reason, "parent_aborted");
  assert.equal(handleNodeState(handle, "a"), "cancelled");
});

test("pre-aborted parentSignal cancels the run before execution", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "parent-preabort",
    name: "parent preabort",
    nodes: [{ kind: "agent", id: "a", prompt: "a" }],
    edges: [],
  };
  const parentController = new AbortController();
  parentController.abort();
  const executor = new FakeExecutor();
  const handle = startGraphRun(graph, {
    executor,
    parentContext: parent,
    parentSignal: parentController.signal,
  });
  const snapshot = await handle.done;
  assert.equal(snapshot.state, "cancelled");
  assert.equal(snapshot.cancellation?.reason, "parent_aborted");
  assert.equal(executor.calls, 0, "no node ran");
});

test("parentSignal abort after completion is a no-op (listener removed)", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "parent-late",
    name: "parent late",
    nodes: [{ kind: "agent", id: "a", prompt: "a" }],
    edges: [],
  };
  const parentController = new AbortController();
  const executor = new FakeExecutor({ outcomes: { a: { finalText: "done" } } });
  const handle = startGraphRun(graph, {
    executor,
    parentContext: parent,
    parentSignal: parentController.signal,
  });
  const snapshot = await handle.done;
  assert.equal(snapshot.state, "succeeded");
  const before = JSON.stringify(snapshot);
  parentController.abort();
  assert.equal(JSON.stringify(handle.snapshot()), before, "a late parent abort mutates nothing");
  assert.equal(handle.cancel().accepted, false);
});

test("consumer with a route-skipped declared artifact producer is skipped route_not_selected", async () => {
  const graph: GraphSpec = {
    version: 1,
    id: "route-blocked-ref",
    name: "route blocked ref",
    nodes: [
      { kind: "agent", id: "source", prompt: "source" },
      { kind: "agent", id: "branch-pass", prompt: "branch pass" },
      {
        kind: "agent",
        id: "consumer",
        prompt: "consume",
        inputArtifacts: [{ nodeId: "branch-pass", output: "finalText" }],
      },
    ],
    edges: [
      {
        id: "source-pass",
        from: "source",
        to: "branch-pass",
        route: {
          kind: "predicate",
          predicate: { type: "finalText", regex: { source: "finalText", pattern: "pass" } },
        },
      },
      { id: "branch-to-consumer", from: "branch-pass", to: "consumer" },
      { id: "source-otherwise", from: "source", to: "consumer", route: { kind: "otherwise" } },
    ],
  };
  const executor = new FakeExecutor({ outcomes: { source: { finalText: "reviewer has serious reservations" } } });
  const snapshot = await runGraph(graph, { executor, parentContext: parent });
  assert.equal(snapshot.state, "succeeded");
  assert.equal(nodeState(snapshot, "branch-pass"), "skipped");
  assert.equal(skipReason(snapshot, "branch-pass"), "route_not_selected");
  assert.equal(nodeState(snapshot, "consumer"), "skipped");
  assert.equal(
    skipReason(snapshot, "consumer"),
    "route_not_selected",
    "an active edge cannot substitute a route-skipped declared producer",
  );
});
