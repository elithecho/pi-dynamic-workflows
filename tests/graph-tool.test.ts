import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GraphRunSnapshot, GraphSpec } from "../src/graph.js";
import { GraphRunRegistry } from "../src/graph-registry.js";
import type { NodeExecutionRequest, NodeExecutor, NodeExecutorResult } from "../src/graph-runtime.js";
import { createWorkflowGraphTool } from "../src/graph-tool.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

interface FakeUiRecordings {
  readonly setWidgetCalls: Array<{ readonly key: string; readonly content: string[] | undefined }>;
  readonly setStatusCalls: Array<{ readonly key: string; readonly text: string | undefined }>;
  readonly notifyCalls: Array<{ readonly message: string; readonly type: string }>;
  sendMessageCalls: number;
  sendUserMessageCalls: number;
}

/**
 * Hermetic ExtensionContext. Omitting the model argument defaults to the fake
 * parent model (test/parent); passing an explicit `undefined` yields a context
 * with no invoking model, exercising the missing_parent_model path.
 */
function fakeCtx(model?: unknown, noModel = false): ExtensionContext & { readonly __recordings: FakeUiRecordings } {
  const recordings: FakeUiRecordings = {
    setWidgetCalls: [],
    setStatusCalls: [],
    notifyCalls: [],
    sendMessageCalls: 0,
    sendUserMessageCalls: 0,
  };
  const context = {
    cwd: process.cwd(),
    model: noModel ? undefined : (model ?? { provider: "test", id: "parent" }),
    modelRegistry: {
      find(provider: string, id: string) {
        return provider === "test" && id === "parent" ? { id: "parent", provider: "test", name: "x" } : undefined;
      },
    },
    ui: {
      setWidget(key: string, content: string[] | undefined) {
        recordings.setWidgetCalls.push({ key, content });
      },
      setStatus(key: string, text: string | undefined) {
        recordings.setStatusCalls.push({ key, text });
      },
      notify(message: string, type: string) {
        recordings.notifyCalls.push({ message, type });
      },
    },
    hasUI: true,
    signal: undefined,
    sendMessage() {
      recordings.sendMessageCalls += 1;
      throw new Error("workflow_graph must never relay through sendMessage");
    },
    sendUserMessage() {
      recordings.sendUserMessageCalls += 1;
      throw new Error("workflow_graph must never relay through sendUserMessage");
    },
  };
  return { ...context, __recordings: recordings } as unknown as ExtensionContext & {
    readonly __recordings: FakeUiRecordings;
  };
}

interface RecordedCall {
  readonly nodeId: string;
  readonly attempt: number;
  readonly inputs: NodeExecutionRequest["inputArtifacts"];
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class RecordingExecutor implements NodeExecutor {
  readonly calls: RecordedCall[] = [];
  private readonly finalText: Readonly<Record<string, string>>;
  private readonly defers = new Map<string, Deferred>();
  private running = 0;
  maxRunning = 0;

  constructor(options: { readonly finalText?: Readonly<Record<string, string>>; readonly deferNode?: string } = {}) {
    this.finalText = options.finalText ?? {};
    if (options.deferNode !== undefined) this.defers.set(options.deferNode, deferred());
  }

  deferNode(nodeId: string): Deferred {
    const existing = this.defers.get(nodeId);
    if (existing !== undefined) return existing;
    const created = deferred();
    this.defers.set(nodeId, created);
    return created;
  }

  async execute(request: NodeExecutionRequest): Promise<NodeExecutorResult> {
    this.calls.push({ nodeId: request.node.id, attempt: request.attempt, inputs: request.inputArtifacts });
    this.running += 1;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    try {
      await this.defers.get(request.node.id)?.promise;
      return { ok: true, output: { finalText: this.finalText[request.node.id] ?? "" } };
    } finally {
      this.running -= 1;
    }
  }
}

function makeChainGraph(): GraphSpec {
  return {
    version: 1,
    id: "chain",
    name: "chain",
    nodes: [
      { kind: "agent", id: "a", prompt: "A" },
      { kind: "agent", id: "b", prompt: "B", inputArtifacts: [{ nodeId: "a", output: "finalText" }] },
      { kind: "agent", id: "c", prompt: "C", inputArtifacts: [{ nodeId: "b", output: "finalText" }] },
    ],
    edges: [
      { id: "a-b", from: "a", to: "b" },
      { id: "b-c", from: "b", to: "c" },
    ],
  };
}

function makeFanOutGraph(maxConcurrency?: number): GraphSpec {
  const graph: GraphSpec = {
    version: 1,
    id: "fan",
    name: "fan-out",
    nodes: [
      { kind: "agent", id: "root", prompt: "Root" },
      { kind: "agent", id: "x1", prompt: "X1", inputArtifacts: [{ nodeId: "root", output: "finalText" }] },
      { kind: "agent", id: "x2", prompt: "X2", inputArtifacts: [{ nodeId: "root", output: "finalText" }] },
      { kind: "agent", id: "x3", prompt: "X3", inputArtifacts: [{ nodeId: "root", output: "finalText" }] },
      {
        kind: "deterministic",
        id: "join",
        operation: "join",
        inputArtifacts: [
          { nodeId: "x1", output: "finalText" },
          { nodeId: "x2", output: "finalText" },
          { nodeId: "x3", output: "finalText" },
        ],
      },
      { kind: "agent", id: "final", prompt: "Final", inputArtifacts: [{ nodeId: "join", output: "value" }] },
    ],
    edges: [
      { id: "root-x1", from: "root", to: "x1" },
      { id: "root-x2", from: "root", to: "x2" },
      { id: "root-x3", from: "root", to: "x3" },
      { id: "x1-join", from: "x1", to: "join" },
      { id: "x2-join", from: "x2", to: "join" },
      { id: "x3-join", from: "x3", to: "join" },
      { id: "join-final", from: "join", to: "final" },
    ],
    ...(maxConcurrency === undefined ? {} : { budgets: { maxConcurrency } }),
  };
  return graph;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const FIX_OR_SHIP_SCRIPT = `export const meta = { name: 'fix_or_ship', description: 'Coder → review → fix then ship, or ship directly.' }

const coder  = agent('You are a coder agent. Read the coder skill and implement the change.', { role: 'implementation' })
const review = agent('Review the change. Respond with exactly <verdict>change</verdict> or <verdict>pass</verdict>.', { role: 'reviewer' })
const fixer  = agent('Apply the requested changes.', { role: 'implementation' })
const done   = agent('Finalize and report.', { role: 'verifier' })

coder.to(review)
review.when('<verdict>change</verdict>', fixer).otherwise(done)
fixer.to(done)`;

const FIX_OR_SHIP_GRAPH: GraphSpec = {
  version: 1,
  id: "fix_or_ship",
  name: "fix_or_ship",
  nodes: [
    {
      kind: "agent",
      id: "coder",
      prompt: "You are a coder agent. Read the coder skill and implement the change.",
      role: "implementation",
    },
    {
      kind: "agent",
      id: "review",
      prompt: "Review the change. Respond with exactly <verdict>change</verdict> or <verdict>pass</verdict>.",
      role: "reviewer",
      inputArtifacts: [{ nodeId: "coder", output: "finalText" }],
    },
    {
      kind: "agent",
      id: "fixer",
      prompt: "Apply the requested changes.",
      role: "implementation",
      inputArtifacts: [{ nodeId: "review", output: "finalText" }],
    },
    {
      kind: "agent",
      id: "done",
      prompt: "Finalize and report.",
      role: "verifier",
      inputArtifacts: [{ nodeId: "done_join", output: "value" }],
    },
    { kind: "deterministic", id: "done_join", operation: "join" },
  ],
  edges: [
    { id: "coder_to_review", from: "coder", to: "review" },
    {
      id: "review_to_fixer",
      from: "review",
      to: "fixer",
      route: {
        kind: "predicate",
        predicate: {
          type: "finalText",
          regex: { source: "finalText", pattern: "<verdict>change</verdict>" },
        },
      },
    },
    { id: "review_to_done_join", from: "review", to: "done_join", route: { kind: "otherwise" } },
    { id: "fixer_to_done_join", from: "fixer", to: "done_join" },
    { id: "done_join_to_done", from: "done_join", to: "done" },
  ],
  roles: { implementation: {}, reviewer: {}, verifier: {} },
};

test("the tool is registered under the name workflow_graph", () => {
  const tool = createWorkflowGraphTool();
  assert.equal(tool.name, "workflow_graph");
  assert.equal(tool.label, "Workflow Graph");
});

test("start returns before completion with a runId while nodes stay pending", async () => {
  const executor = new RecordingExecutor({ deferNode: "a" });
  const registry = new GraphRunRegistry();
  const tool = createWorkflowGraphTool({ executor, registry, getThinkingLevel: () => "medium" });
  const ctx = fakeCtx();

  const result = await tool.execute(
    "call-1",
    { operation: "start", graph: makeChainGraph() },
    undefined,
    undefined,
    ctx,
  );
  const details = result.details as { ok: true; result: { runId: string; state: string } };
  assert.equal(details.ok, true);
  assert.ok(details.result.runId.length > 0);
  assert.equal(details.result.state, "running");

  await tick();
  assert.deepEqual(
    executor.calls.map((call) => call.nodeId),
    ["a"],
    "node a is admitted and still pending when start returns",
  );
  const status = await tool.execute(
    "call-2",
    { operation: "status", runId: details.result.runId },
    undefined,
    undefined,
    ctx,
  );
  assert.equal((status.details as { result: { run: GraphRunSnapshot } }).result.run.state, "running");

  executor.deferNode("a").resolve();
  const waited = await tool.execute(
    "call-3",
    { operation: "wait", runId: details.result.runId },
    undefined,
    undefined,
    ctx,
  );
  const waitDetails = waited.details as { result: { completed: boolean; run: GraphRunSnapshot } };
  assert.equal(waitDetails.result.completed, true);
  assert.equal(waitDetails.result.run.state, "succeeded");
});

test("status and wait observe the same run", async () => {
  const executor = new RecordingExecutor({ finalText: { a: "A", b: "B", c: "C" } });
  const registry = new GraphRunRegistry();
  const tool = createWorkflowGraphTool({ executor, registry, getThinkingLevel: () => "medium" });
  const ctx = fakeCtx();

  const started = await tool.execute(
    "call-1",
    { operation: "start", graph: makeChainGraph() },
    undefined,
    undefined,
    ctx,
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;

  const status = await tool.execute("call-2", { operation: "status", runId }, undefined, undefined, ctx);
  assert.equal((status.details as { result: { run: GraphRunSnapshot } }).result.run.runId, runId);

  const waited = await tool.execute("call-3", { operation: "wait", runId }, undefined, undefined, ctx);
  const waitDetails = waited.details as { result: { completed: boolean; run: GraphRunSnapshot } };
  assert.equal(waitDetails.result.completed, true);
  assert.equal(waitDetails.result.run.runId, runId);
});

test("default registry (no options.registry) is shared across execute calls", async () => {
  const executor = new RecordingExecutor({ finalText: { a: "A", b: "B", c: "C" } });
  const tool = createWorkflowGraphTool({ executor, getThinkingLevel: () => "medium" });
  const ctx = fakeCtx();

  const started = await tool.execute(
    "call-1",
    { operation: "start", graph: makeChainGraph() },
    undefined,
    undefined,
    ctx,
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;

  const status = await tool.execute("call-2", { operation: "status", runId }, undefined, undefined, ctx);
  assert.equal((status.details as { result: { run: GraphRunSnapshot } }).result.run.runId, runId);

  const waited = await tool.execute("call-3", { operation: "wait", runId }, undefined, undefined, ctx);
  const waitDetails = waited.details as { result: { completed: boolean; run: GraphRunSnapshot } };
  assert.equal(waitDetails.result.completed, true);
  assert.equal(waitDetails.result.run.runId, runId);
  assert.equal(waitDetails.result.run.state, "succeeded");
});

test("cancel aborts an active node and rejects a second cancel", async () => {
  const executor = new RecordingExecutor({ deferNode: "a" });
  const registry = new GraphRunRegistry();
  const tool = createWorkflowGraphTool({ executor, registry, getThinkingLevel: () => "medium" });
  const ctx = fakeCtx();

  const started = await tool.execute(
    "call-1",
    { operation: "start", graph: makeChainGraph() },
    undefined,
    undefined,
    ctx,
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;
  await tick();
  assert.deepEqual(
    executor.calls.map((call) => call.nodeId),
    ["a"],
  );

  const cancelled = await tool.execute("call-2", { operation: "cancel", runId }, undefined, undefined, ctx);
  assert.equal((cancelled.details as { result: { accepted: boolean } }).result.accepted, true);

  const status = await tool.execute("call-3", { operation: "status", runId }, undefined, undefined, ctx);
  const run = (status.details as { result: { run: GraphRunSnapshot } }).result.run;
  assert.equal(run.state, "cancelled");
  assert.equal(run.nodes.find((node) => node.id === "a")?.state, "cancelled");

  const second = await tool.execute("call-4", { operation: "cancel", runId }, undefined, undefined, ctx);
  const secondDetails = second.details as { result: { accepted: false; error: { code: string } } };
  assert.equal(secondDetails.result.accepted, false);
  assert.equal(secondDetails.result.error.code, "cancel_rejected");

  await tick();
  assert.ok(
    executor.calls.every((call) => call.nodeId === "a"),
    "no node is admitted after cancel",
  );
});

test("script compiles into a graph at prepareArguments (canonical fixture)", () => {
  const tool = createWorkflowGraphTool({ getThinkingLevel: () => "medium" });
  const prepared = tool.prepareArguments?.({ operation: "start", script: FIX_OR_SHIP_SCRIPT });
  assert.deepEqual(prepared?.graph, FIX_OR_SHIP_GRAPH);
});

test("graph and definition pass through prepareArguments unchanged", () => {
  const tool = createWorkflowGraphTool({ getThinkingLevel: () => "medium" });
  const prepared = tool.prepareArguments?.({ operation: "start", graph: 123 });
  assert.equal(prepared?.graph, 123);
  const definition = { nodes: [{ id: "a", prompt: "A" }], routes: [] };
  const preparedDefinition = tool.prepareArguments?.({ operation: "start", definition });
  assert.deepEqual(preparedDefinition?.definition, definition);

  const legacy = createWorkflowTool();
  assert.throws(() => legacy.prepareArguments?.({ graph: { version: 1 } }), /script. to be a string/);
});

test("graph, definition, and script are mutually exclusive for start", () => {
  const tool = createWorkflowGraphTool({ getThinkingLevel: () => "medium" });
  const conflict = /mutually exclusive/;
  assert.throws(() => tool.prepareArguments?.({ operation: "start", graph: {}, definition: {} }), conflict);
  assert.throws(
    () =>
      tool.prepareArguments?.({
        operation: "start",
        graph: {},
        script: "export const meta = { name: 'x', description: 'y' }",
      }),
    conflict,
  );
  assert.throws(
    () =>
      tool.prepareArguments?.({
        operation: "start",
        definition: {},
        script: "export const meta = { name: 'x', description: 'y' }",
      }),
    conflict,
  );
  assert.throws(() => tool.prepareArguments?.({ operation: "start" }), /requires exactly one/);
});

test("a script that fails compileGraphScript rejects with the script error code", () => {
  const tool = createWorkflowGraphTool({ getThinkingLevel: () => "medium" });
  const useBeforeDeclaration = `export const meta = { name: 'x', description: 'y' }
const a = agent('A')
b.to(a)
const b = agent('B')`;
  assert.throws(
    () => tool.prepareArguments?.({ operation: "start", script: useBeforeDeclaration }),
    /script_use_before_declaration/,
  );
});

test("start with a raw JavaScript string graph fails with invalid_graph", async () => {
  const registry = new GraphRunRegistry();
  const tool = createWorkflowGraphTool({
    executor: new RecordingExecutor(),
    registry,
    getThinkingLevel: () => "medium",
  });
  await assert.rejects(
    tool.execute("call-1", { operation: "start", graph: "export const meta = {}" }, undefined, undefined, fakeCtx()),
    /invalid_graph/,
  );
});

test("missing parent model surfaces missing_parent_model", async () => {
  const registry = new GraphRunRegistry();
  const tool = createWorkflowGraphTool({
    executor: new RecordingExecutor(),
    registry,
    getThinkingLevel: () => "medium",
  });
  await assert.rejects(
    tool.execute(
      "call-1",
      { operation: "start", graph: makeChainGraph() },
      undefined,
      undefined,
      fakeCtx(undefined, true),
    ),
    /missing_parent_model/,
  );
});

test("missing parent thinking surfaces missing_parent_thinking", async () => {
  const registry = new GraphRunRegistry();
  const tool = createWorkflowGraphTool({ executor: new RecordingExecutor(), registry });
  await assert.rejects(
    tool.execute("call-1", { operation: "start", graph: makeChainGraph() }, undefined, undefined, fakeCtx()),
    /missing_parent_thinking/,
  );
});

test("definition compiles into a graph at start", async () => {
  const executor = new RecordingExecutor();
  const registry = new GraphRunRegistry();
  const tool = createWorkflowGraphTool({ getThinkingLevel: () => "medium", executor, registry });

  const started = await tool.execute(
    "call-1",
    {
      operation: "start",
      definition: {
        name: "demo",
        nodes: [
          { id: "a", prompt: "do" },
          { id: "b", prompt: "check", role: "reviewer" },
        ],
        routes: [{ from: "a", to: "b" }],
      },
    },
    undefined,
    undefined,
    fakeCtx(),
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;
  assert.ok(runId.length > 0);

  const status = await tool.execute("call-2", { operation: "status", runId }, undefined, undefined, fakeCtx());
  const run = (status.details as { result: { run: GraphRunSnapshot } }).result.run;
  assert.deepEqual(
    run.nodes.map((node) => node.id),
    ["a", "b"],
  );
});

test("the tool never relays node output through the main agent", async () => {
  const executor = new RecordingExecutor({ finalText: { a: "SECRET-A", b: "SECRET-B", c: "SECRET-C" } });
  const registry = new GraphRunRegistry();
  const tool = createWorkflowGraphTool({ executor, registry, getThinkingLevel: () => "medium" });
  const ctx = fakeCtx();

  const started = await tool.execute(
    "call-1",
    { operation: "start", graph: makeChainGraph() },
    undefined,
    undefined,
    ctx,
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;
  const startText = started.content[0].type === "text" ? started.content[0].text : "";
  assert.match(startText, /^Started workflow_graph run run-\d+ \(state running\)\./);
  assert.doesNotMatch(startText, /SECRET/);

  const waited = await tool.execute("call-2", { operation: "wait", runId }, undefined, undefined, ctx);
  const waitDetails = waited.details as { result: { completed: boolean; run: GraphRunSnapshot } };
  assert.equal(waitDetails.result.completed, true);
  const run = waitDetails.result.run;
  assert.equal(run.state, "succeeded");
  assert.equal(run.artifacts.length, 3);
  assert.ok(run.artifacts.every((artifact) => "finalText" in artifact));
  const waitText = waited.content[0].type === "text" ? waited.content[0].text : "";
  assert.match(waitText, /^workflow_graph run run-\d+: succeeded$/);
  assert.doesNotMatch(waitText, /SECRET/);

  const recordings = ctx.__recordings;
  assert.equal(recordings.notifyCalls.length, 1);
  assert.equal(recordings.notifyCalls[0]?.type, "info");
  assert.ok(recordings.setWidgetCalls.length >= 1);
  assert.equal(recordings.sendMessageCalls, 0);
  assert.equal(recordings.sendUserMessageCalls, 0);
});

test("concurrency obeys the graph budget", async () => {
  const executor = new RecordingExecutor();
  const registry = new GraphRunRegistry();
  const tool = createWorkflowGraphTool({ executor, registry, getThinkingLevel: () => "medium" });

  const started = await tool.execute(
    "call-1",
    { operation: "start", graph: makeFanOutGraph(1) },
    undefined,
    undefined,
    fakeCtx(),
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;
  const waited = await tool.execute("call-2", { operation: "wait", runId }, undefined, undefined, fakeCtx());
  const waitDetails = waited.details as { result: { completed: boolean; run: GraphRunSnapshot } };
  assert.equal(waitDetails.result.completed, true);
  assert.equal(waitDetails.result.run.state, "succeeded");
  assert.ok(executor.maxRunning <= 1, `observed concurrency ${executor.maxRunning} exceeds budget 1`);
});
