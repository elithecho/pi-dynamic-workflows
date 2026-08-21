/**
 * Pure graph runtime: deterministic execution of a frozen GraphSpec.
 *
 * The runtime owns ready-node scheduling, graph-owned concurrency admission,
 * immutable in-memory artifact routing, route selection, joins, retries,
 * skips, cancellation, and budgets. Agent nodes run through an injectable
 * {@link NodeExecutor} (the Pi session implementation lives in a separate
 * lane); deterministic `join`/`publish` nodes are executed by the engine.
 *
 * Scheduling rules (generalizing the frozen `isJoinSatisfied` semantics):
 * - Roots (no incoming edges and no declared artifact inputs) become ready in
 *   node declaration order. Admission always admits the earliest-declared
 *   ready node, so execution order is deterministic.
 * - A non-root node becomes ready once every incoming edge and every declared
 *   artifact producer is determined: at least one incoming edge must be active
 *   (its source succeeded and the edge was selected by `selectGraphRoutes`),
 *   every active dependency must have succeeded, and no dependency may have
 *   failed, been cancelled, or been skipped for a non-routing reason.
 * - Edges from sources skipped with `route_not_selected` are inactive and do
 *   not block a join, exactly like the frozen join helper.
 * - A declared artifact producer that did not succeed is an implicit blocking
 *   dependency: the consumer cannot run without its input, so it is skipped
 *   (`route_not_selected` when the producer was skipped by routing, otherwise
 *   `dependency_failed`).
 * - Nodes that can never activate are skipped with `route_not_selected`
 *   (unselected branches) or `dependency_failed` (an active dependency failed
 *   permanently). Skipped nodes stay visible in snapshots with their reason.
 *
 * Budget rules:
 * - Concurrency: at most `budgets.maxConcurrency` agent nodes are `running` at
 *   once (default {@link DEFAULT_MAX_CONCURRENCY}). Deterministic nodes are
 *   executed synchronously inside the scheduler tick and never overlap, so
 *   they do not consume concurrency slots.
 * - Attempts: effective attempts per agent node are
 *   `min(node.retry.maxAttempts, budgets.maxAttempts)`, floored at 1.
 * - Tokens/cost: admission stops once cumulative usage has reached or exceeded
 *   any of `maxInputTokens`, `maxOutputTokens`, or `maxCost` (reaching a cap
 *   already means any further attempt could exceed it). Remaining nodes are
 *   skipped `budget_exhausted` and the run ends `cancelled` with cancellation
 *   reason `budget_exhausted` — unless a node actually failed, which fails the
 *   run. In-flight executions are never aborted by a budget stop.
 *
 * Failure handling: a permanently failed node fails the run. In-flight sibling
 * nodes are drained (not aborted); dependents are skipped `dependency_failed`.
 */

import {
  type AgentNode,
  type Artifact,
  type ArtifactOutputKind,
  type ArtifactRef,
  type Cancellation,
  type CancellationReason,
  createArtifact,
  createDeterministicArtifact,
  type DeterministicNode,
  type GraphCancelResult,
  GraphContractError,
  type GraphEdge,
  type GraphError,
  type GraphLifecycleEvent,
  type GraphNode,
  type GraphRunSnapshot,
  type GraphSpec,
  type GraphWaitResult,
  type InvokingParentExecutionContext,
  type JsonValue,
  type ModelRegistryLike,
  type NodeSnapshot,
  type NodeState,
  type ResolvedExecutionContext,
  type RunState,
  resolveExecutionContext,
  type SkipReason,
  selectGraphFinalAnswer,
  selectGraphRoutes,
  type Usage,
  validateGraphPreflight,
  validateGraphSpec,
} from "./graph.js";

/** Default concurrency admission limit when `budgets.maxConcurrency` is omitted. */
export const DEFAULT_MAX_CONCURRENCY = 4;

/** One declared input of a node, resolved by the engine to a frozen artifact. */
export interface RoutedArtifact {
  readonly ref: ArtifactRef;
  readonly artifact: Artifact;
  /** The artifact's declared output kind, resolved to a JSON value. */
  readonly value: JsonValue;
}

/** Successful agent output as reported by a NodeExecutor. */
export interface AgentNodeOutput {
  readonly finalText: string;
  readonly value?: JsonValue;
  readonly structuredOutput?: JsonValue;
}

export interface NodeExecutionRequest {
  readonly node: AgentNode;
  /** 1-based attempt number for this execution. */
  readonly attempt: number;
  /** Exactly the artifacts declared in `node.inputArtifacts`, engine-routed. */
  readonly inputArtifacts: readonly RoutedArtifact[];
  readonly resolvedContext: ResolvedExecutionContext;
  readonly parentContext: InvokingParentExecutionContext;
  /** Aborts when the run is cancelled; shared across retry attempts. */
  readonly signal: AbortSignal;
}

export type NodeExecutorResult =
  | { readonly ok: true; readonly output: AgentNodeOutput; readonly usage?: Usage }
  | { readonly ok: false; readonly error: GraphError };

/**
 * Executor boundary for agent nodes. The Pi session runner (Execution-1)
 * implements this without engine changes: receive the request, run the
 * session, and resolve with an output or a failure.
 */
export interface NodeExecutor {
  execute(request: NodeExecutionRequest): Promise<NodeExecutorResult>;
}

export interface GraphRunOptions {
  readonly executor: NodeExecutor;
  readonly parentContext: InvokingParentExecutionContext;
  /** When provided, the graph is preflighted against this registry before start. */
  readonly modelRegistry?: ModelRegistryLike;
  /** Explicit run id; generated when omitted. */
  readonly runId?: string;
  /** Lifecycle event sink invoked synchronously as transitions occur. */
  readonly onEvent?: (event: GraphLifecycleEvent) => void;
  /** Aborting this signal cancels the run with reason `parent_aborted`. */
  readonly parentSignal?: AbortSignal;
}

/** Control surface for one executing run. */
export interface GraphRunHandle {
  readonly runId: string;
  readonly graphId: string;
  /** Resolves with the terminal snapshot; the run never hangs. */
  readonly done: Promise<GraphRunSnapshot>;
  snapshot(): GraphRunSnapshot;
  events(): readonly GraphLifecycleEvent[];
  cancel(reason?: CancellationReason): GraphCancelResult;
  wait(timeoutMs?: number): Promise<GraphWaitResult>;
}

interface NodeRuntime {
  readonly node: GraphNode;
  state: NodeState;
  attempt: number;
  readonly artifactIds: string[];
  error?: GraphError;
  skipReason?: SkipReason;
  retryTimer?: ReturnType<typeof setTimeout>;
}

type GateOutcome = "undetermined" | "ready" | { readonly skip: SkipReason };

const ABORTED = "aborted" as const;
let runCounter = 0;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function withNodeId(error: GraphError, nodeId: string): GraphError {
  return error.nodeId === undefined ? { ...error, nodeId } : error;
}

function faultError(error: unknown, nodeId: string, fallback: string): GraphError {
  if (error instanceof GraphContractError) return { code: error.code, message: error.message, nodeId };
  return { code: "invalid_state", message: `${fallback}: ${String(error)}`, nodeId, retryable: false };
}

function normalizeExecutorResult(result: unknown, nodeId: string): NodeExecutorResult {
  if (
    typeof result === "object" &&
    result !== null &&
    (result as { ok?: unknown }).ok === true &&
    typeof (result as { output?: unknown }).output === "object"
  ) {
    return result as NodeExecutorResult;
  }
  if (typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false) {
    return result as NodeExecutorResult;
  }
  return { ok: false, error: { code: "invalid_state", message: "node executor returned an invalid result", nodeId } };
}

function resolveArtifactOutput(artifact: Artifact, output: ArtifactOutputKind): JsonValue {
  if (output === "value") return artifact.value;
  if (output === "finalText") {
    if (!("finalText" in artifact)) throw new GraphContractError("invalid_state", "artifact has no finalText");
    return artifact.finalText;
  }
  if (!("structuredOutput" in artifact) || artifact.structuredOutput === undefined) {
    throw new GraphContractError("invalid_state", "artifact has no structuredOutput");
  }
  return artifact.structuredOutput;
}

/** Validate (and optionally preflight) a graph, then start executing it. */
export function startGraphRun(spec: unknown, options: GraphRunOptions): GraphRunHandle {
  if (typeof options.executor?.execute !== "function") {
    throw new GraphContractError("invalid_graph", "a node executor is required");
  }
  const graph =
    options.modelRegistry === undefined
      ? validateGraphSpec(spec)
      : validateGraphPreflight(spec as GraphSpec, options.parentContext, options.modelRegistry);
  const run = new GraphRunEngine(graph, options);
  run.start();
  return run;
}

/** Convenience wrapper that starts a run and awaits its terminal snapshot. */
export async function runGraph(spec: unknown, options: GraphRunOptions): Promise<GraphRunSnapshot> {
  return startGraphRun(spec, options).done;
}

class GraphRunEngine implements GraphRunHandle {
  readonly runId: string;
  readonly graphId: string;
  private readonly graph: GraphSpec;
  private readonly options: GraphRunOptions;
  private readonly executor: NodeExecutor;
  private readonly parentContext: InvokingParentExecutionContext;
  private readonly maxConcurrency: number;
  private readonly runtimes: readonly NodeRuntime[];
  private readonly runtimeById: Map<string, NodeRuntime>;
  private readonly incoming: ReadonlyMap<string, readonly GraphEdge[]>;
  private readonly outgoing: ReadonlyMap<string, readonly GraphEdge[]>;
  private readonly resolvedContexts: ReadonlyMap<string, ResolvedExecutionContext>;
  private readonly artifacts: Artifact[] = [];
  private readonly artifactByNode = new Map<string, Artifact>();
  private readonly selectedEdges = new Map<string, ReadonlySet<string>>();
  private readonly usedArtifactIds = new Set<string>();
  private readonly eventLog: GraphLifecycleEvent[] = [];
  private readonly abortController = new AbortController();
  private readonly usageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costSum: 0,
    costDefined: false,
  };
  private runState: RunState = "created";
  private runError?: GraphError;
  private cancellation?: Cancellation;
  private cancelRequested = false;
  private budgetStopped = false;
  private pumpScheduled = false;
  private removeParentListener: (() => void) | undefined;
  private resolveDone!: (snapshot: GraphRunSnapshot) => void;
  readonly done: Promise<GraphRunSnapshot> = new Promise((resolve) => {
    this.resolveDone = resolve;
  });

  constructor(graph: GraphSpec, options: GraphRunOptions) {
    this.graph = graph;
    this.options = options;
    this.executor = options.executor;
    this.parentContext = options.parentContext;
    if (options.runId !== undefined) {
      this.runId = options.runId;
    } else {
      runCounter += 1;
      this.runId = `run-${runCounter}`;
    }
    this.graphId = graph.id;
    this.maxConcurrency = graph.budgets?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.runtimes = graph.nodes.map((node) => ({ node, state: "pending" as NodeState, attempt: 0, artifactIds: [] }));
    this.runtimeById = new Map(this.runtimes.map((runtime) => [runtime.node.id, runtime]));
    this.incoming = groupEdges(graph, (edge) => edge.to);
    this.outgoing = groupEdges(graph, (edge) => edge.from);
    const contexts = new Map<string, ResolvedExecutionContext>();
    for (const node of graph.nodes) {
      if (node.kind !== "agent") continue;
      contexts.set(
        node.id,
        resolveExecutionContext({
          node,
          role: node.role === undefined ? undefined : graph.roles?.[node.role],
          workflow: graph.defaults,
          parent: options.parentContext,
        }),
      );
    }
    // Resolving contexts here fails invalid parent/selector input before any
    // executor call, alongside graph validation.
    this.resolvedContexts = contexts;
  }

  start(): void {
    this.runState = "running";
    this.emit({ type: "run_started", runId: this.runId, graphId: this.graphId });
    if (this.options.parentSignal?.aborted) {
      this.cancel("parent_aborted");
      return;
    }
    if (this.options.parentSignal !== undefined) {
      const onAbort = () => this.cancel("parent_aborted");
      this.options.parentSignal.addEventListener("abort", onAbort, { once: true });
      this.removeParentListener = () => this.options.parentSignal?.removeEventListener("abort", onAbort);
    }
    this.schedulePump();
  }

  snapshot(): GraphRunSnapshot {
    const usage: Usage = {
      inputTokens: this.usageTotals.inputTokens,
      outputTokens: this.usageTotals.outputTokens,
      totalTokens: this.usageTotals.totalTokens,
      ...(this.usageTotals.costDefined ? { cost: this.usageTotals.costSum } : {}),
    };
    const nodes = Object.freeze(this.runtimes.map((runtime) => this.nodeSnapshot(runtime)));
    const artifacts = Object.freeze([...this.artifacts]);
    const base = { runId: this.runId, graphId: this.graphId, nodes, artifacts, usage };
    if (this.runState === "failed") {
      return deepFreeze({
        ...base,
        state: "failed" as const,
        error: this.runError ?? { code: "invalid_state", message: "run failed without an error" },
      });
    }
    if (this.runState === "cancelled") {
      return deepFreeze({
        ...base,
        state: "cancelled" as const,
        cancellation: this.cancellation ?? { requested: true, reason: "requested" },
      });
    }
    if (this.runState === "succeeded") {
      return deepFreeze({
        ...base,
        state: "succeeded" as const,
        finalAnswer: selectGraphFinalAnswer(this.graph, nodes, artifacts),
      });
    }
    return deepFreeze({ ...base, state: this.runState });
  }

  events(): readonly GraphLifecycleEvent[] {
    return Object.freeze([...this.eventLog]);
  }

  cancel(reason: CancellationReason = "requested"): GraphCancelResult {
    if (this.isTerminal()) {
      return {
        accepted: false,
        error: {
          code: "cancel_rejected",
          message: `run ${this.runId} is already ${this.runState}`,
        },
      };
    }
    this.cancelRequested = true;
    this.cancellation = { requested: true, reason };
    this.abortController.abort();
    for (const runtime of this.runtimes) {
      this.clearRetryTimer(runtime);
      if (runtime.state === "running" || runtime.state === "waiting_retry") {
        this.transition(runtime, "cancelled");
      } else if (runtime.state === "pending" || runtime.state === "ready") {
        this.transition(runtime, "skipped", "cancelled");
      }
    }
    this.finalizeRun();
    return { accepted: true, run: this.snapshot() };
  }

  async wait(timeoutMs?: number): Promise<GraphWaitResult> {
    if (timeoutMs === undefined) {
      await this.done;
      return { run: this.snapshot(), completed: true };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([this.done, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return { run: this.snapshot(), completed: this.isTerminal() };
  }

  private isTerminal(): boolean {
    return this.runState === "succeeded" || this.runState === "failed" || this.runState === "cancelled";
  }

  private emit(event: GraphLifecycleEvent): void {
    this.eventLog.push(event);
    try {
      this.options.onEvent?.(event);
    } catch {
      // Lifecycle observers must not prevent the run from reaching completion.
    }
  }

  private nodeSnapshot(runtime: NodeRuntime): NodeSnapshot {
    const base = {
      id: runtime.node.id,
      attempt: runtime.attempt,
      artifactIds: Object.freeze([...runtime.artifactIds]),
    };
    if (runtime.state === "failed") {
      return deepFreeze({
        ...base,
        state: "failed" as const,
        error: runtime.error ?? { code: "invalid_state" as const, message: "unknown failure" },
      });
    }
    if (runtime.state === "skipped") {
      return deepFreeze({
        ...base,
        state: "skipped" as const,
        skipReason: runtime.skipReason ?? "route_not_selected",
      });
    }
    return deepFreeze({ ...base, state: runtime.state });
  }

  private transition(runtime: NodeRuntime, to: NodeState, skipReason?: SkipReason): void {
    if (runtime.state === to) return;
    runtime.state = to;
    if (to === "skipped") runtime.skipReason = skipReason;
    this.emit({ type: "node_state_changed", runId: this.runId, node: this.nodeSnapshot(runtime) });
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.isTerminal()) return;
    this.pumpScheduled = true;
    void Promise.resolve().then(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private countInState(state: NodeState): number {
    let count = 0;
    for (const runtime of this.runtimes) if (runtime.state === state) count += 1;
    return count;
  }

  private hasNonTerminal(): boolean {
    return this.runtimes.some(
      (runtime) =>
        runtime.state === "pending" ||
        runtime.state === "ready" ||
        runtime.state === "running" ||
        runtime.state === "waiting_retry",
    );
  }

  private pump(): void {
    if (this.isTerminal()) return;
    while (!this.cancelRequested) {
      this.checkBudgetStop();
      if (this.budgetStopped) break;
      if (this.countInState("running") >= this.maxConcurrency) break;
      this.evaluateGates();
      if (!this.admitNext()) break;
    }
    this.evaluateGates();
    if (this.countInState("running") > 0) return;
    if (!this.budgetStopped && this.countInState("waiting_retry") > 0) return;
    if (!this.hasNonTerminal()) {
      this.finalizeRun();
      return;
    }
    if (this.cancelRequested) {
      this.finalizeRun();
      return;
    }
    if (this.budgetStopped) {
      this.skipRemaining("budget_exhausted");
      this.finalizeRun();
      return;
    }
    this.finalizeStalled();
  }

  private evaluateGates(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const runtime of this.runtimes) {
        if (runtime.state !== "pending") continue;
        const outcome = this.gate(runtime);
        if (outcome === "undetermined") continue;
        changed = true;
        if (outcome === "ready") this.transition(runtime, "ready");
        else this.transition(runtime, "skipped", outcome.skip);
      }
    }
  }

  private gate(runtime: NodeRuntime): GateOutcome {
    const edges = this.incoming.get(runtime.node.id) ?? [];
    const refs = runtime.node.inputArtifacts ?? [];
    if (edges.length === 0 && refs.length === 0) return "ready";
    let active = 0;
    let routeBlocked = false;
    for (const edge of edges) {
      const source = this.runtimeById.get(edge.from);
      if (source === undefined) return "undetermined";
      switch (source.state) {
        case "succeeded":
          if (this.selectedEdges.get(edge.from)?.has(edge.id)) active += 1;
          break;
        case "skipped":
          if (source.skipReason === "route_not_selected") break;
          return { skip: "dependency_failed" };
        case "failed":
        case "cancelled":
          return { skip: "dependency_failed" };
        default:
          return "undetermined";
      }
    }
    for (const ref of refs) {
      const producer = this.runtimeById.get(ref.nodeId);
      if (producer === undefined) return "undetermined";
      switch (producer.state) {
        case "succeeded":
          break;
        case "skipped":
          if (producer.skipReason === "route_not_selected") {
            routeBlocked = true;
            break;
          }
          return { skip: "dependency_failed" };
        case "failed":
        case "cancelled":
          return { skip: "dependency_failed" };
        default:
          return "undetermined";
      }
    }
    if (routeBlocked) return { skip: "route_not_selected" };
    if (active === 0) return { skip: "route_not_selected" };
    return "ready";
  }

  private admitNext(): boolean {
    for (const runtime of this.runtimes) {
      if (runtime.state !== "ready") continue;
      if (runtime.node.kind === "agent") this.startAgentAttempt(runtime);
      else this.runDeterministicNode(runtime);
      return true;
    }
    return false;
  }

  private effectiveMaxAttempts(node: GraphNode): number {
    if (node.kind !== "agent") return 1;
    const nodeAttempts = node.retry?.maxAttempts ?? 1;
    const budgetAttempts = this.graph.budgets?.maxAttempts ?? Number.MAX_SAFE_INTEGER;
    return Math.max(1, Math.min(nodeAttempts, budgetAttempts));
  }

  private startAgentAttempt(runtime: NodeRuntime): void {
    const node = runtime.node as AgentNode;
    runtime.attempt += 1;
    this.transition(runtime, "running");
    try {
      const request: NodeExecutionRequest = {
        node,
        attempt: runtime.attempt,
        inputArtifacts: this.resolveInputs(node),
        resolvedContext:
          this.resolvedContexts.get(node.id) ??
          (() => {
            throw new GraphContractError("invalid_state", `missing resolved context for ${node.id}`);
          })(),
        parentContext: this.parentContext,
        signal: this.abortController.signal,
      };
      void this.awaitAttempt(runtime, request);
    } catch (error) {
      this.completeFailure(runtime, faultError(error, node.id, "failed to start node execution"));
      this.schedulePump();
    }
  }

  private async awaitAttempt(runtime: NodeRuntime, request: NodeExecutionRequest): Promise<void> {
    let outcome: NodeExecutorResult | typeof ABORTED;
    try {
      outcome = await Promise.race([
        this.executor.execute(request).then(
          (result) => normalizeExecutorResult(result, request.node.id),
          (error: unknown) => ({
            ok: false as const,
            error: faultError(error, request.node.id, "node executor threw"),
          }),
        ),
        this.abortSignalRace(),
      ]);
    } catch (error) {
      outcome = { ok: false, error: faultError(error, request.node.id, "node execution failed") };
    }
    if (this.isTerminal() || runtime.state !== "running") return;
    if (outcome === ABORTED) {
      this.transition(runtime, "cancelled");
      return;
    }
    if (outcome.ok) this.completeSuccess(runtime, request.node, outcome.output, outcome.usage);
    else this.completeFailure(runtime, outcome.error);
    this.schedulePump();
  }

  private abortSignalRace(): Promise<typeof ABORTED> {
    return new Promise((resolve) => {
      const signal = this.abortController.signal;
      if (signal.aborted) {
        resolve(ABORTED);
        return;
      }
      signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
    });
  }

  private completeSuccess(
    runtime: NodeRuntime,
    node: AgentNode,
    output: AgentNodeOutput,
    usage: Usage | undefined,
  ): void {
    let artifact: Artifact;
    try {
      artifact = createArtifact({
        id: this.nextArtifactId(node.id, "output"),
        nodeId: node.id,
        value: output.value ?? null,
        finalText: output.finalText,
        ...(output.structuredOutput !== undefined ? { structuredOutput: output.structuredOutput } : {}),
        ...(usage !== undefined ? { usage } : {}),
      });
    } catch (error) {
      this.completeFailure(runtime, faultError(error, node.id, "agent output was rejected"));
      return;
    }
    this.recordArtifact(runtime, artifact);
  }

  private runDeterministicNode(runtime: NodeRuntime): void {
    const node = runtime.node as DeterministicNode;
    runtime.attempt += 1;
    this.transition(runtime, "running");
    try {
      const value = node.operation === "join" ? this.joinValue(node) : this.publishValue(node);
      const artifact = createDeterministicArtifact({
        id: this.nextArtifactId(node.id, node.operation),
        nodeId: node.id,
        value,
      });
      this.recordArtifact(runtime, artifact);
    } catch (error) {
      this.completeFailure(runtime, faultError(error, node.id, "deterministic node failed"));
    }
  }

  private joinValue(node: DeterministicNode): JsonValue {
    const refs = node.inputArtifacts?.length ? node.inputArtifacts : this.activeIncomingRefs(node);
    const value: Record<string, JsonValue> = {};
    for (const ref of refs) value[ref.nodeId] = resolveArtifactOutput(this.requireArtifact(ref), ref.output);
    return value;
  }

  /** When a join declares no inputs, join the active incoming edges' primary outputs. */
  private activeIncomingRefs(node: DeterministicNode): ArtifactRef[] {
    const refs: ArtifactRef[] = [];
    for (const edge of this.incoming.get(node.id) ?? []) {
      const source = this.runtimeById.get(edge.from);
      if (source?.state !== "succeeded") continue;
      if (!this.selectedEdges.get(edge.from)?.has(edge.id)) continue;
      refs.push({ nodeId: edge.from, output: source.node.kind === "agent" ? "finalText" : "value" });
    }
    return refs;
  }

  private publishValue(node: DeterministicNode): JsonValue {
    const refs = node.inputArtifacts ?? [];
    if (refs.length === 0) return null;
    if (refs.length === 1) return resolveArtifactOutput(this.requireArtifact(refs[0]), refs[0].output);
    return refs.map((ref) => resolveArtifactOutput(this.requireArtifact(ref), ref.output));
  }

  private requireArtifact(ref: ArtifactRef): Artifact {
    const artifact = this.artifactByNode.get(ref.nodeId);
    if (artifact === undefined) {
      throw new GraphContractError("invalid_state", `artifact from ${ref.nodeId} is unavailable`);
    }
    return artifact;
  }

  private resolveInputs(node: AgentNode): RoutedArtifact[] {
    return (node.inputArtifacts ?? []).map((ref) => {
      const artifact = this.requireArtifact(ref);
      return { ref, artifact, value: resolveArtifactOutput(artifact, ref.output) };
    });
  }

  private recordArtifact(runtime: NodeRuntime, artifact: Artifact): void {
    this.artifacts.push(artifact);
    this.artifactByNode.set(runtime.node.id, artifact);
    runtime.artifactIds.length = 0;
    runtime.artifactIds.push(artifact.id);
    this.selectedEdges.set(
      runtime.node.id,
      new Set(selectGraphRoutes(this.outgoing.get(runtime.node.id) ?? [], artifact).map((edge) => edge.id)),
    );
    this.addUsage(artifact.usage);
    this.transition(runtime, "succeeded");
  }

  private addUsage(usage: Usage | undefined): void {
    if (usage === undefined) return;
    this.usageTotals.inputTokens += usage.inputTokens;
    this.usageTotals.outputTokens += usage.outputTokens;
    this.usageTotals.totalTokens += usage.totalTokens;
    if (usage.cost !== undefined) {
      this.usageTotals.costSum += usage.cost;
      this.usageTotals.costDefined = true;
    }
  }

  private completeFailure(runtime: NodeRuntime, error: GraphError): void {
    runtime.error = withNodeId(error, runtime.node.id);
    const maxAttempts = this.effectiveMaxAttempts(runtime.node);
    const backoffMs = runtime.node.kind === "agent" ? (runtime.node.retry?.backoffMs ?? 0) : 0;
    if (runtime.attempt < maxAttempts && !this.cancelRequested && !this.budgetStopped) {
      this.transition(runtime, "waiting_retry");
      runtime.retryTimer = setTimeout(() => {
        runtime.retryTimer = undefined;
        this.transition(runtime, "ready");
        this.schedulePump();
      }, backoffMs);
    } else {
      this.transition(runtime, "failed");
    }
  }

  private clearRetryTimer(runtime: NodeRuntime): void {
    if (runtime.retryTimer !== undefined) {
      clearTimeout(runtime.retryTimer);
      runtime.retryTimer = undefined;
    }
  }

  private skipRemaining(reason: SkipReason): void {
    for (const runtime of this.runtimes) {
      this.clearRetryTimer(runtime);
      if (
        runtime.state === "pending" ||
        runtime.state === "ready" ||
        runtime.state === "running" ||
        runtime.state === "waiting_retry"
      ) {
        this.transition(runtime, "skipped", reason);
      }
    }
  }

  private checkBudgetStop(): void {
    if (this.budgetStopped) return;
    const budgets = this.graph.budgets;
    if (budgets === undefined) return;
    const cost = this.usageTotals.costDefined ? this.usageTotals.costSum : 0;
    if (
      (budgets.maxInputTokens !== undefined && this.usageTotals.inputTokens >= budgets.maxInputTokens) ||
      (budgets.maxOutputTokens !== undefined && this.usageTotals.outputTokens >= budgets.maxOutputTokens) ||
      (budgets.maxCost !== undefined && cost >= budgets.maxCost)
    ) {
      this.budgetStopped = true;
    }
  }

  private nextArtifactId(nodeId: string, kind: string): string {
    const base = `${nodeId.slice(0, 56)}-${kind}`.slice(0, 64);
    let id = base;
    let suffix = 2;
    while (this.usedArtifactIds.has(id)) {
      id = `${base.slice(0, 61)}-${suffix}`.slice(0, 64);
      suffix += 1;
    }
    this.usedArtifactIds.add(id);
    return id;
  }

  private finalizeRun(): void {
    if (this.isTerminal()) return;
    this.removeParentListener?.();
    this.removeParentListener = undefined;
    const failed = this.runtimes.find((runtime) => runtime.state === "failed");
    if (this.cancelRequested) {
      this.runState = "cancelled";
    } else if (failed !== undefined) {
      this.runError = failed.error ?? { code: "invalid_state", message: "node failed without an error" };
      this.runState = "failed";
    } else if (this.budgetStopped) {
      this.cancellation = { requested: true, reason: "budget_exhausted" };
      this.runState = "cancelled";
    } else {
      this.runState = "succeeded";
    }
    const snapshot = this.snapshot();
    this.emit(
      this.runState === "failed"
        ? { type: "run_failed", runId: this.runId, snapshot }
        : this.runState === "cancelled"
          ? { type: "run_cancelled", runId: this.runId, snapshot }
          : { type: "run_completed", runId: this.runId, snapshot },
    );
    this.resolveDone(snapshot);
  }

  private finalizeStalled(): void {
    this.runError = {
      code: "invalid_state",
      message: "scheduler stalled with non-terminal nodes and no in-flight work",
    };
    this.runState = "failed";
    const snapshot = this.snapshot();
    this.emit({ type: "run_failed", runId: this.runId, snapshot });
    this.resolveDone(snapshot);
  }
}

function groupEdges(graph: GraphSpec, keyOf: (edge: GraphEdge) => string): ReadonlyMap<string, readonly GraphEdge[]> {
  const groups = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const key = keyOf(edge);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [edge]);
    else group.push(edge);
  }
  return groups;
}
