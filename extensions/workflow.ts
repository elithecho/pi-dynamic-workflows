import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatGraphFinalAnswer, formatGraphTerminalDetails } from "../src/graph.js";
import type { NodeExecutor } from "../src/graph-runtime.js";
import { createWorkflowGraphTool } from "../src/index.js";

export default function extension(pi: ExtensionAPI, options: { readonly executor?: NodeExecutor } = {}) {
  const workflowGraphTool = createWorkflowGraphTool({
    executor: options.executor,
    getThinkingLevel: () => pi.getThinkingLevel(),
    onTerminalCompletion: (snapshot) => {
      const finalAnswer =
        snapshot.state === "succeeded" ? `\nFinal answer:\n${formatGraphFinalAnswer(snapshot.finalAnswer)}` : "";
      const terminalDetails = formatGraphTerminalDetails(snapshot);
      pi.sendMessage(
        {
          customType: "workflow_graph_completion",
          content: `workflow_graph run ${snapshot.runId} reached terminal state ${snapshot.state}.${terminalDetails}${finalAnswer}`,
          display: true,
          details: {
            runId: snapshot.runId,
            state: snapshot.state,
            ...(snapshot.state === "succeeded" ? { finalAnswer: snapshot.finalAnswer } : {}),
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
  });
  pi.registerTool(workflowGraphTool);

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowGraphTool.name)) pi.setActiveTools([...active, workflowGraphTool.name]);
  });
}
