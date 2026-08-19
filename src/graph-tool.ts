import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  type CancellationReason,
  type GraphContractError,
  type GraphError,
  type GraphLifecycleEvent,
  type GraphRunSnapshot,
  type GraphThinkingLevel,
  getInvokingParentContext,
  type InvokingParentExecutionContext,
  type ModelSelector,
} from "./graph.js";
import { GraphAgentRunner, type GraphSessionFactory } from "./graph-agent.js";
import { compileGraphDefinition, type GraphDefinition } from "./graph-definition.js";
import { createWidgetGraphDisplay, renderGraphSnapshotText } from "./graph-display.js";
import { GraphRunRegistry } from "./graph-registry.js";
import type { NodeExecutor } from "./graph-runtime.js";

export interface WorkflowGraphToolOptions {
  readonly cwd?: string;
  /** Invoking session thinking level. Injected from the extension's pi.getThinkingLevel(). */
  readonly getThinkingLevel?: () => GraphThinkingLevel | undefined;
  readonly timeoutMs?: number;
  /** Injectable NodeExecutor for hermetic tests; when set, GraphAgentRunner is not built. */
  readonly executor?: NodeExecutor;
  /** Injectable session factory forwarded to GraphAgentRunner for hermetic tool tests. */
  readonly sessionFactory?: GraphSessionFactory;
  /** Injectable run registry; defaults to a per-tool-instance GraphRunRegistry. */
  readonly registry?: GraphRunRegistry;
}

export type WorkflowGraphToolInput = {
  readonly operation: "start" | "status" | "wait" | "cancel";
  readonly graph?: unknown;
  readonly definition?: unknown;
  readonly runId?: string;
  readonly timeoutMs?: number;
  readonly reason?: string;
};

const workflowGraphToolSchema = Type.Object({
  operation: Type.String({ description: '"start" | "status" | "wait" | "cancel"' }),
  graph: Type.Optional(Type.Any({ description: "GraphSpec v1 JSON object (for start). Never a JavaScript string." })),
  definition: Type.Optional(
    Type.Any({
      description:
        "Generic graph definition ({ name?, nodes: [{id, prompt, role?, model?, thinking?}], routes: [{from,to,when?,flags?} | {from,to,otherwise:true}], budgets? }) for start. Compiled to a GraphSpec.",
    }),
  ),
  runId: Type.Optional(Type.String({ description: "runId for status/wait/cancel." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Optional wait timeout in ms." })),
  reason: Type.Optional(
    Type.String({
      description: 'Optional cancel reason: "requested" | "parent_aborted" | "timeout" | "budget_exhausted".',
    }),
  ),
});

const CANCEL_REASONS: ReadonlySet<string> = new Set(["requested", "parent_aborted", "timeout", "budget_exhausted"]);

export function createWorkflowGraphTool(
  options: WorkflowGraphToolOptions = {},
): ToolDefinition<typeof workflowGraphToolSchema, any> {
  // The run registry is per TOOL INSTANCE (this closure), not per execute()
  // call: start/status/wait/cancel across separate tool calls must operate on
  // the SAME registry, otherwise later calls report run_not_found.
  const registry = options?.registry ?? new GraphRunRegistry();

  return defineTool({
    name: "workflow_graph",
    label: "Workflow Graph",
    description:
      "Run a declarative graph workflow in the background: pass a concise generic graph definition (nodes + routes with regex `when`/`otherwise` branches) or a raw GraphSpec; start returns a runId immediately; status/wait/cancel manage that process-local run. Distinct from the legacy JavaScript `workflow` tool.",
    promptSnippet:
      'Run a declarative graph workflow. Pass operation "start" with a graph definition (nodes + routes with `when`/`otherwise` regex branches) or a raw GraphSpec v1 JSON object (graph); start returns a runId immediately — poll with "status"/"wait", stop with "cancel".',
    promptGuidelines: [
      "Use workflow_graph for declarative graph work; do NOT use it for imperative JavaScript scripts — that is the legacy `workflow` tool.",
      "For start, pass a `definition` ({name?, nodes: [{id, prompt, role?, model?, thinking?}], routes: [{from, to, when?, flags?} | {from, to, otherwise: true}], budgets?}) or a raw `graph` GraphSpec v1 JSON object ({version:1,id,name,nodes,edges}).",
      "A route is bare (always), `when` (regex over the source node's finalText, with optional `flags`), or `otherwise` (fallback when no `when` edge matches). Never pass a raw JavaScript string.",
      "start returns a runId immediately and the graph runs in the background; the main agent stays available for other work.",
      'Use operation "status" or "wait" with the runId to observe a run; use operation "cancel" to stop it.',
      "Progress and completion are surfaced through the workflow_graph UI widget, not through a follow-up agent turn.",
    ],
    parameters: workflowGraphToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowGraphToolArgs(args);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.operation) {
        case "start": {
          const getModel = (): ModelSelector | undefined =>
            ctx.model === undefined ? undefined : { provider: ctx.model.provider, modelId: ctx.model.id };
          let parentContext: InvokingParentExecutionContext;
          try {
            parentContext = getInvokingParentContext({
              getModel,
              getThinkingLevel: () => options?.getThinkingLevel?.(),
            });
          } catch (error) {
            throw toolFailure("start", error);
          }

          let graphSpec: unknown;
          if (params.definition !== undefined) {
            try {
              graphSpec = compileGraphDefinition(params.definition as GraphDefinition);
            } catch (error) {
              throw toolFailure("start", error);
            }
          } else {
            graphSpec = params.graph;
          }
          const executor: NodeExecutor =
            options?.executor ??
            new GraphAgentRunner({
              cwd: options?.cwd ?? ctx.cwd,
              modelRegistry: ctx.modelRegistry,
              structuredOutputSchemas: {},
              timeoutMs: options?.timeoutMs,
              sessionFactory: options?.sessionFactory,
            });
          const display = createWidgetGraphDisplay({ ui: ctx.ui, hasUI: ctx.hasUI });
          const startResult = registry.start(graphSpec, parentContext, {
            executor,
            modelRegistry: ctx.modelRegistry,
            onEvent: (event: GraphLifecycleEvent) => {
              if (event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled") {
                display.complete(event.snapshot);
              } else {
                const snap = registry.snapshot(event.runId);
                if (snap !== undefined) display.update(snap);
              }
            },
          });
          if (!startResult.ok) throw toolFailure("start", startResult.error);
          const initialSnapshot = registry.snapshot(startResult.result.runId);
          if (initialSnapshot !== undefined) display.update(initialSnapshot);
          return {
            content: [
              {
                type: "text",
                text: `Started workflow_graph run ${startResult.result.runId} (state ${startResult.result.state}). Use operation "status" or "wait" with the runId to observe, and operation "cancel" to stop.`,
              },
            ],
            details: { ok: true, result: startResult.result },
          };
        }
        case "status": {
          const runId = requireRunId(params.runId, "status");
          const result = registry.status(runId);
          if (!result.ok) throw toolFailure("status", result.error);
          const run = result.result.run;
          const skipped = run.nodes.filter((node) => node.state === "skipped").length;
          const failed = run.nodes.filter((node) => node.state === "failed").length;
          return {
            content: [
              {
                type: "text",
                text: `workflow_graph run ${run.runId}: ${run.state} (${skipped} skipped, ${failed} failed)`,
              },
            ],
            details: { ok: true, result: result.result },
          };
        }
        case "wait": {
          const runId = requireRunId(params.runId, "wait");
          const result = await registry.wait(runId, params.timeoutMs);
          if (!result.ok) throw toolFailure("wait", result.error);
          const run = result.result.run;
          const state = result.result.completed ? run.state : "still running";
          return {
            content: [{ type: "text", text: `workflow_graph run ${run.runId}: ${state}` }],
            details: { ok: true, result: result.result },
          };
        }
        case "cancel": {
          const runId = requireRunId(params.runId, "cancel");
          const result = registry.cancel(runId, normalizeReason(params.reason));
          if (!result.ok) throw toolFailure("cancel", result.error);
          return {
            content: [
              {
                type: "text",
                text: `workflow_graph run ${runId}: ${result.result.accepted ? "cancel accepted" : "cancel not accepted"}`,
              },
            ],
            details: { ok: true, result: result.result },
          };
        }
        default: {
          throw toolFailure(String(params.operation), { code: "invalid_state", message: "unknown operation" });
        }
      }
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow_graph")), 0, 0);
    },
    renderResult(result, { isPartial: _isPartial }, theme) {
      const run = (result.details as { result?: { run?: GraphRunSnapshot } } | undefined)?.result?.run;
      if (run !== undefined) {
        return new Text(renderGraphSnapshotText(run, run.state !== "running"), 0, 0);
      }
      const first = result.content?.[0];
      if (first?.type === "text") return new Text(first.text, 0, 0);
      return new Text(theme.fg("muted", "workflow_graph"), 0, 0);
    },
  });
}

function normalizeWorkflowGraphToolArgs(args: unknown): WorkflowGraphToolInput {
  if (typeof args !== "object" || args === null) {
    throw new Error("workflow_graph requires an object argument");
  }
  const value = args as Record<string, unknown>;
  const operation = value.operation;
  if (operation !== "start" && operation !== "status" && operation !== "wait" && operation !== "cancel") {
    throw new Error('workflow_graph operation must be one of "start", "status", "wait", "cancel"');
  }
  if ("script" in value) {
    throw new Error(
      "workflow_graph does not accept a `script`; pass `graph` or `definition`. Use the legacy `workflow` tool for JavaScript scripts.",
    );
  }
  const timeoutMs = value.timeoutMs === undefined ? undefined : requireTimeoutMs(value.timeoutMs);
  const reason = value.reason === undefined ? undefined : requireReasonString(value.reason);
  if (operation === "start") {
    const hasGraph = value.graph !== undefined;
    const hasDefinition = value.definition !== undefined;
    if (hasGraph === hasDefinition) {
      throw new Error('workflow_graph "start" requires exactly one of `graph` or `definition`');
    }
    return { operation, graph: value.graph, definition: value.definition, timeoutMs, reason };
  }
  const runId = value.runId;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error(`workflow_graph "${operation}" requires a non-empty string runId`);
  }
  return { operation, runId, timeoutMs, reason };
}

function requireTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("workflow_graph timeoutMs must be a finite number");
  }
  return value;
}

function requireReasonString(value: unknown): string {
  if (typeof value !== "string") throw new Error("workflow_graph reason must be a string");
  return value;
}

function requireRunId(runId: string | undefined, op: string): string {
  if (typeof runId !== "string" || runId.length === 0) {
    throw toolFailure(op, { code: "invalid_state", message: "a non-empty runId is required" });
  }
  return runId;
}

function normalizeReason(reason: string | undefined): CancellationReason {
  if (reason === undefined) return "requested";
  if (CANCEL_REASONS.has(reason)) return reason as CancellationReason;
  throw toolFailure("cancel", { code: "invalid_state", message: "invalid cancel reason" });
}

function toolFailure(op: string, error: GraphError | GraphContractError | unknown): Error {
  const candidate = error as Partial<GraphError> | null | undefined;
  if (candidate !== null && typeof candidate === "object" && typeof candidate.code === "string") {
    const message = typeof candidate.message === "string" ? candidate.message : "";
    return new Error(`workflow_graph ${op} failed: ${candidate.code} ${message}`);
  }
  return new Error(`workflow_graph ${op} failed: ${String(error)}`);
}
