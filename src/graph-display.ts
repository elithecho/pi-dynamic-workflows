import { performance } from "node:perf_hooks";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatGraphFinalAnswer, type GraphRunSnapshot, type NodeSnapshot } from "./graph.js";

export interface GraphDisplayOptions {
  readonly key?: string; // default "workflow_graph"; run id is appended once known
  readonly placement?: "aboveEditor" | "belowEditor"; // default "belowEditor"
  /** Injectable monotonic clock for deterministic display tests. */
  readonly monotonicNow?: () => number;
}
export interface GraphDisplay {
  update(snapshot: GraphRunSnapshot): void;
  complete(snapshot: GraphRunSnapshot): void;
  clear(): void;
}

const NODE_ICONS: Readonly<Record<NodeSnapshot["state"], string>> = {
  pending: "○",
  ready: "◌",
  running: "●",
  succeeded: "✓",
  failed: "✗",
  cancelled: "⊘",
  waiting_retry: "↻",
  skipped: "-",
};

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface GraphDisplayCoordinator {
  readonly activeKeys: Set<string>;
  retainedKey?: string;
}

const coordinators = new WeakMap<object, GraphDisplayCoordinator>();

function getCoordinator(ui: object): GraphDisplayCoordinator {
  const existing = coordinators.get(ui);
  if (existing !== undefined) return existing;
  const created: GraphDisplayCoordinator = { activeKeys: new Set() };
  coordinators.set(ui, created);
  return created;
}

function removeDisplay(ui: Pick<ExtensionContext, "ui">["ui"], key: string): void {
  ui.setWidget(key, undefined);
  ui.setStatus(key, undefined);
}

function createRunningGraphWidget(
  snapshot: GraphRunSnapshot,
  monotonicNow: () => number,
): (tui: TUI, _theme: Theme) => Component & { dispose(): void } {
  return (tui) => {
    let frameIndex = 0;
    const snapshotElapsedMs = Number.isFinite(snapshot.elapsedMs) ? Math.max(0, snapshot.elapsedMs) : 0;
    let elapsedMs = snapshotElapsedMs;
    const mountedAtMonotonicMs = monotonicNow();
    const timer = setInterval(() => {
      frameIndex = (frameIndex + 1) % RUNNING_FRAMES.length;
      tui.requestRender();
    }, 100);
    return {
      render(width) {
        const mountedDeltaMs = monotonicNow() - mountedAtMonotonicMs;
        if (Number.isFinite(mountedDeltaMs))
          elapsedMs = Math.max(elapsedMs, snapshotElapsedMs + Math.max(0, mountedDeltaMs));
        return renderGraphSnapshotLines(snapshot, RUNNING_FRAMES[frameIndex] ?? RUNNING_FRAMES[0], elapsedMs).map(
          (line) => truncateToWidth(line, width),
        );
      },
      invalidate() {},
      dispose() {
        clearInterval(timer);
      },
    };
  };
}

export function formatGraphElapsed(elapsedMs: number): string {
  const totalSeconds = Number.isFinite(elapsedMs) ? Math.floor(Math.max(0, elapsedMs) / 1_000) : 0;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds}s`;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${minutes}m ${seconds}s`;
}

export function renderGraphSnapshotLines(
  snapshot: GraphRunSnapshot,
  runningFrame = "⟳",
  elapsedMs = snapshot.elapsedMs,
): string[] {
  const runningIndicator = snapshot.state === "running" ? ` ${runningFrame}` : "";
  const lines: string[] = [
    `◆ workflow_graph: ${snapshot.graphId} (${snapshot.runId}) — ${snapshot.state}${runningIndicator} — turns ${snapshot.turnCount} — elapsed ${formatGraphElapsed(elapsedMs)}`,
  ];
  for (const node of snapshot.nodes) {
    let line = `  ${NODE_ICONS[node.state]} ${node.id} [${node.state}] attempt ${node.attempt}`;
    if (node.state === "skipped") line += ` (reason: ${node.skipReason})`;
    else if (node.state === "failed") line += ` (error: ${node.error.code})`;
    lines.push(line);
  }
  const { cost } = snapshot.usage;
  lines.push(
    cost === undefined
      ? `  usage: ${snapshot.usage.inputTokens} in / ${snapshot.usage.outputTokens} out`
      : `  usage: ${snapshot.usage.inputTokens} in / ${snapshot.usage.outputTokens} out, $${cost}`,
  );
  if (snapshot.state === "succeeded") {
    lines.push("", "Final answer:", formatGraphFinalAnswer(snapshot.finalAnswer));
  }
  return lines;
}

export function renderGraphSnapshotText(snapshot: GraphRunSnapshot, completed: boolean): string {
  const stateWord = completed
    ? snapshot.state === "failed"
      ? "failed"
      : snapshot.state === "cancelled"
        ? "cancelled"
        : "completed"
    : "running";
  return [`workflow_graph run ${snapshot.runId} ${stateWord}`, ...renderGraphSnapshotLines(snapshot)].join("\n");
}

export function createWidgetGraphDisplay(
  ctx: Pick<ExtensionContext, "ui" | "hasUI">,
  options: GraphDisplayOptions = {},
): GraphDisplay {
  const keyPrefix = options.key ?? "workflow_graph";
  const placement = options.placement ?? "belowEditor";
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const coordinator = getCoordinator(ctx.ui);
  let activeKey: string | undefined;

  const releaseKey = (key: string): void => {
    coordinator.activeKeys.delete(key);
    if (coordinator.retainedKey === key) coordinator.retainedKey = undefined;
    removeDisplay(ctx.ui, key);
  };

  const retainTerminal = (key: string): void => {
    const previous = coordinator.retainedKey;
    if (previous !== undefined && previous !== key && !coordinator.activeKeys.has(previous)) {
      removeDisplay(ctx.ui, previous);
    }
    coordinator.retainedKey = key;
  };

  const render = (snapshot: GraphRunSnapshot): void => {
    if (!ctx.hasUI) return;
    const nextKey = `${keyPrefix}:${snapshot.runId}`;
    if (activeKey !== undefined && activeKey !== nextKey) releaseKey(activeKey);
    activeKey = nextKey;
    if (snapshot.state === "running") {
      coordinator.activeKeys.add(activeKey);
      // RPC hosts retain this array and ignore the following component factory;
      // interactive TUI hosts replace it with the animated component.
      ctx.ui.setWidget(activeKey, renderGraphSnapshotLines(snapshot), { placement });
      ctx.ui.setWidget(activeKey, createRunningGraphWidget(snapshot, monotonicNow), { placement });
    } else {
      coordinator.activeKeys.delete(activeKey);
      ctx.ui.setWidget(activeKey, renderGraphSnapshotLines(snapshot), { placement });
      retainTerminal(activeKey);
    }
    ctx.ui.setStatus(activeKey, `workflow_graph ${snapshot.runId}: ${snapshot.state} • turns ${snapshot.turnCount}`);
  };

  return {
    update(snapshot) {
      render(snapshot);
    },
    complete(snapshot) {
      render(snapshot);
      if (!ctx.hasUI) return;
      const type = snapshot.state === "failed" ? "error" : snapshot.state === "cancelled" ? "warning" : "info";
      ctx.ui.notify(`workflow_graph ${snapshot.runId} ${snapshot.state}`, type);
    },
    clear() {
      if (!ctx.hasUI || activeKey === undefined) return;
      releaseKey(activeKey);
      activeKey = undefined;
    },
  };
}
