import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/workflow.js";
import type { GraphSpec } from "../src/graph.js";
import type { NodeExecutor } from "../src/graph-runtime.js";
import type { createWorkflowGraphTool } from "../src/graph-tool.js";

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

function isWorkflowGraphTool(value: unknown): value is WorkflowGraphTool {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { name?: unknown }).name === "workflow_graph" &&
    typeof (value as { execute?: unknown }).execute === "function"
  );
}

function installExtension(executor: NodeExecutor): {
  readonly tool: WorkflowGraphTool;
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
  assert.ok(tool, "workflow_graph was registered");
  const registeredToolNames = tools.map((value) => (value as { name: string }).name);
  assert.deepEqual(registeredToolNames, ["workflow_graph"]);
  assert.ok(sessionStartHandler, "session_start handler was registered");
  return {
    tool,
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
  assert.deepEqual(installed.registeredToolNames, ["workflow_graph"]);
  installed.activateSessionStart();
  assert.deepEqual(installed.activationCalls, [["existing_tool", "workflow_graph"]]);
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
