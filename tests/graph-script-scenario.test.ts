/**
 * Scenario-E acceptance tests: the v1 Graph JS DSL compiled by
 * `compileGraphScript` proven end-to-end through the real graph runtime
 * (`runGraph`) and through the real `workflow_graph` tool.
 *
 * Uses the two frozen ADR fixtures: the `fix_or_ship` canonical change/pass
 * routing example (ADR §6) and the `audit` fan-out example (ADR §7), all with
 * fake executors and hermetic tool contexts — no src modifications.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GraphRunSnapshot, InvokingParentExecutionContext, NodeSnapshot } from "../src/graph.js";
import { GraphRunRegistry } from "../src/graph-registry.js";
import type { NodeExecutionRequest, NodeExecutor, NodeExecutorResult } from "../src/graph-runtime.js";
import { runGraph } from "../src/graph-runtime.js";
import { compileGraphScript } from "../src/graph-script.js";
import { createWorkflowGraphTool } from "../src/graph-tool.js";

const FIX_OR_SHIP_SCRIPT = `export const meta = { name: 'fix_or_ship', description: 'Coder → review → fix then ship, or ship directly.' }

const coder  = agent('You are a coder agent. Read the coder skill and implement the change.', { role: 'implementation' })
const review = agent('Review the change. Respond with exactly <verdict>change</verdict> or <verdict>pass</verdict>.', { role: 'reviewer' })
const fixer  = agent('Apply the requested changes.', { role: 'implementation' })
const done   = agent('Finalize and report.', { role: 'verifier' })

coder.to(review)
review.when('<verdict>change</verdict>', fixer).otherwise(done)
fixer.to(done)`;

const AUDIT_SCRIPT = `export const meta = { name: 'audit', description: 'Scan, then three analyses, then synthesize.' }

const scan   = agent('Inventory the repo.')
const facts  = agent('Collect facts about structure.')
const risks  = agent('Collect risks about security.')
const dups   = agent('Find duplicated responsibility.')
const report = agent('Synthesize the three analyses.')

scan.to(facts)
scan.to(risks)
scan.to(dups)
facts.to(report)
risks.to(report)
dups.to(report)

budget({ maxConcurrency: 3 })`;

const PARENT: InvokingParentExecutionContext = { model: { provider: "test", modelId: "parent" }, thinking: "medium" };

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

interface RecordedCall {
  readonly nodeId: string;
  readonly attempt: number;
  readonly inputs: Array<{ nodeId: string; output: string; value: unknown }>;
}

/** Fake executor with per-node finalText outputs and an optional per-node delay. */
class ScenarioExecutor implements NodeExecutor {
  readonly calls: RecordedCall[] = [];
  private active = 0;
  maxConcurrent = 0;

  constructor(
    private readonly finalTexts: Readonly<Record<string, string>>,
    private readonly delayMs = 0,
  ) {}

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
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return { ok: true, output: { finalText: this.finalTexts[request.node.id] ?? "" } };
    } finally {
      this.active -= 1;
    }
  }
}

/** Fake executor that can hold a node open until explicitly released. */
class DeferredExecutor implements NodeExecutor {
  readonly calls: Array<{ nodeId: string }> = [];
  private readonly releases = new Map<string, () => void>();

  constructor(private readonly finalTexts: Readonly<Record<string, string>>) {}

  defer(nodeId: string): void {
    this.releases.set(nodeId, () => {});
  }

  release(nodeId: string): void {
    this.releases.get(nodeId)?.();
    this.releases.delete(nodeId);
  }

  async execute(request: NodeExecutionRequest): Promise<NodeExecutorResult> {
    this.calls.push({ nodeId: request.node.id });
    if (this.releases.has(request.node.id)) {
      await new Promise<void>((resolve) => this.releases.set(request.node.id, resolve));
    }
    return { ok: true, output: { finalText: this.finalTexts[request.node.id] ?? "" } };
  }
}

function nodeIn(snapshot: GraphRunSnapshot, nodeId: string): NodeSnapshot {
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
  assert.ok(node, `snapshot is missing node ${nodeId}`);
  return node;
}

function recordedInputs(executor: ScenarioExecutor, nodeId: string): RecordedCall["inputs"] {
  const call = executor.calls.find((candidate) => candidate.nodeId === nodeId);
  assert.ok(call, `node ${nodeId} was never invoked`);
  return call.inputs;
}

/** Hermetic tool context for testing the tool's own terminal callback seam. */
function fakeToolCtx(): ExtensionContext {
  const context = {
    cwd: process.cwd(),
    model: { provider: "test", id: "parent" },
    modelRegistry: {
      find(provider: string, id: string) {
        return provider === "test" && id === "parent" ? { id: "parent", provider: "test", name: "x" } : undefined;
      },
    },
    ui: {
      setWidget(_key: string, _content: string[] | undefined) {},
      setStatus(_key: string, _text: string | undefined) {},
      notify(_message: string, _type: string) {},
    },
    hasUI: true,
    signal: undefined,
    sendMessage() {},
    sendUserMessage() {},
  };
  return context as unknown as ExtensionContext;
}

test("scenario E1: change path routes review → fixer → done_join and done receives { fixer }", async () => {
  const executor = new ScenarioExecutor({
    coder: "implemented the change",
    review: "<verdict>change</verdict>",
    fixer: "changes applied",
    done: "shipped",
  });
  const snapshot = await runGraph(compileGraphScript(FIX_OR_SHIP_SCRIPT), { executor, parentContext: PARENT });

  assert.equal(snapshot.state, "succeeded");
  assert.equal(nodeIn(snapshot, "fixer").state, "succeeded");
  assert.equal(executor.count("fixer"), 1, "fixer must run exactly once on the change path");
  assert.equal(executor.count("done"), 1, "done must run exactly once on the change path");

  const doneInputs = recordedInputs(executor, "done");
  assert.deepEqual(doneInputs, [{ nodeId: "done_join", output: "value", value: { fixer: "changes applied" } }]);
  assert.ok(
    !("review" in (doneInputs[0]?.value as Record<string, unknown>)),
    "review must not appear in done's join value on the change path",
  );
});

test("scenario E2: pass path skips fixer via route_not_selected and done receives { review }", async () => {
  const executor = new ScenarioExecutor({
    coder: "implemented the change",
    review: "<verdict>pass</verdict>",
    done: "verified",
  });
  const snapshot = await runGraph(compileGraphScript(FIX_OR_SHIP_SCRIPT), { executor, parentContext: PARENT });

  assert.equal(snapshot.state, "succeeded");
  assert.equal(executor.count("fixer"), 0, "fixer must never run on the pass path");
  const fixerNode = nodeIn(snapshot, "fixer");
  assert.equal(fixerNode.state, "skipped");
  assert.equal(fixerNode.skipReason, "route_not_selected");

  assert.equal(executor.count("done"), 1, "done must still run once on the pass path");
  assert.deepEqual(recordedInputs(executor, "done"), [
    { nodeId: "done_join", output: "value", value: { review: "<verdict>pass</verdict>" } },
  ]);
});

test("scenario E3: audit fan-out runs facts/risks/dups concurrently and report joins all three", async () => {
  const executor = new ScenarioExecutor(
    {
      scan: "scanned",
      facts: "fact one",
      risks: "risk one",
      dups: "dup one",
      report: "synthesized",
    },
    15,
  );
  const snapshot = await runGraph(compileGraphScript(AUDIT_SCRIPT), { executor, parentContext: PARENT });

  assert.equal(snapshot.state, "succeeded");
  assert.ok(
    executor.maxConcurrent >= 2,
    `expected the three analyses to overlap, observed max concurrency ${executor.maxConcurrent}`,
  );
  assert.equal(executor.count("report"), 1, "report must run exactly once");
  assert.deepEqual(recordedInputs(executor, "report"), [
    { nodeId: "report_join", output: "value", value: { facts: "fact one", risks: "risk one", dups: "dup one" } },
  ]);
});

test("scenario E4: tool start returns early and terminal callback excludes intermediate outputs", async () => {
  const executor = new DeferredExecutor({
    coder: "implemented",
    review: "<verdict>change</verdict>",
    fixer: "applied",
    done: "shipped",
  });
  executor.defer("review");
  const completions: GraphRunSnapshot[] = [];
  const tool = createWorkflowGraphTool({
    executor,
    registry: new GraphRunRegistry(),
    getThinkingLevel: () => "medium",
    onTerminalCompletion: (snapshot) => {
      completions.push(snapshot);
    },
  });
  const ctx = fakeToolCtx();

  const prepared = tool.prepareArguments?.({ operation: "start", script: FIX_OR_SHIP_SCRIPT });
  assert.ok(prepared !== undefined);
  const started = await tool.execute("call-1", prepared, undefined, undefined, ctx);
  const startDetails = started.details as { ok: true; result: { runId: string; state: string } };
  assert.equal(startDetails.ok, true);
  assert.ok(startDetails.result.runId.length > 0);
  assert.equal(startDetails.result.state, "running");

  await tick();
  assert.deepEqual(
    executor.calls.map((call) => call.nodeId),
    ["coder", "review"],
    "start must return while review is still running, before fixer/done are reached",
  );

  executor.release("review");
  const waited = await tool.execute(
    "call-2",
    { operation: "wait", runId: startDetails.result.runId, timeoutMs: 2000 },
    undefined,
    undefined,
    ctx,
  );
  const waitDetails = waited.details as { result: { completed: boolean; run: GraphRunSnapshot } };
  assert.equal(waitDetails.result.completed, true);
  assert.equal(waitDetails.result.run.state, "succeeded");

  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.finalAnswer, "shipped");
  assert.doesNotMatch(completions[0]?.finalAnswer ?? "", /implemented|applied/);
});

test("scenario E5: start inputs are mutually exclusive and script errors surface their code", () => {
  const tool = createWorkflowGraphTool({ getThinkingLevel: () => "medium" });

  assert.throws(
    () =>
      tool.prepareArguments?.({
        operation: "start",
        script: FIX_OR_SHIP_SCRIPT,
        definition: { nodes: [], routes: [] },
      }),
    /mutually exclusive/,
  );
  assert.throws(() => tool.prepareArguments?.({ operation: "start" }), /requires exactly one/);

  const useBeforeDeclaration = `export const meta = { name: 'x', description: 'y' }
const x = agent('X')
y.to(x)
const y = agent('Y')`;
  assert.throws(
    () => tool.prepareArguments?.({ operation: "start", script: useBeforeDeclaration }),
    /script_use_before_declaration/,
  );
});
