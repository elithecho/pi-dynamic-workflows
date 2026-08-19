/**
 * Tracer-bullet scenario fixtures for the staged-workflow graph: the pass
 * path, the non-pass remediation path, and predicate safety (finalText-only
 * matching) with regex validation and bounded input.
 *
 * Note on relay absence: Scenario 3's "instrumentation proves no
 * pi.sendMessage / parent follow-up relay" requirement is covered by
 * `tests/graph-tool.test.ts` — the "tool never relays node output through the
 * main agent" test spies on `sendMessage`/`sendUserMessage` and asserts that
 * completion surfaces only via `ctx.ui.notify`. This file therefore focuses
 * on predicate safety, regex rejection, and bounded-input matching.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FINAL_TEXT_PATTERN,
  GraphContractError,
  type GraphRunSnapshot,
  type InvokingParentExecutionContext,
  MAX_FINAL_TEXT_INPUT_LENGTH,
  type ModelRegistryLike,
  matchesFinalText,
  type NodeSnapshot,
} from "../src/graph.js";
import {
  type AgentMessageLike,
  GraphAgentRunner,
  type GraphSession,
  type GraphSessionFactory,
  lastAssistantText,
} from "../src/graph-agent.js";
import type { NodeExecutionRequest, NodeExecutor, NodeExecutorResult } from "../src/graph-runtime.js";
import { runGraph } from "../src/graph-runtime.js";
import { compileStagedWorkflowGraph, type StagedWorkflowPolicy } from "../src/staged-workflow.js";

const parent: InvokingParentExecutionContext = { model: { provider: "test", modelId: "parent" }, thinking: "medium" };

function makePolicy(overrides: Partial<StagedWorkflowPolicy> = {}): StagedWorkflowPolicy {
  return {
    name: "scenario",
    implementationPrompt: "IMPL",
    reviewerPrompt: "REV",
    remediationPrompt: "FIX",
    verificationPrompt: "VERIFY",
    ...overrides,
  };
}

interface RecordedCall {
  readonly nodeId: string;
  readonly attempt: number;
  readonly inputs: Array<{ readonly nodeId: string; readonly output: string; readonly value: unknown }>;
}

class RecordingExecutor implements NodeExecutor {
  readonly calls: RecordedCall[] = [];
  private readonly outputs: Map<string, string>;

  constructor(outputs: Readonly<Record<string, string>> = {}) {
    this.outputs = new Map(Object.entries(outputs));
  }

  count(nodeId: string): number {
    return this.calls.filter((call) => call.nodeId === nodeId).length;
  }

  async execute(request: NodeExecutionRequest): Promise<NodeExecutorResult> {
    this.calls.push({
      nodeId: request.node.id,
      attempt: request.attempt,
      inputs: request.inputArtifacts.map((routed) => ({
        nodeId: routed.ref.nodeId,
        output: routed.ref.output,
        value: routed.value,
      })),
    });
    return { ok: true, output: { finalText: this.outputs.get(request.node.id) ?? "" } };
  }
}

function nodeIn(snapshot: GraphRunSnapshot, nodeId: string): NodeSnapshot {
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
  assert.ok(node, `snapshot is missing node ${nodeId}`);
  return node;
}

function recordedInputs(executor: RecordingExecutor, nodeId: string): RecordedCall["inputs"] {
  const call = executor.calls.find((candidate) => candidate.nodeId === nodeId);
  assert.ok(call, `node ${nodeId} was never invoked`);
  return call.inputs;
}

function agentFinalText(snapshot: GraphRunSnapshot, nodeId: string): string {
  const artifact = snapshot.artifacts.find((candidate) => candidate.nodeId === nodeId);
  assert.ok(artifact, `snapshot is missing artifact from ${nodeId}`);
  if (!("finalText" in artifact)) throw new Error(`artifact from ${nodeId} has no finalText`);
  return artifact.finalText;
}

function skipReasonOf(snapshot: GraphRunSnapshot, nodeId: string): string | undefined {
  const node = nodeIn(snapshot, nodeId);
  assert.equal(node.state, "skipped");
  return node.skipReason;
}

test("scenario 1: pass path skips remediation and routes review_1 through the join to final verification", async () => {
  const executor = new RecordingExecutor({
    implementation: "built it",
    review_1: "<verdict>pass</verdict>",
    final_verification: "verified",
  });
  const snapshot = await runGraph(compileStagedWorkflowGraph(makePolicy()), { executor, parentContext: parent });

  assert.equal(snapshot.state, "succeeded");
  assert.equal(nodeIn(snapshot, "final_verification").state, "succeeded");

  assert.equal(skipReasonOf(snapshot, "remediation_1"), "route_not_selected");
  assert.equal(skipReasonOf(snapshot, "review_2"), "route_not_selected");

  assert.equal(executor.count("remediation_1"), 0, "remediation must never run on the pass path");
  assert.equal(executor.count("review_2"), 0, "review_2 must never run on the pass path");

  assert.equal(executor.count("final_verification"), 1);
  assert.deepEqual(recordedInputs(executor, "final_verification"), [
    { nodeId: "final_verification_join", output: "value", value: { review_1: "<verdict>pass</verdict>" } },
  ]);

  assert.deepEqual(recordedInputs(executor, "review_1"), [
    { nodeId: "implementation", output: "finalText", value: "built it" },
  ]);
});

test("scenario 2: non-pass path runs remediation on review_1 finalText and joins the selected branch", async () => {
  const executor = new RecordingExecutor({
    implementation: "built it",
    review_1: "<verdict>fail</verdict>",
    remediation_1: "fixed it",
    review_2: "<verdict>pass</verdict>",
    final_verification: "verified",
  });
  const snapshot = await runGraph(compileStagedWorkflowGraph(makePolicy()), { executor, parentContext: parent });

  assert.equal(snapshot.state, "succeeded");

  assert.equal(executor.count("remediation_1"), 1);
  assert.deepEqual(recordedInputs(executor, "remediation_1"), [
    { nodeId: "review_1", output: "finalText", value: "<verdict>fail</verdict>" },
  ]);

  assert.deepEqual(
    executor.calls.map((call) => call.nodeId),
    ["implementation", "review_1", "remediation_1", "review_2", "final_verification"],
  );

  assert.equal(executor.count("review_2"), 1);
  assert.deepEqual(recordedInputs(executor, "review_2"), [
    { nodeId: "remediation_1", output: "finalText", value: "fixed it" },
  ]);

  assert.deepEqual(recordedInputs(executor, "final_verification"), [
    { nodeId: "final_verification_join", output: "value", value: { review_2: "<verdict>pass</verdict>" } },
  ]);
});

test("scenario 3: predicate safety and bounded matching", async (t) => {
  await t.test("3a — thinking/tool content cannot trigger the final-text edge", async (t2) => {
    await t2.test("unit: lastAssistantText returns only the last assistant text message", () => {
      const messages: AgentMessageLike[] = [
        { role: "assistant", content: [{ type: "text", text: "<verdict>pass</verdict>" }] },
        { role: "assistant", content: [{ type: "reasoning", text: "<verdict>pass</verdict>" }] },
        { role: "tool", content: [{ type: "toolResult", text: "<verdict>pass</verdict>" }] },
        { role: "assistant", content: [{ type: "text", text: "Needs more work." }] },
      ];
      assert.equal(lastAssistantText(messages), "Needs more work.");
      // A text-free final assistant message yields "" rather than backing up.
      assert.equal(
        lastAssistantText([
          { role: "assistant", content: [{ type: "text", text: "intermediate" }] },
          { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }] },
        ]),
        "",
      );
    });

    await t2.test("end-to-end: reasoning/tool verdicts do not select the pass route", async () => {
      const fakeFactory: GraphSessionFactory = async () => {
        const session: GraphSession = {
          messages: [],
          async prompt(input: string) {
            if (input.includes("Artifact from implementation (finalText)")) {
              session.messages = [
                { role: "assistant", content: [{ type: "reasoning", text: "thinking: <verdict>pass</verdict>" }] },
                { role: "tool", content: ["<verdict>pass</verdict>"] },
                { role: "assistant", content: [{ type: "text", text: "Needs more work." }] },
              ];
            } else if (input.includes("Artifact from remediation_1 (finalText)")) {
              session.messages = [{ role: "assistant", content: [{ type: "text", text: "<verdict>pass</verdict>" }] }];
            } else if (input.includes("Artifact from final_verification_join (value)")) {
              session.messages = [{ role: "assistant", content: [{ type: "text", text: "Verified." }] }];
            } else {
              session.messages = [{ role: "assistant", content: [{ type: "text", text: "built it" }] }];
            }
          },
          abort() {},
          dispose() {},
        };
        return session;
      };
      const runner = new GraphAgentRunner({
        cwd: process.cwd(),
        modelRegistry: { find: (provider: string, modelId: string) => ({ id: modelId, provider }) as never },
        tools: [],
        sessionFactory: fakeFactory,
      });
      const preflightRegistry: ModelRegistryLike = {
        find: (provider: string, modelId: string) =>
          provider === "test" && modelId === "parent" ? { provider, modelId } : undefined,
      };
      const snapshot = await runGraph(compileStagedWorkflowGraph(makePolicy()), {
        executor: runner,
        parentContext: parent,
        modelRegistry: preflightRegistry,
      });

      assert.equal(snapshot.state, "succeeded");
      assert.equal(nodeIn(snapshot, "remediation_1").state, "succeeded");
      assert.equal(nodeIn(snapshot, "review_2").state, "succeeded");
      assert.equal(agentFinalText(snapshot, "review_1"), "Needs more work.");
    });
  });

  await t.test("3b — malformed regex is rejected", () => {
    assert.throws(
      () => compileStagedWorkflowGraph(makePolicy({ finalTextPattern: "a|b" })),
      (error: unknown) => error instanceof GraphContractError && error.code === "invalid_regex",
    );
    assert.throws(
      () => matchesFinalText({ type: "finalText", regex: { source: "finalText", pattern: "[unclosed" } }, "x"),
      (error: unknown) => error instanceof GraphContractError && error.code === "invalid_regex",
    );
  });

  await t.test("3c — finalText matching is bounded to MAX_FINAL_TEXT_INPUT_LENGTH", () => {
    const pattern = {
      type: "finalText" as const,
      regex: { source: "finalText" as const, pattern: DEFAULT_FINAL_TEXT_PATTERN },
    };
    // A long input whose verdict sits inside the bounded slice still matches.
    assert.equal(matchesFinalText(pattern, `${"x".repeat(32_000)}<verdict>pass</verdict>${"x".repeat(50_000)}`), true);
    // A long whitespace input is sliced before the match: it completes (no
    // hang/catastrophic backtracking) and reports no match.
    assert.equal(matchesFinalText(pattern, "\n".repeat(MAX_FINAL_TEXT_INPUT_LENGTH + 10_000)), false);
    // The verdict landing beyond the slice does NOT match: the bound applies.
    assert.equal(matchesFinalText(pattern, `${"x".repeat(MAX_FINAL_TEXT_INPUT_LENGTH)}<verdict>pass</verdict>`), false);
  });
});
