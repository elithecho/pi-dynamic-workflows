import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GraphRunSnapshot } from "../src/graph.js";
import { createWidgetGraphDisplay, renderGraphSnapshotLines, renderGraphSnapshotText } from "../src/graph-display.js";

function runningSnapshot(): GraphRunSnapshot {
  return {
    runId: "run-1",
    graphId: "chain",
    state: "running",
    nodes: [
      { id: "a", attempt: 1, artifactIds: [], state: "succeeded" },
      { id: "b", attempt: 1, artifactIds: [], state: "skipped", skipReason: "route_not_selected" },
      {
        id: "c",
        attempt: 2,
        artifactIds: [],
        state: "failed",
        error: { code: "model_unavailable", message: "no model" },
      },
    ],
    artifacts: [],
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  };
}

test("renderGraphSnapshotLines renders the header, node lines, and usage", () => {
  const lines = renderGraphSnapshotLines(runningSnapshot());
  assert.equal(lines.length, 5);
  assert.ok(lines[0].includes("◆ workflow_graph:"));
  assert.ok(lines[0].includes("chain (run-1) — running"));
  const joined = lines.join("\n");
  assert.ok(joined.includes("✓ a [succeeded] attempt 1"));
  assert.ok(joined.includes("- b [skipped] attempt 1 (reason: route_not_selected)"));
  assert.ok(joined.includes("✗ c [failed] attempt 2 (error: model_unavailable)"));
  assert.ok(joined.includes("  usage: 1 in / 2 out"));
});

test("renderGraphSnapshotLines includes cost when the usage defines one", () => {
  const snapshot: GraphRunSnapshot = {
    ...runningSnapshot(),
    usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11, cost: 0.0123 },
  };
  const lines = renderGraphSnapshotLines(snapshot);
  assert.ok(lines.some((line) => line.includes("  usage: 5 in / 6 out, $0.0123")));
});

test("renderGraphSnapshotText header reflects the completed state", () => {
  const succeeded: GraphRunSnapshot = { ...runningSnapshot(), state: "succeeded" };
  assert.ok(renderGraphSnapshotText(succeeded, true).startsWith("workflow_graph run run-1 completed"));
  const failed: GraphRunSnapshot = {
    ...runningSnapshot(),
    state: "failed",
    error: { code: "invalid_state", message: "boom" },
  };
  assert.ok(renderGraphSnapshotText(failed, true).startsWith("workflow_graph run run-1 failed"));
  assert.ok(renderGraphSnapshotText(runningSnapshot(), false).startsWith("workflow_graph run run-1 running"));
});

interface UiCall {
  readonly kind: "setWidget" | "setStatus" | "notify";
  readonly key: string;
  readonly value?: unknown;
  readonly options?: { readonly placement?: string };
  readonly type?: string;
}

function recordingUi(): {
  readonly ui: {
    setWidget(key: string, content: string[] | undefined, options?: { readonly placement?: string }): void;
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, type: "info" | "warning" | "error"): void;
  };
  readonly calls: UiCall[];
} {
  const calls: UiCall[] = [];
  const ui = {
    setWidget(key: string, content: string[] | undefined, options?: { readonly placement?: string }) {
      calls.push({ kind: "setWidget", key, value: content, options });
    },
    setStatus(key: string, text: string | undefined) {
      calls.push({ kind: "setStatus", key, value: text });
    },
    notify(message: string, type: "info" | "warning" | "error") {
      calls.push({ kind: "notify", key: message, type });
    },
  };
  return { ui, calls };
}

test("createWidgetGraphDisplay updates the widget and status and notifies on completion", () => {
  const { ui, calls } = recordingUi();
  const ctx = { ui, hasUI: true } as unknown as Pick<ExtensionContext, "ui" | "hasUI">;
  const display = createWidgetGraphDisplay(ctx);

  display.update(runningSnapshot());
  const widgetUpdate = calls.find((call) => call.kind === "setWidget");
  assert.ok(widgetUpdate);
  assert.equal((widgetUpdate.value as string[])[0], "◆ workflow_graph: chain (run-1) — running");
  assert.equal(widgetUpdate.options?.placement, "belowEditor");
  assert.ok(calls.some((call) => call.kind === "setStatus" && call.value === "workflow_graph run-1: running"));

  calls.length = 0;
  display.complete({
    ...runningSnapshot(),
    state: "failed",
    error: { code: "invalid_state", message: "boom" },
  });
  const failedNotify = calls.find((call) => call.kind === "notify");
  assert.equal(failedNotify?.type, "error");
  assert.equal(failedNotify?.key, "workflow_graph run-1 failed");

  calls.length = 0;
  display.complete({
    ...runningSnapshot(),
    state: "cancelled",
    cancellation: { requested: true, reason: "requested" },
  });
  assert.equal(calls.find((call) => call.kind === "notify")?.type, "warning");

  calls.length = 0;
  display.complete({ ...runningSnapshot(), state: "succeeded" });
  assert.equal(calls.find((call) => call.kind === "notify")?.type, "info");

  calls.length = 0;
  display.clear();
  assert.ok(calls.some((call) => call.kind === "setWidget" && call.value === undefined));
  assert.ok(calls.some((call) => call.kind === "setStatus" && call.value === undefined));
});

test("createWidgetGraphDisplay is a no-op without UI", () => {
  const { ui, calls } = recordingUi();
  const ctx = { ui, hasUI: false } as unknown as Pick<ExtensionContext, "ui" | "hasUI">;
  const display = createWidgetGraphDisplay(ctx);
  display.update(runningSnapshot());
  display.complete(runningSnapshot());
  display.clear();
  assert.deepEqual(calls, []);
});
