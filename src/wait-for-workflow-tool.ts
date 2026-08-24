import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatGraphFinalAnswer, formatGraphTerminalDetails, type GraphRunSnapshot } from "./graph.js";
import { renderGraphSnapshotText } from "./graph-display.js";
import type { GraphRunRegistry } from "./graph-registry.js";

export interface WaitForWorkflowToolInput {
  readonly runId: string;
}

export interface WaitForWorkflowToolOptions {
  /** Registry shared with the workflow_graph tool for this extension runtime. */
  readonly registry: GraphRunRegistry;
}

const waitForWorkflowSchema = Type.Object({
  runId: Type.String({ description: "Process-local workflow_graph run id." }),
});

/**
 * Create the dedicated indefinite workflow waiter. A waiter claims a running
 * run before awaiting it so the extension does not also wake the parent when
 * that same run reaches a terminal state.
 */
export function createWaitForWorkflowTool(
  options: WaitForWorkflowToolOptions,
): ToolDefinition<typeof waitForWorkflowSchema, any> {
  return defineTool({
    name: "wait_for_workflow",
    label: "Wait For Workflow",
    description:
      "Wait indefinitely for a process-local workflow_graph run to reach a terminal state. Pass only runId. Returns the bounded terminal result and canonical final answer, then ends this parent turn without another model response.",
    promptSnippet: "Wait for a workflow_graph run to finish",
    promptGuidelines: [
      "Use wait_for_workflow with only the runId when the parent should block until a background workflow_graph run finishes.",
      "wait_for_workflow does not cancel the graph if the caller is aborted; retry with the same runId if needed.",
    ],
    parameters: waitForWorkflowSchema,
    prepareArguments(args) {
      return normalizeWaitForWorkflowArgs(args);
    },
    async execute(_toolCallId, params, signal) {
      const claim = options.registry.claimWait(params.runId, signal);
      if (!claim.ok) throw toolFailure(claim.error);

      const result = await options.registry.wait(
        params.runId,
        undefined,
        signal,
        claim.result.claimed ? claim.result.claimId : undefined,
      );
      if (!result.ok) throw toolFailure(result.error);
      const run = result.result.run;
      const finalAnswer =
        run.state === "succeeded" ? `\nFinal answer:\n${formatGraphFinalAnswer(run.finalAnswer)}` : "";
      const terminalDetails = formatGraphTerminalDetails(run);
      return {
        content: [
          {
            type: "text",
            text: `workflow_graph run ${run.runId}: ${run.state}${finalAnswer}${terminalDetails}`,
          },
        ],
        details: { ok: true, result: result.result },
        terminate: true,
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("wait_for_workflow")), 0, 0);
    },
    renderResult(result, { isPartial: _isPartial }, theme) {
      const run = (result.details as { result?: { run?: GraphRunSnapshot } } | undefined)?.result?.run;
      if (run !== undefined) return new Text(renderGraphSnapshotText(run, true), 0, 0);
      const first = result.content?.[0];
      if (first?.type === "text") return new Text(first.text, 0, 0);
      return new Text(theme.fg("muted", "wait_for_workflow"), 0, 0);
    },
  });
}

function normalizeWaitForWorkflowArgs(args: unknown): WaitForWorkflowToolInput {
  if (typeof args !== "object" || args === null) throw new Error("wait_for_workflow requires an object argument");
  const value = args as Record<string, unknown>;
  const extraKeys = Object.keys(value).filter((key) => key !== "runId");
  if (extraKeys.length > 0) throw new Error("wait_for_workflow accepts only runId");
  const runId = value.runId;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("wait_for_workflow requires a non-empty string runId");
  }
  return { runId };
}

function toolFailure(error: { readonly code: string; readonly message: string }): Error {
  return new Error(`wait_for_workflow failed: ${error.code} ${error.message}`);
}
