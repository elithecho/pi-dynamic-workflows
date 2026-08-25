import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  type CancellationReason,
  formatGraphFinalAnswer,
  formatGraphTerminalDetails,
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
import {
  createLiveGraphResultComponent,
  createWidgetGraphDisplay,
  type LiveGraphResultComponent,
  renderGraphSnapshotText,
} from "./graph-display.js";
import { GraphRunRegistry } from "./graph-registry.js";
import type { NodeExecutor } from "./graph-runtime.js";
import { compileGraphScript } from "./graph-script.js";

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
  /** Called once when a run reaches any terminal state. */
  readonly onTerminalCompletion?: (snapshot: GraphRunSnapshot) => void | Promise<void>;
}

export type WorkflowGraphToolInput = {
  readonly operation: "start" | "status" | "wait" | "cancel";
  readonly graph?: unknown;
  readonly definition?: unknown;
  readonly script?: string;
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
  script: Type.Optional(
    Type.String({
      description:
        "v1 Graph JS DSL source. Mutually exclusive with `graph` and `definition`. See docs/adr/0002-graph-script-dsl.md.",
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
  const liveResultComponents = new Map<string, Set<LiveGraphResultComponent>>();

  const notifyLiveResultComponents = (snapshot: GraphRunSnapshot): void => {
    const components = liveResultComponents.get(snapshot.runId);
    if (components === undefined) return;
    try {
      for (const component of components) {
        try {
          component.update(snapshot);
        } catch {
          // A result-row observer must not affect terminal handling.
        }
      }
    } finally {
      if (snapshot.state !== "running") liveResultComponents.delete(snapshot.runId);
    }
  };

  return defineTool({
    name: "workflow_graph",
    label: "Workflow Graph",
    description:
      "Run a declarative graph workflow in the background. The recommended authoring surface is a `script` — a small declarative JS DSL (`export const meta = { name, description }` first, `const <id> = agent(prompt, opts?)` declarations, edges with `to` / `when(...).otherwise(...)`, at most one `budget({...})`) compiled into a GraphSpec; `definition` (JSON nodes/routes) and `graph` (raw GraphSpec) remain as escape hatches. start returns a runId immediately; terminal completion wakes the parent with the final answer while intermediate artifacts remain internal. status/wait/cancel manage that process-local run.",
    promptSnippet:
      "Run a declarative graph workflow. For operation \"start\", pass exactly one of: `script` (a v1 Graph JS DSL source, e.g. `export const meta = { name: 'demo', description: 'Demo graph.' }\nconst a = agent('Do A.')\nconst b = agent('Do B.')\na.to(b)`), `definition` (JSON nodes/routes), or `graph` (raw GraphSpec v1 JSON). start returns a runId immediately — poll with \"status\"/\"wait\", stop with \"cancel\".",
    promptGuidelines: [
      "Author graph workflows as a declarative `script` (v1 Graph JS DSL): `export const meta = { name, description }` is the mandatory first statement; then `const <id> = agent(prompt, { role?, model?, thinking? })` declares an agent node (the node id is the constant's binding name); edges via `<source>.to(<target>)` (always) or `<source>.when('<regex>', <target>).otherwise(<fallback>)` (regex-routed with a fallback); at most one `budget({ maxConcurrency?, ... })`.",
      "Canonical example (docs/adr/0002-graph-script-dsl.md §6): `export const meta = { name: 'fix_or_ship', description: 'Coder to review to fix then ship, or ship directly.' }\nconst coder = agent('Implement the change.', { role: 'implementation' })\nconst review = agent('Review the change.', { role: 'reviewer' })\nconst fixer = agent('Apply requested changes.', { role: 'implementation' })\nconst done = agent('Finalize and report.', { role: 'verifier' })\ncoder.to(review)\nreview.when('<verdict>change</verdict>', fixer).otherwise(done)\nfixer.to(done)`.",
      "`definition` (JSON `{name?, nodes: [{id, prompt, role?, model?, thinking?}], routes: [{from, to, when?, flags?} | {from, to, otherwise: true}], budgets?}`) and `graph` (raw GraphSpec v1 JSON `{version:1,id,name,nodes,edges}`) are data-oriented escape hatches for programmatic builders; `script` is the recommended authoring surface.",
      "For start, pass exactly one of `script`, `definition`, or `graph` — never more than one, and never combine them.",
      "workflow_graph scripts are declarative: declare agent nodes and edges; do not use await, return, loops, or other imperative control flow.",
      "start returns a runId immediately and the graph runs in the background; the main agent stays available for other work.",
      'Use operation "status" or "wait" with the runId to observe a run; use operation "cancel" to stop it.',
      "The start tool-result row refreshes with current progress; no bottom widget is used. Terminal completion may wake the parent with only the canonical final answer from every successful topology sink (agent finalText or deterministic value, labelled for multiple sinks; never intermediate artifacts).",
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
              sessionModelRegistry: ctx.modelRegistry,
              structuredOutputSchemas: {},
              timeoutMs: options?.timeoutMs,
              sessionFactory: options?.sessionFactory,
            });
          const display = createWidgetGraphDisplay({ ui: ctx.ui, hasUI: ctx.hasUI }, { showWidget: false });
          const startResult = registry.start(graphSpec, parentContext, {
            executor,
            modelRegistry: ctx.modelRegistry,
            onEvent: (event: GraphLifecycleEvent) => {
              const snapshot =
                event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled"
                  ? event.snapshot
                  : registry.snapshot(event.runId);
              if (event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled") {
                // Reserve terminal ownership before invoking UI hooks, which may synchronously
                // trigger an abort. This makes terminal-vs-abort ordering deterministic.
                const suppressRelay = registry.consumeTerminalRelaySuppression(event.runId);
                notifyLiveResultComponents(event.snapshot);
                try {
                  display.complete(event.snapshot);
                } catch {
                  // Display failures must not affect graph execution or completion relay.
                }
                if (suppressRelay) return;
                try {
                  void Promise.resolve(options.onTerminalCompletion?.(event.snapshot)).catch(() => {
                    // Completion relay failures must not affect graph execution.
                  });
                } catch {
                  // Completion relay failures must not affect graph execution.
                }
              } else if (snapshot !== undefined) {
                notifyLiveResultComponents(snapshot);
                display.update(snapshot);
              }
            },
          });
          if (!startResult.ok) throw toolFailure("start", startResult.error);
          const initialSnapshot = startResult.result.run;
          display.update(initialSnapshot);
          return {
            content: [
              { type: "text", text: renderGraphSnapshotText(initialSnapshot, initialSnapshot.state !== "running") },
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
          const finalAnswer =
            run.state === "succeeded" ? `\nFinal answer:\n${formatGraphFinalAnswer(run.finalAnswer)}` : "";
          return {
            content: [
              {
                type: "text",
                text: `workflow_graph run ${run.runId}: ${run.state} (${skipped} skipped, ${failed} failed)${finalAnswer}${formatGraphTerminalDetails(run)}`,
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
          const finalAnswer =
            run.state === "succeeded" ? `\nFinal answer:\n${formatGraphFinalAnswer(run.finalAnswer)}` : "";
          const terminalDetails = result.result.completed ? formatGraphTerminalDetails(run) : "";
          return {
            content: [
              { type: "text", text: `workflow_graph run ${run.runId}: ${state}${finalAnswer}${terminalDetails}` },
            ],
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
    renderResult(result, { isPartial: _isPartial }, theme, context) {
      const run = (result.details as { result?: { run?: GraphRunSnapshot } } | undefined)?.result?.run;
      if (run !== undefined) {
        if (
          (context.args as { operation?: string } | undefined)?.operation === "start" &&
          context.state !== undefined
        ) {
          const state = context.state as { runId?: string; component?: LiveGraphResultComponent };
          const previous = context.lastComponent as LiveGraphResultComponent | undefined;
          const liveSnapshot = registry.snapshot(run.runId);
          const canRegister = run.state === "running" && liveSnapshot?.state === "running";
          if (!canRegister) {
            if (state.component !== undefined) state.component.dispose();
            else if (state.runId === run.runId && previous !== undefined) previous.dispose();
            state.runId = run.runId;
            state.component = undefined;
            const snapshot = liveSnapshot ?? run;
            return new Text(renderGraphSnapshotText(snapshot, snapshot.state !== "running"), 0, 0);
          }
          if (
            state.runId === run.runId &&
            state.component === undefined &&
            previous !== undefined &&
            typeof previous.update === "function"
          ) {
            state.component = previous;
            const components = liveResultComponents.get(run.runId) ?? new Set<LiveGraphResultComponent>();
            components.add(previous);
            liveResultComponents.set(run.runId, components);
          }
          if (state.runId !== run.runId || state.component === undefined) {
            state.component?.dispose();
            state.runId = run.runId;
            let component!: LiveGraphResultComponent;
            component = createLiveGraphResultComponent(
              run,
              () => registry.snapshot(run.runId),
              context.invalidate,
              undefined,
              () => {
                const components = liveResultComponents.get(run.runId);
                if (components === undefined) return;
                components.delete(component);
                if (components.size === 0) liveResultComponents.delete(run.runId);
              },
            );
            state.component = component;
            const components = liveResultComponents.get(run.runId) ?? new Set<LiveGraphResultComponent>();
            components.add(component);
            liveResultComponents.set(run.runId, components);
          }
          return state.component;
        }
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
  const timeoutMs = value.timeoutMs === undefined ? undefined : requireTimeoutMs(value.timeoutMs);
  const reason = value.reason === undefined ? undefined : requireReasonString(value.reason);
  if (operation === "start") {
    const hasGraph = value.graph !== undefined;
    const hasDefinition = value.definition !== undefined;
    const hasScript = value.script !== undefined;
    const providedCount = (hasGraph ? 1 : 0) + (hasDefinition ? 1 : 0) + (hasScript ? 1 : 0);
    if (providedCount > 1) {
      const provided = [hasScript && "`script`", hasDefinition && "`definition`", hasGraph && "`graph`"]
        .filter((entry): entry is string => typeof entry === "string")
        .join(" and ");
      throw new Error(
        `workflow_graph "start" inputs are mutually exclusive — received ${provided}; pass exactly one of \`script\`, \`definition\`, or \`graph\``,
      );
    }
    if (providedCount === 0) {
      throw new Error('workflow_graph "start" requires exactly one of `script`, `definition`, or `graph`');
    }
    if (hasScript) {
      try {
        return { operation, graph: compileGraphScript(value.script as string), timeoutMs, reason };
      } catch (error) {
        throw toolFailure("start", error);
      }
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
