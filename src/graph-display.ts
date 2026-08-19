import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GraphRunSnapshot, NodeSnapshot } from "./graph.js";

export interface GraphDisplayOptions {
  readonly key?: string; // default "workflow_graph"
  readonly placement?: "aboveEditor" | "belowEditor"; // default "belowEditor"
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

export function renderGraphSnapshotLines(snapshot: GraphRunSnapshot): string[] {
  const lines: string[] = [`◆ workflow_graph: ${snapshot.graphId} (${snapshot.runId}) — ${snapshot.state}`];
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
  const key = options.key ?? "workflow_graph";
  const placement = options.placement ?? "belowEditor";

  const render = (snapshot: GraphRunSnapshot): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(key, renderGraphSnapshotLines(snapshot), { placement });
    ctx.ui.setStatus(key, `workflow_graph ${snapshot.runId}: ${snapshot.state}`);
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
      if (!ctx.hasUI) return;
      ctx.ui.setWidget(key, undefined);
      ctx.ui.setStatus(key, undefined);
    },
  };
}
