import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowGraphTool, createWorkflowTool } from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
  const workflowTool = createWorkflowTool();
  const workflowGraphTool = createWorkflowGraphTool({ getThinkingLevel: () => pi.getThinkingLevel() });
  pi.registerTool(workflowTool);
  pi.registerTool(workflowGraphTool);

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    const merged = [...new Set([...active, workflowTool.name, workflowGraphTool.name])];
    if (merged.length !== active.length) pi.setActiveTools(merged);
  });
}
