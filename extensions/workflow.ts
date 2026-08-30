import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatGraphFinalAnswer, formatGraphTerminalDetails } from "../src/graph.js";
import { GraphRunRegistry } from "../src/graph-registry.js";
import type { NodeExecutor } from "../src/graph-runtime.js";
import { createWaitForWorkflowTool, createWorkflowGraphTool } from "../src/index.js";

export default function extension(pi: ExtensionAPI, options: { readonly executor?: NodeExecutor } = {}) {
  const registry = new GraphRunRegistry();
  const workflowGraphTool = createWorkflowGraphTool({
    executor: options.executor,
    getThinkingLevel: () => pi.getThinkingLevel(),
    registry,
    onTerminalCompletion: (snapshot) => {
      const finalAnswer =
        snapshot.state === "succeeded" ? `\nFinal answer:\n${formatGraphFinalAnswer(snapshot.finalAnswer)}` : "";
      const terminalDetails = formatGraphTerminalDetails(snapshot);
      pi.sendUserMessage(
        `workflow_graph run ${snapshot.runId} reached terminal state ${snapshot.state}.${terminalDetails}${finalAnswer}`,
        { deliverAs: "followUp" },
      );
    },
  });
  const waitForWorkflowTool = createWaitForWorkflowTool({ registry });
  pi.registerTool(workflowGraphTool);
  pi.registerTool(waitForWorkflowTool);

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    const next = [workflowGraphTool.name, waitForWorkflowTool.name].filter((name) => !active.includes(name));
    if (next.length > 0) pi.setActiveTools([...active, ...next]);
  });
}
