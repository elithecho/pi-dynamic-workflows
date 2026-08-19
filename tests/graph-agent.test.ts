/**
 * Execution-1 tests: graph-owned direct Pi session runner.
 *
 * Hermetic: the real `createAgentSession` is replaced with a fake session
 * factory so no network or model runs. The fake captures the exact
 * `CreateAgentSessionOptions` (model, thinkingLevel, customTools) the runner
 * would pass to the Pi SDK and exposes controllable message histories.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type AgentMessageLike,
  GraphAgentRunner,
  type GraphModelRegistryLike,
  type GraphSession,
  lastAssistantText,
} from "../src/graph-agent.js";
import type { NodeExecutionRequest, RoutedArtifact } from "../src/graph-runtime.js";
import {
  type AgentNode,
  GraphContractError,
  type GraphThinkingLevel,
  type InvokingParentExecutionContext,
  type ModelSelector,
  type ResolvedExecutionContext,
  resolveExecutionContext,
} from "../src/index.js";

const parentModel: ModelSelector = { provider: "test", modelId: "parent-model" };
const parent: InvokingParentExecutionContext = { model: parentModel, thinking: "medium" };

const models: Record<string, { provider: string; id: string }> = {
  "test/parent-model": { provider: "test", id: "parent-model" },
  "test/explicit": { provider: "test", id: "explicit" },
};

const registry: GraphModelRegistryLike = {
  find(provider: string, modelId: string) {
    return models[`${provider}/${modelId}`];
  },
};

interface FakeSessionOptions {
  /** Message history presented to the runner after prompt resolves. */
  messages?: readonly AgentMessageLike[];
  /** Run the session prompt for this long before resolving (default 1ms). */
  delayMs?: number;
  /** Throw this error from prompt (e.g. to simulate an abort/failure). */
  promptError?: Error;
  /** When true, wait until the session's abort() is called, then "resolve". */
  waitForAbort?: boolean;
  /** When true, this session's structured_output tool (if any) is invoked to set capture. */
  callStructuredOutput?: boolean;
}

class FakeSessionFactory {
  calls: Array<{
    options: CreateAgentSessionOptions;
    disposed: boolean;
    aborted: boolean;
  }> = [];
  private readonly behavior: (callIndex: number) => FakeSessionOptions;

  constructor(behavior: (callIndex: number) => FakeSessionOptions) {
    this.behavior = behavior;
  }

  readonly factoryImpl: GraphSessionFactory = async (options: CreateAgentSessionOptions) => {
    const callIndex = this.calls.length;
    const record = { options, disposed: false, aborted: false };
    this.calls.push(record);
    const config = this.behavior(callIndex);
    const session: GraphSession = {
      messages: [],
      async prompt() {
        if (config.waitForAbort) {
          await new Promise<void>((resolve) => {
            const check = () => {
              if (session.aborted) {
                resolve();
                return;
              }
              setTimeout(check, 1);
            };
            check();
          });
          return;
        }
        if (config.promptError) {
          throw config.promptError;
        }
        if (config.callStructuredOutput) {
          const tool = (options.customTools ?? []).find((candidate) => candidate.name === "structured_output");
          if (tool)
            await (tool.execute as (id: string, params: unknown) => Promise<unknown>)("call-1", { verdict: "pass" });
        }
        if (config.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, config.delayMs));
        session.messages = [...(config.messages ?? [])];
      },
      abort() {
        session.aborted = true;
        record.aborted = true;
      },
      dispose() {
        record.disposed = true;
      },
    };
    return session;
  };
}

function makeRequest(
  node: Partial<AgentNode> & { id: string },
  resolvedContext: ResolvedExecutionContext,
  inputArtifacts: readonly RoutedArtifact[] = [],
  signal: AbortSignal = new AbortController().signal,
): NodeExecutionRequest {
  return {
    node: { kind: "agent", prompt: "Do the work.", ...node },
    attempt: 1,
    inputArtifacts,
    resolvedContext,
    parentContext: parent,
    signal,
  };
}

function resolvedFrom(model?: ModelSelector, thinking?: GraphThinkingLevel): ResolvedExecutionContext {
  return resolveExecutionContext({
    node: { model, thinking },
    workflow: undefined,
    parent,
  });
}

const message = (
  role: string,
  content: AgentMessageLike["content"],
  usage?: NonNullable<AgentMessageLike["usage"]>,
  extra: Record<string, unknown> = {},
): AgentMessageLike => ({
  role,
  ...(content !== undefined ? { content } : {}),
  ...(usage !== undefined ? { usage } : {}),
  ...extra,
});

test("explicit node model and thinking are passed to the session", async () => {
  const factory = new FakeSessionFactory(() => ({
    messages: [message("assistant", [{ type: "text", text: "done" }])],
  }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  const explicitModel: ModelSelector = { provider: "test", modelId: "explicit" };
  const resolved = resolvedFrom(explicitModel, "high");
  const result = await runner.execute(makeRequest({ id: "node" }, resolved));
  assert.equal(result.ok, true);
  assert.equal(factory.calls.length, 1);
  const options = factory.calls[0]?.options;
  assert.equal(options?.model, models["test/explicit"], "the registry-resolved Model object is passed");
  assert.equal(options?.thinkingLevel, "high");
});

test("omitted model/thinking inherit the invoking parent context", async () => {
  const factory = new FakeSessionFactory(() => ({
    messages: [message("assistant", [{ type: "text", text: "done" }])],
  }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  const resolved = resolvedFrom(undefined, undefined);
  const result = await runner.execute(makeRequest({ id: "node" }, resolved));
  assert.equal(result.ok, true);
  const options = factory.calls[0]?.options;
  assert.equal(options?.model, models["test/parent-model"], "parent model inherited");
  assert.equal(options?.thinkingLevel, "medium", "parent thinking inherited");
});

test("node override beats role, workflow, and parent at the runner boundary", async () => {
  const factory = new FakeSessionFactory(() => ({
    messages: [message("assistant", [{ type: "text", text: "done" }])],
  }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  // Full frozen precedence stack: node model wins, role thinking wins.
  const resolved = resolveExecutionContext({
    node: { model: { provider: "test", modelId: "explicit" }, thinking: "low" },
    role: { model: { provider: "test", modelId: "role-model" }, thinking: "high" },
    workflow: { model: { provider: "test", modelId: "workflow-model" }, thinking: "xhigh" },
    parent,
  });
  const result = await runner.execute(makeRequest({ id: "node" }, resolved));
  assert.equal(result.ok, true);
  const options = factory.calls[0]?.options;
  assert.equal(options?.model, models["test/explicit"]);
  assert.equal(options?.thinkingLevel, "low");
});

test("unavailable explicit model fails without creating a session", async () => {
  const factory = new FakeSessionFactory(() => ({ messages: [] }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  const resolved = resolvedFrom({ provider: "missing", modelId: "model" });
  const result = await runner.execute(makeRequest({ id: "node" }, resolved));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "model_unavailable");
  assert.equal(factory.calls.length, 0, "no session created for an unavailable model");
});

test("structured output declared without a schema fails loudly before any session", async () => {
  const factory = new FakeSessionFactory(() => ({ messages: [] }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  const node = { id: "structured", outputs: ["structuredOutput"] as const };
  const result = await runner.execute(makeRequest(node, resolvedFrom()));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_state");
  assert.equal(factory.calls.length, 0);
});

test("structured output tool is attached, invoked, and its value becomes structuredOutput", async () => {
  const factory = new FakeSessionFactory(() => ({
    messages: [message("assistant", [{ type: "text", text: "returned" }])],
    callStructuredOutput: true,
  }));
  const runner = new GraphAgentRunner({
    modelRegistry: registry,
    sessionFactory: factory.factoryImpl,
    structuredOutputSchemas: { structured: Type.Object({ verdict: Type.String() }) },
  });
  const node = { id: "structured", outputs: ["structuredOutput"] as const };
  const result = await runner.execute(makeRequest(node, resolvedFrom()));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.output.structuredOutput?.verdict, "pass");
    assert.equal(result.output.finalText, "returned");
  }
  // The structured tool was registered on the session.
  const options = factory.calls[0]?.options;
  assert.ok(options?.customTools?.some((tool) => tool.name === "structured_output"));
});

test("no structured tool is attached when the node does not declare structured output", async () => {
  const factory = new FakeSessionFactory(() => ({
    messages: [message("assistant", [{ type: "text", text: "done" }])],
  }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  const result = await runner.execute(makeRequest({ id: "plain" }, resolvedFrom()));
  assert.equal(result.ok, true);
  const options = factory.calls[0]?.options;
  assert.ok(!options?.customTools?.some((tool) => tool.name === "structured_output"));
});

test("only the final assistant text becomes finalText (thinking/tool/intermediate excluded)", async () => {
  const messages = [
    message("user", "task"),
    message("assistant", [
      { type: "thinking", text: "hidden deliberation" },
      { type: "toolCall", id: "1", name: "bash", arguments: {} },
      { type: "text", text: "intermediate note" },
    ]),
    message("assistant", [
      { type: "thinking", text: "more thinking" },
      { type: "toolCall", id: "2", name: "bash", arguments: {} },
      { type: "text", text: "FINAL ANSWER" },
    ]),
  ];
  const factory = new FakeSessionFactory(() => ({ messages }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  const result = await runner.execute(makeRequest({ id: "node" }, resolvedFrom()));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.output.finalText, "FINAL ANSWER");
});

test("usage is summed across assistant messages into the frozen Usage shape", async () => {
  const messages = [
    message("user", "task"),
    message("assistant", [{ type: "text", text: "one" }], {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 17,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    }),
    message("assistant", [{ type: "text", text: "two" }], {
      input: 3,
      output: 1,
      cacheRead: 0,
      cacheWrite: 4,
      totalTokens: 8,
      cost: { input: 0.03, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.07 },
    }),
  ];
  const factory = new FakeSessionFactory(() => ({ messages }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  const result = await runner.execute(makeRequest({ id: "node" }, resolvedFrom()));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.usage, {
      inputTokens: 19, // 10+2 + 3+4
      outputTokens: 6,
      totalTokens: 25,
      cost: 0.37,
    });
  }
});

test("sessions are disposed on success", async () => {
  const factory = new FakeSessionFactory(() => ({
    messages: [message("assistant", [{ type: "text", text: "done" }])],
  }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  await runner.execute(makeRequest({ id: "node" }, resolvedFrom()));
  assert.equal(factory.calls[0]?.disposed, true);
});

test("sessions are disposed on failure", async () => {
  const factory = new FakeSessionFactory(() => ({ promptError: new Error("provider down") }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  const result = await runner.execute(makeRequest({ id: "node" }, resolvedFrom()));
  assert.equal(result.ok, false);
  assert.equal(factory.calls[0]?.disposed, true, "disposed even when prompt rejects");
});

test("abort during prompt completes as cancelled and disposes the session", async () => {
  const controller = new AbortController();
  const factory = new FakeSessionFactory(() => ({
    waitForAbort: true,
    messages: [message("assistant", [{ type: "text", text: "" }])],
  }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  const request = makeRequest({ id: "node" }, resolvedFrom(), [], controller.signal);
  const resultPromise = runner.execute(request);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  // The session's waitForAbort resolves when abort() fires.
  const result = await resultPromise;
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error.message.includes("cancelled"));
  assert.equal(factory.calls[0]?.aborted, true, "session.abort() was called");
  assert.equal(factory.calls[0]?.disposed, true, "session was disposed after abort");
});

test("timeout aborts the session and reports failure", async () => {
  const factory = new FakeSessionFactory(() => ({
    waitForAbort: true,
    messages: [message("assistant", [{ type: "text", text: "" }])],
  }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl, timeoutMs: 20 });
  const result = await runner.execute(makeRequest({ id: "node" }, resolvedFrom()));
  assert.equal(result.ok, false);
  assert.equal(factory.calls[0]?.aborted, true, "timeout triggered session.abort()");
  assert.equal(factory.calls[0]?.disposed, true);
});

test("input artifacts are embedded into the prompt", async () => {
  const factory = new FakeSessionFactory(() => ({
    messages: [message("assistant", [{ type: "text", text: "consumed" }])],
  }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  const inputs: RoutedArtifact[] = [
    {
      ref: { nodeId: "producer", output: "finalText" },
      artifact: { id: "a", nodeId: "producer", value: "produced text", finalText: "produced text" },
      value: "produced text",
    },
  ];
  await runner.execute(makeRequest({ id: "consumer" }, resolvedFrom(), inputs));
  const options = factory.calls[0]?.options;
  const customTools = options?.customTools ?? [];
  assert.ok(customTools.length > 0, "runner passed base tools");
  assert.ok(
    !customTools.some((tool) => tool.name === "workflow" || tool.name === "subagent" || tool.name.includes("agent")),
    "no nested orchestration tools registered",
  );
});

test("nested orchestration tools are never added to sessions", async () => {
  const factory = new FakeSessionFactory(() => ({
    messages: [message("assistant", [{ type: "text", text: "done" }])],
  }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  const result = await runner.execute(makeRequest({ id: "node" }, resolvedFrom()));
  assert.equal(result.ok, true);
  const toolNames = (factory.calls[0]?.options.customTools ?? []).map((tool) => tool.name);
  assert.ok(!toolNames.includes("workflow"), "no workflow tool");
  assert.ok(!toolNames.includes("workflow_graph"), "no graph tool");
  assert.ok(!toolNames.includes("subagent"), "no subagent tool");
  assert.ok(!toolNames.includes("agent"), "no agent tool");
});

test("finalText is empty when the final assistant message carries no text", async () => {
  const messages = [
    message("user", "task"),
    message("assistant", [{ type: "text", text: "intermediate note" }]),
    message("assistant", [{ type: "toolCall", id: "1", name: "structured_output", arguments: {} }]),
  ];
  const factory = new FakeSessionFactory(() => ({ messages }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  const result = await runner.execute(makeRequest({ id: "node" }, resolvedFrom()));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.output.finalText, "", "must not fall back to an earlier intermediate assistant message");
  }
});

test("a throwing session factory reports failure and never leaks a session", async () => {
  const runner = new GraphAgentRunner({
    modelRegistry: registry,
    sessionFactory: async () => {
      throw new Error("auth storage unavailable");
    },
  });
  const result = await runner.execute(makeRequest({ id: "node" }, resolvedFrom()));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_state");
    assert.match(result.error.message, /failed to create session/);
  }
});

test("executor rejects a malformed result from the session boundary", async () => {
  const factory = new FakeSessionFactory(() => ({
    messages: [message("assistant", [{ type: "toolCall", id: "1", name: "bash", arguments: {} }])],
  }));
  const runner = new GraphAgentRunner({ modelRegistry: registry, sessionFactory: factory.factoryImpl });
  const result = await runner.execute(makeRequest({ id: "node" }, resolvedFrom()));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.output.finalText, "", "no text means empty finalText");
});

test("lastAssistantText handles no assistant messages and mixed content", () => {
  assert.equal(lastAssistantText([]), "");
  assert.equal(lastAssistantText([message("user", "hi")]), "");
  assert.equal(
    lastAssistantText([
      message("assistant", [{ type: "thinking", text: "x" }]),
      message("assistant", [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ]),
    "ab",
  );
  assert.equal(
    lastAssistantText([
      message("assistant", [{ type: "text", text: "  " }]),
      message("assistant", [{ type: "text", text: "" }]),
    ]),
    "",
  );
});

test("graph contract errors carry the expected codes", () => {
  assert.throws(
    () => resolveExecutionContext({ parent: { model: undefined } as never }),
    (error: unknown) => {
      assert.ok(error instanceof GraphContractError);
      return error.code === "missing_parent_model";
    },
  );
});
