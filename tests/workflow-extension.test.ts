import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/workflow.js";
import type { GraphRunSnapshot, GraphSpec } from "../src/graph.js";
import type { NodeExecutor } from "../src/graph-runtime.js";
import type { createWorkflowGraphTool } from "../src/graph-tool.js";
import type { createWaitForWorkflowTool } from "../src/wait-for-workflow-tool.js";

interface SentMessage {
  readonly message: {
    readonly customType: string;
    readonly content: string;
    readonly display: boolean;
    readonly details?: unknown;
  };
  readonly options?: {
    readonly deliverAs?: "steer" | "followUp" | "nextTurn";
    readonly triggerTurn?: boolean;
  };
}

function fakeContext(): ExtensionContext {
  return {
    cwd: process.cwd(),
    model: { provider: "test", id: "parent" },
    modelRegistry: {
      find(provider: string, id: string) {
        return provider === "test" && id === "parent" ? { provider, id, name: "parent" } : undefined;
      },
    },
    ui: {
      setWidget() {},
      setStatus() {},
      notify() {},
    },
    hasUI: true,
    signal: undefined,
    sendMessage() {},
    sendUserMessage() {},
  } as unknown as ExtensionContext;
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

function graph(): GraphSpec {
  return {
    version: 1,
    id: "extension-regression",
    name: "extension regression",
    nodes: [
      { kind: "agent", id: "first", prompt: "first" },
      { kind: "agent", id: "final", prompt: "final", inputArtifacts: [{ nodeId: "first", output: "finalText" }] },
    ],
    edges: [{ id: "first-final", from: "first", to: "final" }],
  };
}

type WorkflowGraphTool = ReturnType<typeof createWorkflowGraphTool>;
type WaitForWorkflowTool = ReturnType<typeof createWaitForWorkflowTool>;

function isWorkflowGraphTool(value: unknown): value is WorkflowGraphTool {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { name?: unknown }).name === "workflow_graph" &&
    typeof (value as { execute?: unknown }).execute === "function"
  );
}

function isWaitForWorkflowTool(value: unknown): value is WaitForWorkflowTool {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { name?: unknown }).name === "wait_for_workflow" &&
    typeof (value as { execute?: unknown }).execute === "function"
  );
}

function installExtension(executor: NodeExecutor): {
  readonly tool: WorkflowGraphTool;
  readonly waitTool: WaitForWorkflowTool;
  readonly sent: SentMessage[];
  readonly registeredToolNames: string[];
  readonly activationCalls: string[][];
  activateSessionStart(): void;
} {
  const tools: unknown[] = [];
  const sent: SentMessage[] = [];
  const activationCalls: string[][] = [];
  let activeTools = ["existing_tool"];
  let sessionStartHandler: (() => void) | undefined;
  const pi = {
    getThinkingLevel: () => "medium" as const,
    getActiveTools: () => activeTools,
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    setActiveTools(next: string[]) {
      activeTools = next;
      activationCalls.push(next);
    },
    sendMessage(message: SentMessage["message"], options: SentMessage["options"]) {
      sent.push({ message, options });
    },
    on(event: string, handler: () => void) {
      if (event === "session_start") sessionStartHandler = handler;
    },
  } as unknown as ExtensionAPI;
  extension(pi, { executor });
  const tool = tools.find(isWorkflowGraphTool);
  const waitTool = tools.find(isWaitForWorkflowTool);
  assert.ok(tool, "workflow_graph was registered");
  assert.ok(waitTool, "wait_for_workflow was registered");
  const registeredToolNames = tools.map((value) => (value as { name: string }).name);
  assert.deepEqual(registeredToolNames, ["workflow_graph", "wait_for_workflow"]);
  assert.ok(sessionStartHandler, "session_start handler was registered");
  return {
    tool,
    waitTool,
    sent,
    registeredToolNames,
    activationCalls,
    activateSessionStart() {
      sessionStartHandler?.();
    },
  };
}

test("extension registers and activates only workflow_graph", () => {
  const installed = installExtension({
    async execute() {
      return { ok: true, output: { finalText: "done" } };
    },
  });
  assert.deepEqual(installed.registeredToolNames, ["workflow_graph", "wait_for_workflow"]);
  installed.activateSessionStart();
  assert.deepEqual(installed.activationCalls, [["existing_tool", "workflow_graph", "wait_for_workflow"]]);
});

test("wait_for_workflow blocks, terminates the turn, and suppresses the duplicate relay", async () => {
  const gate = deferred();
  const { tool, waitTool, sent } = installExtension({
    async execute(request) {
      await gate.promise;
      return { ok: true, output: { finalText: request.node.id === "final" ? "CANONICAL" : "INTERMEDIATE" } };
    },
  });
  const started = await tool.execute(
    "call-1",
    { operation: "start", graph: graph() },
    undefined,
    undefined,
    fakeContext(),
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;
  let settled = false;
  const waiting = waitTool.execute("call-2", { runId }, undefined, undefined, fakeContext()).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);

  gate.resolve();
  const result = await waiting;
  assert.equal((result as { terminate?: boolean }).terminate, true);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /CANONICAL/);
  assert.equal(sent.length, 0);
});

test("pre-aborted wait_for_workflow never claims and natural completion relays once", async () => {
  const gate = deferred();
  const { tool, waitTool, sent } = installExtension({
    async execute(request) {
      await gate.promise;
      return { ok: true, output: { finalText: request.node.id === "final" ? "CANONICAL" : "INTERMEDIATE" } };
    },
  });
  const started = await tool.execute(
    "call-1",
    { operation: "start", graph: graph() },
    undefined,
    undefined,
    fakeContext(),
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitTool.execute("call-2", { runId }, controller.signal, undefined, fakeContext()),
    /Operation aborted/,
  );

  gate.resolve();
  await tool.execute("call-3", { operation: "wait", runId }, undefined, undefined, fakeContext());
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.message.content ?? "", /CANONICAL/);
});

test("mid-wait abort releases its claim before natural success and relays once", async () => {
  const gate = deferred();
  const { tool, waitTool, sent } = installExtension({
    async execute(request) {
      await gate.promise;
      return { ok: true, output: { finalText: request.node.id === "final" ? "CANONICAL" : "INTERMEDIATE" } };
    },
  });
  const started = await tool.execute(
    "call-1",
    { operation: "start", graph: graph() },
    undefined,
    undefined,
    fakeContext(),
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;
  const controller = new AbortController();
  const waiting = waitTool.execute("call-2", { runId }, controller.signal, undefined, fakeContext());
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(waiting, /Operation aborted/);

  gate.resolve();
  await tool.execute("call-3", { operation: "wait", runId }, undefined, undefined, fakeContext());
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.message.content ?? "", /CANONICAL/);
});

test("concurrent wait claims survive one waiter aborting", async () => {
  const gate = deferred();
  const { tool, waitTool, sent } = installExtension({
    async execute(request) {
      await gate.promise;
      return { ok: true, output: { finalText: request.node.id === "final" ? "CANONICAL" : "INTERMEDIATE" } };
    },
  });
  const started = await tool.execute(
    "call-1",
    { operation: "start", graph: graph() },
    undefined,
    undefined,
    fakeContext(),
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;
  const firstController = new AbortController();
  const first = waitTool.execute("call-2", { runId }, firstController.signal, undefined, fakeContext());
  const second = waitTool.execute("call-3", { runId }, undefined, undefined, fakeContext());
  await new Promise((resolve) => setTimeout(resolve, 0));
  firstController.abort();
  await assert.rejects(first, /Operation aborted/);

  gate.resolve();
  const result = await second;
  assert.equal((result.details as { result: { run: GraphRunSnapshot } }).result.run.state, "succeeded");
  assert.equal(sent.length, 0, "the surviving waiter suppresses the automatic relay");
});

test("terminal completion wins an abort race without a duplicate relay", async () => {
  const { tool, waitTool, sent } = installExtension({
    async execute(request) {
      return { ok: true, output: { finalText: request.node.id === "final" ? "CANONICAL" : "INTERMEDIATE" } };
    },
  });
  const started = await tool.execute(
    "call-1",
    { operation: "start", graph: graph() },
    undefined,
    undefined,
    fakeContext(),
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;
  const controller = new AbortController();
  const waiting = waitTool.execute("call-2", { runId }, controller.signal, undefined, fakeContext());
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = await waiting;
  controller.abort();
  assert.equal((result.details as { result: { run: GraphRunSnapshot } }).result.run.state, "succeeded");
  assert.equal(sent.length, 0);
});

test("extension preserves the automatic relay when no waiter claims the run", async () => {
  const { tool, sent } = installExtension({
    async execute(request) {
      return { ok: true, output: { finalText: request.node.id === "final" ? "CANONICAL" : "INTERMEDIATE" } };
    },
  });
  const started = await tool.execute(
    "call-1",
    { operation: "start", graph: graph() },
    undefined,
    undefined,
    fakeContext(),
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;
  await tool.execute("call-2", { operation: "wait", runId }, undefined, undefined, fakeContext());
  assert.equal(sent.length, 1);
});

test("extension relays exactly one terminal success with only the canonical answer", async () => {
  const executor: NodeExecutor = {
    async execute(request) {
      return { ok: true, output: { finalText: request.node.id === "final" ? "CANONICAL" : "INTERMEDIATE" } };
    },
  };
  const { tool, sent } = installExtension(executor);
  const started = await tool.execute(
    "call-1",
    { operation: "start", graph: graph() },
    undefined,
    undefined,
    fakeContext(),
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;
  await tool.execute("call-2", { operation: "wait", runId }, undefined, undefined, fakeContext());

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.options?.deliverAs, "followUp");
  assert.equal(sent[0]?.options?.triggerTurn, true);
  assert.equal(sent[0]?.message.customType, "workflow_graph_completion");
  assert.match(sent[0]?.message.content ?? "", /CANONICAL/);
  assert.doesNotMatch(sent[0]?.message.content ?? "", /INTERMEDIATE/);
  assert.deepEqual(sent[0]?.message.details, { runId, state: "succeeded", finalAnswer: "CANONICAL" });
});

test("extension bounds large terminal relay but preserves the full snapshot answer", async () => {
  const large = "z".repeat(6_000);
  const executor: NodeExecutor = {
    async execute(request) {
      return { ok: true, output: { finalText: request.node.id === "final" ? large : "intermediate" } };
    },
  };
  const { tool, sent } = installExtension(executor);
  const started = await tool.execute(
    "call-1",
    { operation: "start", graph: graph() },
    undefined,
    undefined,
    fakeContext(),
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;
  await tool.execute("call-2", { operation: "wait", runId }, undefined, undefined, fakeContext());

  assert.equal(sent.length, 1);
  assert.match(sent[0]?.message.content ?? "", /Final answer:/);
  assert.match(sent[0]?.message.content ?? "", /… \[truncated\]/);
  assert.ok((sent[0]?.message.content.length ?? 0) < 5_000);
  assert.equal((sent[0]?.message.details as { finalAnswer: string }).finalAnswer, large);
});

test("extension relays actionable failure metadata without artifacts", async () => {
  const executor: NodeExecutor = {
    async execute(request) {
      return { ok: false, error: { code: "model_unavailable", nodeId: request.node.id, message: "model failed" } };
    },
  };
  const { tool, sent } = installExtension(executor);
  const started = await tool.execute(
    "call-1",
    {
      operation: "start",
      graph: {
        version: 1,
        id: "failure",
        name: "failure",
        nodes: [{ kind: "agent", id: "broken", prompt: "broken" }],
        edges: [],
      },
    },
    undefined,
    undefined,
    fakeContext(),
  );
  const runId = (started.details as { result: { runId: string } }).result.runId;
  await tool.execute("call-2", { operation: "wait", runId }, undefined, undefined, fakeContext());

  assert.equal(sent.length, 1);
  assert.match(sent[0]?.message.content ?? "", /model_unavailable/);
  assert.match(sent[0]?.message.content ?? "", /node=broken/);
  assert.match(sent[0]?.message.content ?? "", /model failed/);
  assert.doesNotMatch(sent[0]?.message.content ?? "", /finalText|artifact/i);
});
