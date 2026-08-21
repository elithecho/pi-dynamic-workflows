import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkflowSnapshot,
  formatWorkflowResult,
  recomputeWorkflowSnapshot,
  renderWorkflowLines,
  renderWorkflowText,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "../src/display.js";

function snapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return recomputeWorkflowSnapshot({
    name: "demo_workflow",
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    ...overrides,
  });
}

function agent(overrides: Partial<WorkflowAgentSnapshot> = {}): WorkflowAgentSnapshot {
  return {
    id: 1,
    label: "scan repo",
    phase: "Scan",
    prompt: "Scan the repo",
    status: "done",
    ...overrides,
  };
}

test("createWorkflowSnapshot does not pre-render declared phases", () => {
  const value = createWorkflowSnapshot({
    name: "demo_workflow",
    description: "A useful workflow",
    phases: [{ title: "Scan" }, { title: "Review" }],
  });

  assert.deepEqual(value.phases, []);
});

test("renderWorkflowLines hides empty phase rows", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan", "Review"],
      agents: [agent()],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Scan 1/1")));
  assert.ok(!lines.some((line) => line.includes("Review 0/0")));
});

test("renderWorkflowLines keeps the current empty phase visible", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan"],
      currentPhase: "Scan",
    }),
  );

  assert.ok(lines.some((line) => line.includes("▶ Scan 0/0")));
});

test("renderWorkflowLines groups agents by phase even when the phase was not pre-recorded", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan"],
      agents: [agent({ id: 2, label: "review diff", phase: "Review" })],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Review 1/1")));
  assert.ok(!lines.some((line) => line.trim() === "Unphased"));
});

test("renderWorkflowLines renders runtime-created phases from the phase list", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Inspect API"],
      agents: [agent({ label: "inspect api", phase: "Inspect API" })],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Inspect API 1/1")));
});

test("renderWorkflowText shows completed string results", () => {
  const text = renderWorkflowText(snapshot({ result: "final answer" }), true);

  assert.match(text, /Final result:\nfinal answer/);
});

test("renderWorkflowText shows completed structured, empty, and undefined results", () => {
  assert.match(renderWorkflowText(snapshot({ result: { ok: true, items: [1, 2] } }), true), /"ok": true/);
  assert.match(renderWorkflowText(snapshot({ result: "" }), true), /Final result:\n$/);
  assert.match(renderWorkflowText(snapshot({ result: undefined }), true), /Final result:\nundefined/);
});

test("renderWorkflowText does not expose a running result", () => {
  const text = renderWorkflowText(snapshot({ result: "secret" }), false);

  assert.doesNotMatch(text, /Final result|secret/);
});

test("formatWorkflowResult honors zero, one, and marker-length bounds", () => {
  const value = "0123456789abcdef";

  assert.equal(formatWorkflowResult(value, 0), "");
  assert.equal(formatWorkflowResult(value, 1), "…");
  assert.equal(formatWorkflowResult(value, 13), "… [truncated]");
  assert.equal(formatWorkflowResult(value, 14), "0… [truncated]");
  assert.ok(formatWorkflowResult(value, 14).length <= 14);
});

test("formatWorkflowResult bounds circular and bigint values", () => {
  const circular: { self?: unknown; value?: bigint } = { value: 1n };
  circular.self = circular;
  const text = formatWorkflowResult(circular, 40);

  assert.match(text, /\[Circular\]|truncated/);
  assert.ok(text.length <= 40);
  assert.match(formatWorkflowResult({ value: 1n }), /1n/);
});

test("renderWorkflowText respects log limits", () => {
  const text = renderWorkflowText(
    snapshot({
      logs: ["first", "second", "third"],
    }),
    true,
    { maxLogs: 1 },
  );

  assert.doesNotMatch(text, /log: first/);
  assert.doesNotMatch(text, /log: second/);
  assert.match(text, /log: third/);
});

test("renderWorkflowLines separates logs from progress", () => {
  const lines = renderWorkflowLines(
    snapshot({
      agents: [agent()],
      logs: ["finished scan"],
    }),
  );

  const logIndex = lines.findIndex((line) => line.includes("log: finished scan"));
  assert.ok(logIndex > 0);
  assert.equal(lines[logIndex - 1], "");
});
