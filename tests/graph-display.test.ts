import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GraphRunSnapshot, GraphRunSnapshotBase } from "../src/graph.js";
import {
  createWidgetGraphDisplay,
  formatGraphElapsed,
  renderGraphSnapshotLines,
  renderGraphSnapshotText,
} from "../src/graph-display.js";

function snapshotBase(): GraphRunSnapshotBase {
  return {
    runId: "run-1",
    graphId: "chain",
    startedAtEpochMs: 1_000,
    elapsedMs: 65_000,
    turnCount: 2,
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

function runningSnapshot(): GraphRunSnapshot {
  return { ...snapshotBase(), state: "running" };
}

test("formatGraphElapsed uses compact second and minute boundaries", () => {
  assert.equal(formatGraphElapsed(0), "0s");
  assert.equal(formatGraphElapsed(999), "0s");
  assert.equal(formatGraphElapsed(1_000), "1s");
  assert.equal(formatGraphElapsed(59_999), "59s");
  assert.equal(formatGraphElapsed(60_000), "1m 0s");
  assert.equal(formatGraphElapsed(61_000), "1m 1s");
  assert.equal(formatGraphElapsed(3_599_999), "59m 59s");
  assert.equal(formatGraphElapsed(3_600_000), "1h 0m 0s");
  assert.equal(formatGraphElapsed(-1), "0s");
  assert.equal(formatGraphElapsed(Number.NaN), "0s");
  assert.equal(formatGraphElapsed(Number.POSITIVE_INFINITY), "0s");
});

test("renderGraphSnapshotLines renders the header, node lines, and usage", () => {
  const lines = renderGraphSnapshotLines(runningSnapshot());
  assert.equal(lines.length, 5);
  assert.ok(lines[0].includes("◆ workflow_graph:"));
  assert.ok(lines[0].includes("chain (run-1) — running ⟳ — turns 2 — elapsed 1m 5s"));
  const joined = lines.join("\n");
  assert.ok(joined.includes("✓ a [succeeded] attempt 1"));
  assert.ok(joined.includes("- b [skipped] attempt 1 (reason: route_not_selected)"));
  assert.ok(joined.includes("✗ c [failed] attempt 2 (error: model_unavailable)"));
  assert.ok(joined.includes("  usage: 1 in / 2 out"));
});

test("renderGraphSnapshotLines includes cost when the usage defines one", () => {
  const snapshot: GraphRunSnapshot = {
    ...snapshotBase(),
    state: "running",
    usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11, cost: 0.0123 },
  };
  const lines = renderGraphSnapshotLines(snapshot);
  assert.ok(lines.some((line) => line.includes("  usage: 5 in / 6 out, $0.0123")));
});

test("renderGraphSnapshotText exposes the bounded final answer for successful runs", () => {
  const succeeded: GraphRunSnapshot = {
    ...snapshotBase(),
    state: "succeeded",
    finalAnswer: `answer:${"x".repeat(5_000)}`,
  };
  const succeededText = renderGraphSnapshotText(succeeded, true);
  assert.ok(succeededText.startsWith("workflow_graph run run-1 completed"));
  assert.match(succeededText, /Final answer:\nanswer:/);
  assert.match(succeededText, /… \[truncated\]/);
  assert.ok(succeededText.length < succeeded.finalAnswer.length);

  const runningText = renderGraphSnapshotText(runningSnapshot(), false);
  assert.ok(runningText.startsWith("workflow_graph run run-1 running"));
  assert.doesNotMatch(runningText, /Final answer:/);
  const failed: GraphRunSnapshot = {
    ...snapshotBase(),
    state: "failed",
    error: { code: "invalid_state", message: "boom" },
  };
  assert.ok(renderGraphSnapshotText(failed, true).startsWith("workflow_graph run run-1 failed"));
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
    setWidget(key: string, content: unknown, options?: { readonly placement?: string }): void;
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, type: "info" | "warning" | "error"): void;
  };
  readonly calls: UiCall[];
  readonly disposedWidgetKeys: string[];
} {
  const calls: UiCall[] = [];
  const disposedWidgetKeys: string[] = [];
  const activeWidgets = new Map<string, { dispose?(): void }>();
  const ui = {
    setWidget(key: string, content: unknown, options?: { readonly placement?: string }) {
      activeWidgets.get(key)?.dispose?.();
      activeWidgets.delete(key);
      if (typeof content === "function") {
        const factory = content as (tui: { requestRender(): void }, theme: unknown) => { dispose?(): void };
        const component = factory({ requestRender() {} }, {});
        activeWidgets.set(key, {
          dispose() {
            component.dispose?.();
            disposedWidgetKeys.push(key);
          },
        });
      }
      calls.push({ kind: "setWidget", key, value: content, options });
    },
    setStatus(key: string, text: string | undefined) {
      calls.push({ kind: "setStatus", key, value: text });
    },
    notify(message: string, type: "info" | "warning" | "error") {
      calls.push({ kind: "notify", key: message, type });
    },
  };
  return { ui, calls, disposedWidgetKeys };
}

test("createWidgetGraphDisplay updates the widget and status and notifies on completion", () => {
  const { ui, calls, disposedWidgetKeys } = recordingUi();
  const ctx = { ui, hasUI: true } as unknown as Pick<ExtensionContext, "ui" | "hasUI">;
  let displayMonotonicNow = 1_000;
  const display = createWidgetGraphDisplay(ctx, { monotonicNow: () => displayMonotonicNow });

  display.update(runningSnapshot());
  const widgetUpdate = calls.find((call) => call.kind === "setWidget");
  assert.ok(widgetUpdate);
  assert.equal(widgetUpdate.key, "workflow_graph:run-1");
  assert.equal(widgetUpdate.options?.placement, "belowEditor");
  const factoryUpdate = calls.filter((call) => call.kind === "setWidget")[1];
  assert.ok(factoryUpdate && typeof factoryUpdate.value === "function");
  const widgetFactory = factoryUpdate.value as (
    tui: unknown,
    theme: unknown,
  ) => { render(width: number): string[]; dispose(): void };
  const widget = widgetFactory({ requestRender() {} }, {});
  assert.match(widget.render(120)[0] ?? "", /running ⠋ — turns 2 — elapsed 1m 5s/);
  displayMonotonicNow = 61_000;
  assert.match(widget.render(120)[0] ?? "", /running ⠋ — turns 2 — elapsed 2m 5s/);
  displayMonotonicNow = 2_000;
  assert.match(widget.render(120)[0] ?? "", /running ⠋ — turns 2 — elapsed 2m 5s/);
  widget.dispose();
  assert.ok(
    calls.some((call) => call.kind === "setStatus" && call.value === "workflow_graph run-1: running • turns 2"),
  );

  calls.length = 0;
  display.complete({
    ...snapshotBase(),
    state: "failed",
    error: { code: "invalid_state", message: "boom" },
  });
  const failedNotify = calls.find((call) => call.kind === "notify");
  assert.equal(failedNotify?.type, "error");
  assert.equal(failedNotify?.key, "workflow_graph run-1 failed");
  assert.ok(disposedWidgetKeys.includes("workflow_graph:run-1"), "terminal replacement disposes the spinner widget");

  calls.length = 0;
  display.complete({
    ...snapshotBase(),
    state: "cancelled",
    cancellation: { requested: true, reason: "requested" },
  });
  assert.equal(calls.find((call) => call.kind === "notify")?.type, "warning");

  calls.length = 0;
  display.complete({ ...snapshotBase(), state: "succeeded", finalAnswer: "done" });
  assert.equal(calls.find((call) => call.kind === "notify")?.type, "info");
  const completedWidget = calls.find((call) => call.kind === "setWidget");
  assert.match((completedWidget?.value as string[]).join("\n"), /Final answer:\ndone/);

  calls.length = 0;
  display.clear();
  assert.ok(calls.some((call) => call.kind === "setWidget" && call.value === undefined));
  assert.ok(calls.some((call) => call.kind === "setStatus" && call.value === undefined));
});

test("default running updates survive an RPC-like host ignoring component factories", () => {
  const calls: UiCall[] = [];
  let retainedLines: string[] | undefined;
  const ui = {
    setWidget(key: string, content: unknown, options?: { readonly placement?: string }) {
      calls.push({ kind: "setWidget", key, value: content, options });
      if (Array.isArray(content)) retainedLines = content;
    },
    setStatus(key: string, text: string | undefined) {
      calls.push({ kind: "setStatus", key, value: text });
    },
    notify(message: string, type: "info" | "warning" | "error") {
      calls.push({ kind: "notify", key: message, type });
    },
  };
  const ctx = { ui, hasUI: true } as unknown as Pick<ExtensionContext, "ui" | "hasUI">;
  const display = createWidgetGraphDisplay(ctx, { monotonicNow: () => 1_000 });

  display.update(runningSnapshot());
  const widgetCalls = calls.filter((call) => call.kind === "setWidget");
  assert.ok(Array.isArray(widgetCalls[0]?.value), "static lines are published first");
  assert.equal(typeof widgetCalls[1]?.value, "function", "interactive component is attempted second");
  assert.match(retainedLines?.[0] ?? "", /elapsed 1m 5s/);

  display.complete({ ...snapshotBase(), state: "succeeded", finalAnswer: "done" });
  assert.match(retainedLines?.[0] ?? "", /elapsed 1m 5s/);
});

test("widget live peak remains below later terminal duration after epoch rollback", () => {
  let monotonicNow = 1_000;
  const { ui, calls } = recordingUi();
  const ctx = { ui, hasUI: true } as unknown as Pick<ExtensionContext, "ui" | "hasUI">;
  const display = createWidgetGraphDisplay(ctx, { monotonicNow: () => monotonicNow });
  const running: GraphRunSnapshot = {
    ...snapshotBase(),
    startedAtEpochMs: 1_000,
    elapsedMs: 1_000,
    state: "running",
  };

  display.update(running);
  const factoryCall = calls.filter((call) => call.kind === "setWidget")[1];
  assert.ok(factoryCall && typeof factoryCall.value === "function");
  const widget = (
    factoryCall.value as (tui: unknown, theme: unknown) => { render(width: number): string[]; dispose(): void }
  )({ requestRender() {} }, {});
  monotonicNow = 4_000;
  assert.match(widget.render(120)[0] ?? "", /elapsed 4s/);
  monotonicNow = 2_000;
  assert.match(widget.render(120)[0] ?? "", /elapsed 4s/);
  widget.dispose();

  calls.length = 0;
  const terminalSnapshot: GraphRunSnapshot = {
    ...snapshotBase(),
    startedAtEpochMs: 500,
    elapsedMs: 4_500,
    state: "succeeded",
    finalAnswer: "done",
  };
  assert.equal(terminalSnapshot.elapsedMs, 4_500);
  display.complete(terminalSnapshot);
  const terminal = calls.find((call) => call.kind === "setWidget");
  assert.match((terminal?.value as string[])[0] ?? "", /elapsed 4s/);
});

test("sequential completions retain only the latest terminal graph", () => {
  const { ui, calls } = recordingUi();
  const ctx = { ui, hasUI: true } as unknown as Pick<ExtensionContext, "ui" | "hasUI">;
  const first = createWidgetGraphDisplay(ctx);
  first.complete({ ...snapshotBase(), runId: "run-a", state: "succeeded", finalAnswer: "a" });

  calls.length = 0;
  const second = createWidgetGraphDisplay(ctx);
  second.complete({ ...snapshotBase(), runId: "run-b", state: "succeeded", finalAnswer: "b" });
  assert.ok(
    calls.some((call) => call.kind === "setWidget" && call.key === "workflow_graph:run-a" && call.value === undefined),
  );
  assert.ok(
    calls.some((call) => call.kind === "setStatus" && call.key === "workflow_graph:run-a" && call.value === undefined),
  );
  assert.ok(calls.some((call) => call.kind === "setWidget" && call.key === "workflow_graph:run-b"));
});

test("graph displays use run-specific keys and isolate completion cleanup", () => {
  const { ui, calls, disposedWidgetKeys } = recordingUi();
  const ctx = { ui, hasUI: true } as unknown as Pick<ExtensionContext, "ui" | "hasUI">;
  const first = createWidgetGraphDisplay(ctx);
  const second = createWidgetGraphDisplay(ctx);
  first.update({ ...runningSnapshot(), runId: "run-a" });
  second.update({ ...runningSnapshot(), runId: "run-b" });

  calls.length = 0;
  first.complete({ ...snapshotBase(), runId: "run-a", state: "succeeded", finalAnswer: "done" });
  assert.ok(calls.every((call) => call.key !== "workflow_graph:run-b"));

  calls.length = 0;
  second.clear();
  assert.ok(
    calls.some((call) => call.kind === "setWidget" && call.key === "workflow_graph:run-b" && call.value === undefined),
  );
  assert.ok(disposedWidgetKeys.includes("workflow_graph:run-b"));
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
