/**
 * Version 1 graph-native workflow contracts.
 *
 * This module is deliberately limited to serializable contracts, preflight
 * validation, and pure resolution helpers. It does not execute graph nodes.
 * The graph API targets the Pi SDK 0.78.x model/thinking surface.
 */

export const GRAPH_CONTRACT_VERSION = 1 as const;
export const MAX_FINAL_TEXT_INPUT_LENGTH = 32_768;
export const MAX_REGEX_PATTERN_LENGTH = 256;
export const SUPPORTED_REGEX_FLAGS = "i";
export const DEFAULT_FINAL_TEXT_PATTERN = "<verdict>\\s*pass\\s*</verdict>";
/**
 * The only supported regex syntax is literal text plus `\\s` and `\\s*`.
 * Only the case-insensitive flag is supported; syntax outside this subset is
 * rejected rather than delegated to the native backtracking engine.
 */
export const SAFE_REGEX_SUBSET_DESCRIPTION =
  "literal characters and \\s / \\s* whitespace tokens; no alternation, groups, classes, anchors, or other quantifiers";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type GraphThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelSelector {
  readonly provider: string;
  readonly modelId: string;
}

export interface ExecutionDefaults {
  readonly model?: ModelSelector;
  readonly thinking?: GraphThinkingLevel;
}

export type ArtifactOutputKind = "value" | "finalText" | "structuredOutput";

/** A typed handoff; arbitrary artifact IDs are intentionally not accepted. */
export interface ArtifactRef {
  readonly nodeId: string;
  readonly output: ArtifactOutputKind;
}

export interface AgentNode extends ExecutionDefaults {
  readonly kind: "agent";
  readonly id: string;
  readonly prompt: string;
  readonly role?: string;
  readonly inputArtifacts?: readonly ArtifactRef[];
  /** `structuredOutput` must be listed when a structured artifact is produced. */
  readonly outputs?: readonly ("finalText" | "structuredOutput")[];
  readonly retry?: RetryPolicy;
}

export type DeterministicOperation = "join" | "publish";

export interface DeterministicNode {
  readonly kind: "deterministic";
  readonly id: string;
  readonly operation: DeterministicOperation;
  readonly inputArtifacts?: readonly ArtifactRef[];
}

export type GraphNode = AgentNode | DeterministicNode;

export interface FinalTextRegex {
  readonly source: "finalText";
  readonly pattern: string;
  readonly flags?: string;
}

export interface JsonPredicate {
  readonly source: "json";
  /** JSON Pointer, for example `/verdict` or `/findings/0/severity`. */
  readonly path: string;
  readonly equals?: JsonValue;
  readonly exists?: boolean;
}

export type GraphPredicate =
  | { readonly type: "finalText"; readonly regex: FinalTextRegex }
  | { readonly type: "json"; readonly predicate: JsonPredicate };

export interface GraphRoute {
  readonly kind: "always" | "predicate" | "otherwise";
  readonly predicate?: GraphPredicate;
}

export interface GraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly route?: GraphRoute;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs?: number;
}

export interface GraphBudgets {
  readonly maxConcurrency?: number;
  readonly maxAttempts?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxCost?: number;
}

export interface GraphSpec {
  readonly version: typeof GRAPH_CONTRACT_VERSION;
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly defaults?: ExecutionDefaults;
  readonly roles?: Readonly<Record<string, ExecutionDefaults>>;
  readonly budgets?: GraphBudgets;
}

export type NodeState =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "waiting_retry"
  | "skipped";
export type RunState = "created" | "running" | "succeeded" | "failed" | "cancelled";
export type SkipReason = "route_not_selected" | "dependency_failed" | "cancelled" | "budget_exhausted";
export type CancellationReason = "requested" | "parent_aborted" | "timeout" | "budget_exhausted";

export type GraphErrorCode =
  | "invalid_graph"
  | "invalid_regex"
  | "invalid_model_selector"
  | "invalid_thinking_level"
  | "missing_parent_model"
  | "missing_parent_thinking"
  | "model_unavailable"
  | "missing_model_registry"
  | "invalid_state"
  | "run_not_found"
  | "cancel_rejected";

export interface GraphError {
  readonly code: GraphErrorCode;
  readonly message: string;
  readonly nodeId?: string;
  readonly retryable?: boolean;
  readonly details?: JsonValue;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cost?: number;
}

export interface ArtifactBase {
  readonly id: string;
  readonly nodeId: string;
  readonly value: JsonValue;
  readonly usage?: Usage;
}

/** Successful agent output: finalText is always materialized. */
export interface AgentArtifact extends ArtifactBase {
  readonly finalText: string;
  readonly structuredOutput?: JsonValue;
}

export interface DeterministicArtifact extends ArtifactBase {}

export type Artifact = AgentArtifact | DeterministicArtifact;

export interface NodeSnapshotBase {
  readonly id: string;
  readonly attempt: number;
  readonly artifactIds: readonly string[];
}

export type NodeSnapshot = NodeSnapshotBase &
  (
    | {
        readonly state: "pending" | "ready" | "running" | "cancelled" | "waiting_retry";
        readonly error?: never;
        readonly skipReason?: never;
      }
    | { readonly state: "succeeded"; readonly error?: never; readonly skipReason?: never }
    | { readonly state: "failed"; readonly error: GraphError; readonly skipReason?: never }
    | { readonly state: "skipped"; readonly skipReason: SkipReason; readonly error?: never }
  );

export interface Cancellation {
  readonly requested: boolean;
  readonly reason?: CancellationReason;
}

export interface GraphRunSnapshotBase {
  readonly runId: string;
  readonly graphId: string;
  /** Epoch milliseconds when GraphRunEngine.start() established the run boundary. */
  readonly startedAtEpochMs: number;
  /** Monotonic elapsed duration; running snapshots calculate this, terminal snapshots freeze it. */
  readonly elapsedMs: number;
  /** Aggregate SDK turn_start events across every child session and retry. */
  readonly turnCount: number;
  readonly nodes: readonly NodeSnapshot[];
  readonly artifacts: readonly Artifact[];
  readonly usage: Usage;
}

export type GraphRunSnapshot = GraphRunSnapshotBase &
  (
    | {
        readonly state: "created" | "running";
        readonly error?: never;
        readonly cancellation?: Cancellation;
        readonly finalAnswer?: never;
      }
    | {
        readonly state: "succeeded";
        /** Canonical answer from every successful topology sink. */
        readonly finalAnswer: string;
        readonly error?: never;
        readonly cancellation?: Cancellation;
      }
    | {
        readonly state: "failed";
        readonly error: GraphError;
        readonly cancellation?: Cancellation;
        readonly finalAnswer?: never;
      }
    | {
        readonly state: "cancelled";
        readonly cancellation: Cancellation;
        readonly error?: never;
        readonly finalAnswer?: never;
      }
  );
/** Short alias used by lifecycle consumers. */
export type RunSnapshot = GraphRunSnapshot;

/** Stable JSON text for deterministic terminal artifact values. */
function stableJsonText(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonText).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonText(value[key] as JsonValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Select every successful topology sink in graph declaration order. Agent
 * sinks contribute finalText; deterministic sinks contribute their artifact
 * value. A single sink is returned verbatim, while multiple sinks are labelled
 * so all answers survive without depending on artifact completion order.
 */
export function selectGraphFinalAnswer(
  graph: GraphSpec,
  nodes: readonly NodeSnapshot[],
  artifacts: readonly Artifact[],
): string {
  const successfulNodes = new Set(nodes.filter((node) => node.state === "succeeded").map((node) => node.id));
  const artifactsByNode = new Map(artifacts.map((artifact) => [artifact.nodeId, artifact]));
  const outputs = graph.nodes
    .filter((node) => !graph.edges.some((edge) => edge.from === node.id) && successfulNodes.has(node.id))
    .flatMap((node) => {
      const artifact = artifactsByNode.get(node.id);
      if (artifact === undefined) return [];
      const text =
        node.kind === "agent" && "finalText" in artifact
          ? artifact.finalText
          : node.kind === "deterministic"
            ? typeof artifact.value === "string"
              ? artifact.value
              : stableJsonText(artifact.value)
            : undefined;
      return text === undefined ? [] : [{ nodeId: node.id, text }];
    });
  if (outputs.length === 1) return outputs[0].text;
  return outputs.map((output) => `### ${output.nodeId}\n${output.text}`).join("\n\n");
}

const MAX_GRAPH_FINAL_ANSWER_LENGTH = 4_000;

/** Bound graph final-answer presentation without changing the canonical snapshot field. */
export function formatGraphFinalAnswer(value: string, max = MAX_GRAPH_FINAL_ANSWER_LENGTH): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  const marker = "… [truncated]";
  if (max <= marker.length) return marker.slice(0, max);
  return `${value.slice(0, max - marker.length)}${marker}`;
}

/** Render actionable, bounded metadata for failed or cancelled terminal runs. */
export function formatGraphTerminalDetails(snapshot: GraphRunSnapshot): string {
  if (snapshot.state === "failed") {
    const node = snapshot.error.nodeId === undefined ? "" : ` node=${snapshot.error.nodeId.slice(0, 64)}`;
    const message = snapshot.error.message.slice(0, 256);
    return ` error code=${snapshot.error.code}${node} message=${message}`;
  }
  if (snapshot.state === "cancelled") return ` cancellation reason=${snapshot.cancellation.reason ?? "requested"}`;
  return "";
}

export interface InvokingParentExecutionContext {
  readonly model: ModelSelector;
  readonly thinking: GraphThinkingLevel;
}

/** Extension boundary for obtaining the actual invoking parent execution context. */
export interface GraphParentExecutionContextAdapter {
  readonly getModel: () => ModelSelector | undefined;
  readonly getThinkingLevel: () => GraphThinkingLevel | undefined;
}

export interface ModelThinkingSources {
  readonly node?: ExecutionDefaults;
  readonly role?: ExecutionDefaults;
  readonly workflow?: ExecutionDefaults;
  readonly parent: InvokingParentExecutionContext;
}

export interface ResolvedExecutionContext {
  readonly model: ModelSelector;
  readonly thinking: GraphThinkingLevel;
  readonly modelSource: "node" | "role" | "workflow" | "parent";
  readonly thinkingSource: "node" | "role" | "workflow" | "parent";
}

/** Serializable request; parent context is supplied by the internal adapter. */
export interface GraphStartRequest {
  readonly graph: GraphSpec;
}

export interface GraphStartResult {
  readonly runId: string;
  /** State copied from the full initial snapshot, including immediate terminal runs. */
  readonly state: GraphRunSnapshot["state"];
  /** Full initial snapshot for tool renderers and callers observing start. */
  readonly run: GraphRunSnapshot;
}

export interface GraphStatusRequest {
  readonly runId: string;
}

export interface GraphStatusResult {
  readonly run: GraphRunSnapshot;
}

export interface GraphWaitRequest {
  readonly runId: string;
  readonly timeoutMs?: number;
}

export interface GraphWaitResult {
  readonly run: GraphRunSnapshot;
  readonly completed: boolean;
}

export interface GraphCancelRequest {
  readonly runId: string;
  readonly reason?: CancellationReason;
}

export type GraphCancelResult =
  | { readonly accepted: true; readonly run: GraphRunSnapshot; readonly error?: never }
  | {
      readonly accepted: false;
      readonly run?: GraphRunSnapshot;
      readonly error: GraphError & { readonly code: "cancel_rejected" | "run_not_found" };
    };

export interface GraphOperationError {
  readonly ok: false;
  readonly error: GraphError;
}
export interface GraphOperationSuccess<T> {
  readonly ok: true;
  readonly result: T;
}
export type GraphOperationResult<T> = GraphOperationSuccess<T> | GraphOperationError;
export type GraphStartOperationResult = GraphOperationResult<GraphStartResult>;
export type GraphStatusOperationResult = GraphOperationResult<GraphStatusResult>;
export type GraphWaitOperationResult = GraphOperationResult<GraphWaitResult>;
export type GraphCancelOperationResult = GraphOperationResult<GraphCancelResult>;

export type GraphLifecycleEvent =
  | { readonly type: "run_started"; readonly runId: string; readonly graphId: string }
  | { readonly type: "turn_started"; readonly runId: string; readonly turnCount: number }
  | { readonly type: "node_state_changed"; readonly runId: string; readonly node: NodeSnapshot }
  | { readonly type: "run_completed"; readonly runId: string; readonly snapshot: GraphRunSnapshot }
  | { readonly type: "run_failed"; readonly runId: string; readonly snapshot: GraphRunSnapshot }
  | { readonly type: "run_cancelled"; readonly runId: string; readonly snapshot: GraphRunSnapshot };

export type GraphEvent = GraphLifecycleEvent;

export interface ModelRegistryLike {
  readonly find: (provider: string, modelId: string) => unknown;
}

export class GraphContractError extends Error {
  readonly code: GraphErrorCode;
  readonly path?: string;

  constructor(code: GraphErrorCode, message: string, path?: string) {
    super(message);
    this.name = "GraphContractError";
    this.code = code;
    this.path = path;
  }
}

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)+$/;
const THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const REGEX_META_CHARACTERS = new Set("^$.*+?()[]{}|");
const SAFE_ESCAPES = new Set(["s"]);
const GRAPH_KEYS = new Set(["version", "id", "name", "nodes", "edges", "defaults", "roles", "budgets"]);

function contract(code: GraphErrorCode, message: string, path?: string): never {
  throw new GraphContractError(code, path ? `${path}: ${message}` : message, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) contract("invalid_graph", "expected an object", path);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) contract("invalid_graph", `unknown property ${key}`, `${path}.${key}`);
  }
}

function assertString(value: unknown, path: string, nonEmpty = true): asserts value is string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0))
    contract("invalid_graph", "expected a non-empty string", path);
}

function assertId(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (!ID_PATTERN.test(value)) contract("invalid_graph", "must match [A-Za-z][A-Za-z0-9_-]{0,63}", path);
}

function assertFiniteNonNegative(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    contract("invalid_graph", "must be finite and non-negative", path);
}

function assertPositiveInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    contract("invalid_graph", "must be a positive integer", path);
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((child) => isJsonValue(child, seen))
    : isRecord(value) && Object.values(value).every((child) => isJsonValue(child, seen));
  seen.delete(value);
  return valid;
}

function validateSelector(value: unknown, path: string): asserts value is ModelSelector {
  if (!isRecord(value)) contract("invalid_model_selector", "expected an object", path);
  assertKnownKeys(value, new Set(["provider", "modelId"]), path);
  if (typeof value.provider !== "string" || value.provider.length === 0)
    contract("invalid_model_selector", "provider must be a non-empty string", `${path}.provider`);
  if (typeof value.modelId !== "string" || value.modelId.length === 0)
    contract("invalid_model_selector", "modelId must be a non-empty string", `${path}.modelId`);
}

function validateThinking(value: unknown, path: string): asserts value is GraphThinkingLevel {
  if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
    throw new GraphContractError(
      "invalid_thinking_level",
      "must be one of off, minimal, low, medium, high, xhigh",
      path,
    );
  }
}

function validateDefaults(value: unknown, path: string): void {
  if (value === undefined) return;
  assertRecord(value, path);
  assertKnownKeys(value, new Set(["model", "thinking"]), path);
  if (value.model !== undefined) validateSelector(value.model, `${path}.model`);
  if (value.thinking !== undefined) validateThinking(value.thinking, `${path}.thinking`);
}

function validateRegex(regex: unknown, path: string): asserts regex is FinalTextRegex {
  assertRecord(regex, path);
  assertKnownKeys(regex, new Set(["source", "pattern", "flags"]), path);
  if (regex.source !== "finalText") {
    throw new GraphContractError("invalid_regex", "regex source must be finalText", `${path}.source`);
  }
  assertString(regex.pattern, `${path}.pattern`, false);
  if (regex.pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new GraphContractError(
      "invalid_regex",
      `pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} characters`,
      `${path}.pattern`,
    );
  }
  const flags = regex.flags ?? "";
  assertString(flags, `${path}.flags`, false);
  const seenFlags = new Set<string>();
  for (const flag of flags) {
    if (!SUPPORTED_REGEX_FLAGS.includes(flag) || seenFlags.has(flag)) {
      throw new GraphContractError("invalid_regex", `unsupported or duplicate regex flag ${flag}`, `${path}.flags`);
    }
    seenFlags.add(flag);
  }
  // This parser is intentionally narrower than JavaScript RegExp. Its matcher
  // has no backtracking constructs, so accepted patterns have predictable work.
  for (let index = 0; index < regex.pattern.length; index += 1) {
    const character = regex.pattern[index];
    if (character === "\\") {
      const escapedCharacter = regex.pattern[index + 1];
      if (escapedCharacter === undefined || !SAFE_ESCAPES.has(escapedCharacter))
        throw new GraphContractError(
          "invalid_regex",
          `escape \\${escapedCharacter ?? ""} is outside the safe subset`,
          path,
        );
      index += 1;
    } else if (
      REGEX_META_CHARACTERS.has(character) &&
      !(character === "*" && index >= 2 && regex.pattern[index - 2] === "\\" && regex.pattern[index - 1] === "s")
    ) {
      throw new GraphContractError("invalid_regex", `syntax ${character} is outside the safe regex subset`, path);
    }
  }
  // `*` is only meaningful as part of the recognized \\s* token.
  for (let index = 0; index < regex.pattern.length; index += 1) {
    if (
      regex.pattern[index] === "*" &&
      !(index >= 2 && regex.pattern[index - 2] === "\\" && regex.pattern[index - 1] === "s")
    ) {
      throw new GraphContractError("invalid_regex", "only \\s* is supported as a quantifier", path);
    }
  }
}

function validateJsonPredicate(predicate: unknown, path: string): asserts predicate is JsonPredicate {
  assertRecord(predicate, path);
  assertKnownKeys(predicate, new Set(["source", "path", "equals", "exists"]), path);
  if (predicate.source !== "json") contract("invalid_graph", "JSON predicate source must be json", `${path}.source`);
  assertString(predicate.path, `${path}.path`);
  if (!JSON_POINTER_PATTERN.test(predicate.path)) contract("invalid_graph", "must be a JSON Pointer", `${path}.path`);
  if (predicate.equals !== undefined && !isJsonValue(predicate.equals))
    contract("invalid_graph", "must be JSON-serializable", `${path}.equals`);
  if (predicate.exists !== undefined && typeof predicate.exists !== "boolean")
    contract("invalid_graph", "must be boolean", `${path}.exists`);
  if (predicate.equals === undefined && predicate.exists === undefined) {
    contract("invalid_graph", "must specify equals or exists", path);
  }
}

function validatePredicate(value: unknown, path: string): void {
  assertRecord(value, path);
  if (value.type === "finalText") {
    assertKnownKeys(value, new Set(["type", "regex"]), path);
    validateRegex(value.regex, `${path}.regex`);
  } else if (value.type === "json") {
    assertKnownKeys(value, new Set(["type", "predicate"]), path);
    validateJsonPredicate(value.predicate, `${path}.predicate`);
  } else {
    contract("invalid_graph", "type must be finalText or json", `${path}.type`);
  }
}

function validateRetry(value: unknown, path: string): void {
  if (value === undefined) return;
  assertRecord(value, path);
  assertKnownKeys(value, new Set(["maxAttempts", "backoffMs"]), path);
  assertPositiveInteger(value.maxAttempts, `${path}.maxAttempts`);
  if (value.backoffMs !== undefined) assertFiniteNonNegative(value.backoffMs, `${path}.backoffMs`);
}

function validateArtifactRefs(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) contract("invalid_graph", "must be an array", path);
  for (const [index, ref] of value.entries()) {
    const refPath = `${path}[${index}]`;
    assertRecord(ref, refPath);
    assertKnownKeys(ref, new Set(["nodeId", "output"]), refPath);
    assertId(ref.nodeId, `${refPath}.nodeId`);
    if (ref.output !== "value" && ref.output !== "finalText" && ref.output !== "structuredOutput")
      contract("invalid_graph", "unsupported artifact output", `${refPath}.output`);
  }
}

function validateNode(node: unknown, path: string): asserts node is GraphNode {
  assertRecord(node, path);
  const allowed =
    node.kind === "agent"
      ? new Set(["kind", "id", "prompt", "role", "model", "thinking", "inputArtifacts", "outputs", "retry"])
      : new Set(["kind", "id", "operation", "inputArtifacts"]);
  assertKnownKeys(node, allowed, path);
  assertId(node.id, `${path}.id`);
  if (node.kind === "agent") {
    assertString(node.prompt, `${path}.prompt`);
    if (node.role !== undefined) assertString(node.role, `${path}.role`);
    validateDefaults({ model: node.model, thinking: node.thinking }, path);
    validateRetry(node.retry, `${path}.retry`);
    if (node.outputs !== undefined) {
      if (!Array.isArray(node.outputs)) contract("invalid_graph", "must be an array", `${path}.outputs`);
      const outputs = new Set<string>();
      for (const [index, output] of node.outputs.entries()) {
        if (output !== "finalText" && output !== "structuredOutput")
          contract("invalid_graph", "unsupported agent output", `${path}.outputs[${index}]`);
        if (outputs.has(output)) contract("invalid_graph", "duplicate agent output", `${path}.outputs[${index}]`);
        outputs.add(output);
      }
    }
    validateArtifactRefs(node.inputArtifacts, `${path}.inputArtifacts`);
  } else if (node.kind === "deterministic") {
    if (node.operation !== "join" && node.operation !== "publish")
      contract("invalid_graph", "unsupported operation", `${path}.operation`);
    validateArtifactRefs(node.inputArtifacts, `${path}.inputArtifacts`);
  } else {
    contract("invalid_graph", "kind must be agent or deterministic", `${path}.kind`);
  }
}

function validateEdge(edge: unknown, path: string): asserts edge is GraphEdge {
  assertRecord(edge, path);
  assertKnownKeys(edge, new Set(["id", "from", "to", "route"]), path);
  assertId(edge.id, `${path}.id`);
  assertId(edge.from, `${path}.from`);
  assertId(edge.to, `${path}.to`);
  if (edge.route !== undefined) {
    assertRecord(edge.route, `${path}.route`);
    assertKnownKeys(edge.route, new Set(["kind", "predicate"]), `${path}.route`);
    if (edge.route.kind === "always") {
      if (edge.route.predicate !== undefined)
        contract("invalid_graph", "always route cannot have a predicate", `${path}.route.predicate`);
    } else if (edge.route.kind === "otherwise") {
      if (edge.route.predicate !== undefined)
        contract("invalid_graph", "otherwise route cannot have a predicate", `${path}.route.predicate`);
    } else if (edge.route.kind === "predicate") {
      if (edge.route.predicate === undefined)
        contract("invalid_graph", "predicate route requires a predicate", `${path}.route.predicate`);
      validatePredicate(edge.route.predicate, `${path}.route.predicate`);
    } else {
      contract("invalid_graph", "kind must be always, predicate, or otherwise", `${path}.route.kind`);
    }
  }
}

function validateBudgets(value: unknown, path: string): void {
  if (value === undefined) return;
  assertRecord(value, path);
  assertKnownKeys(
    value,
    new Set(["maxConcurrency", "maxAttempts", "maxInputTokens", "maxOutputTokens", "maxCost"]),
    path,
  );
  for (const key of ["maxAttempts", "maxInputTokens", "maxOutputTokens", "maxCost"] as const) {
    if (value[key] !== undefined) assertFiniteNonNegative(value[key], `${path}.${key}`);
  }
  if (value.maxConcurrency !== undefined) assertPositiveInteger(value.maxConcurrency, `${path}.maxConcurrency`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Array.from({ length: value.length }, (_, index) => {
      const child = value[index] as JsonValue | undefined;
      return child === undefined ? null : cloneJson(child);
    });
  }
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
  return value;
}

function assertAcyclic(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): void {
  const adjacency = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) contract("invalid_graph", "graph must be acyclic", `edges.from=${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of adjacency.get(id) ?? []) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

/** Validate and freeze a serializable graph before execution. */
export function validateGraphSpec(input: unknown): GraphSpec {
  if (!isJsonValue(input)) contract("invalid_graph", "graph must be JSON-serializable", "graph");
  assertRecord(input, "graph");
  const graph = input as unknown as Record<string, unknown>;
  assertKnownKeys(graph, GRAPH_KEYS, "graph");
  if (graph.version !== GRAPH_CONTRACT_VERSION)
    contract("invalid_graph", `version must be ${GRAPH_CONTRACT_VERSION}`, "graph.version");
  assertId(graph.id, "graph.id");
  assertString(graph.name, "graph.name");
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0)
    contract("invalid_graph", "must contain at least one node", "graph.nodes");
  if (!Array.isArray(graph.edges)) contract("invalid_graph", "must be an array", "graph.edges");
  for (const [index, node] of graph.nodes.entries()) validateNode(node, `graph.nodes[${index}]`);
  for (const [index, edge] of graph.edges.entries()) validateEdge(edge, `graph.edges[${index}]`);
  validateDefaults(graph.defaults, "graph.defaults");
  if (graph.roles !== undefined) {
    assertRecord(graph.roles, "graph.roles");
    for (const [role, defaults] of Object.entries(graph.roles)) {
      assertString(role, "graph.roles key");
      validateDefaults(defaults, `graph.roles.${role}`);
    }
  }
  validateBudgets(graph.budgets, "graph.budgets");

  const nodeIds = new Set<string>();
  const nodeById = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) contract("invalid_graph", "duplicate node id", `graph.nodes.${node.id}`);
    nodeIds.add(node.id);
    nodeById.set(node.id, node);
    if (
      node.kind === "agent" &&
      node.role !== undefined &&
      (graph.roles === undefined || !Object.hasOwn(graph.roles, node.role))
    ) {
      contract("invalid_graph", "role is not declared in graph.roles", `nodes.${node.id}.role`);
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) contract("invalid_graph", "duplicate edge id", `graph.edges.${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from)) contract("invalid_graph", "unknown source node", `graph.edges.${edge.id}.from`);
    if (!nodeIds.has(edge.to)) contract("invalid_graph", "unknown target node", `graph.edges.${edge.id}.to`);
    if (edge.route?.kind === "predicate") {
      const source = nodeById.get(edge.from);
      if (edge.route.predicate?.type === "finalText" && source?.kind !== "agent")
        contract("invalid_graph", "finalText predicates require an agent source", `edges.${edge.id}.route.predicate`);
      if (
        edge.route.predicate?.type === "json" &&
        (source?.kind !== "agent" || !source.outputs?.includes("structuredOutput"))
      ) {
        contract(
          "invalid_graph",
          "JSON predicates require an agent source declaring structuredOutput",
          `edges.${edge.id}.route.predicate`,
        );
      }
    }
  }
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  for (const [source, sourceEdges] of outgoing) {
    const predicateEdges = sourceEdges.filter((edge) => edge.route?.kind === "predicate");
    const otherwiseEdges = sourceEdges.filter((edge) => edge.route?.kind === "otherwise");
    const unconditionalEdges = sourceEdges.filter((edge) => edge.route === undefined || edge.route.kind === "always");
    if (otherwiseEdges.length > 1)
      contract("invalid_graph", "at most one otherwise route is allowed", `edges.from=${source}`);
    if (predicateEdges.length > 0 && otherwiseEdges.length !== 1)
      contract("invalid_graph", "predicate routes require exactly one otherwise fallback", `edges.from=${source}`);
    if (predicateEdges.length > 0 && unconditionalEdges.length > 0)
      contract("invalid_graph", "predicate routes cannot mix with always routes", `edges.from=${source}`);
    if (otherwiseEdges.length > 0 && unconditionalEdges.length > 0)
      contract("invalid_graph", "otherwise routes cannot mix with always routes", `edges.from=${source}`);
  }
  assertAcyclic(graph.nodes, graph.edges);
  const descendants = (producer: string, target: string): boolean => {
    const seen = new Set<string>();
    const visit = (id: string): boolean => {
      if (id === target) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (outgoing.get(id) ?? []).some((edge) => visit(edge.to));
    };
    return visit(producer);
  };
  for (const node of graph.nodes) {
    for (const [index, ref] of (node.inputArtifacts ?? []).entries()) {
      const producer = graph.nodes.find((candidate) => candidate.id === ref.nodeId);
      const refPath = `nodes.${node.id}.inputArtifacts[${index}]`;
      if (!producer) contract("invalid_graph", "artifact producer does not exist", `${refPath}.nodeId`);
      if (producer.id === node.id || !descendants(producer.id, node.id))
        contract("invalid_graph", "artifact producer must be a strict graph ancestor", refPath);
      if (ref.output === "finalText" && producer.kind !== "agent")
        contract("invalid_graph", "only agent nodes produce finalText", `${refPath}.output`);
      if (
        ref.output === "structuredOutput" &&
        (producer.kind !== "agent" || !producer.outputs?.includes("structuredOutput"))
      )
        contract("invalid_graph", "producer did not explicitly declare structuredOutput", `${refPath}.output`);
    }
  }
  return deepFreeze(input as unknown as GraphSpec);
}

/** Resolve model and thinking independently using node → role → workflow → parent precedence. */
export function resolveExecutionContext(sources: ModelThinkingSources): ResolvedExecutionContext {
  if (!sources.parent || sources.parent.model === undefined)
    throw new GraphContractError("missing_parent_model", "invoking parent model is required");
  if (sources.parent.thinking === undefined)
    throw new GraphContractError("missing_parent_thinking", "invoking parent thinking level is required");
  validateSelector(sources.parent.model, "parent.model");
  validateThinking(sources.parent.thinking, "parent.thinking");
  const modelSource =
    sources.node?.model !== undefined
      ? "node"
      : sources.role?.model !== undefined
        ? "role"
        : sources.workflow?.model !== undefined
          ? "workflow"
          : "parent";
  const thinkingSource =
    sources.node?.thinking !== undefined
      ? "node"
      : sources.role?.thinking !== undefined
        ? "role"
        : sources.workflow?.thinking !== undefined
          ? "workflow"
          : "parent";
  const model = sources.node?.model ?? sources.role?.model ?? sources.workflow?.model ?? sources.parent.model;
  const thinking =
    sources.node?.thinking ?? sources.role?.thinking ?? sources.workflow?.thinking ?? sources.parent.thinking;
  validateSelector(model, `${modelSource}.model`);
  validateThinking(thinking, `${thinkingSource}.thinking`);
  return deepFreeze({ model: { ...model }, thinking, modelSource, thinkingSource });
}

/** Resolve an adapter explicitly; missing parent values fail instead of silently falling back. */
export function getInvokingParentContext(adapter: GraphParentExecutionContextAdapter): InvokingParentExecutionContext {
  const model = adapter.getModel();
  const thinking = adapter.getThinkingLevel();
  if (model === undefined)
    throw new GraphContractError("missing_parent_model", "invoking parent adapter did not provide a model");
  if (thinking === undefined)
    throw new GraphContractError("missing_parent_thinking", "invoking parent adapter did not provide a thinking level");
  validateSelector(model, "parent.model");
  validateThinking(thinking, "parent.thinking");
  return deepFreeze({ model: { ...model }, thinking });
}

/** Preflight explicit selectors against the same provider/modelId lookup used by ModelRegistry.find. */
export function validateGraphPreflight(
  spec: GraphSpec,
  parent: InvokingParentExecutionContext,
  modelRegistry?: ModelRegistryLike,
): GraphSpec {
  const graph = validateGraphSpec(spec);
  if (modelRegistry === undefined)
    throw new GraphContractError("missing_model_registry", "a model registry is required for graph preflight");
  const roleDefaults = graph.roles ?? {};
  for (const node of graph.nodes) {
    if (node.kind !== "agent") continue;
    const role = node.role === undefined ? undefined : roleDefaults[node.role];
    const resolved = resolveExecutionContext({ node, role, workflow: graph.defaults, parent });
    if (modelRegistry.find(resolved.model.provider, resolved.model.modelId) === undefined) {
      throw new GraphContractError(
        "model_unavailable",
        `model ${resolved.model.provider}/${resolved.model.modelId} is unavailable`,
        `nodes.${node.id}.model`,
      );
    }
  }
  return graph;
}

function validateUsage(value: unknown, path: string): asserts value is Usage {
  assertRecord(value, path);
  assertKnownKeys(value, new Set(["inputTokens", "outputTokens", "totalTokens", "cost"]), path);
  assertFiniteNonNegative(value.inputTokens, `${path}.inputTokens`);
  assertFiniteNonNegative(value.outputTokens, `${path}.outputTokens`);
  assertFiniteNonNegative(value.totalTokens, `${path}.totalTokens`);
  if (value.cost !== undefined) assertFiniteNonNegative(value.cost, `${path}.cost`);
}

/** Create a detached, deeply immutable agent artifact. */
export function createArtifact(input: Omit<AgentArtifact, "value"> & { readonly value: JsonValue }): AgentArtifact {
  assertId(input.id, "artifact.id");
  assertId(input.nodeId, "artifact.nodeId");
  if (!isJsonValue(input.value)) contract("invalid_graph", "must be JSON-serializable", "artifact.value");
  if (input.structuredOutput !== undefined && !isJsonValue(input.structuredOutput))
    contract("invalid_graph", "must be JSON-serializable", "artifact.structuredOutput");
  if (input.usage !== undefined) validateUsage(input.usage, "artifact.usage");
  assertString(input.finalText, "artifact.finalText", false);
  if (input.finalText.length > MAX_FINAL_TEXT_INPUT_LENGTH)
    contract("invalid_graph", `must not exceed ${MAX_FINAL_TEXT_INPUT_LENGTH} characters`, "artifact.finalText");
  const usage =
    input.usage === undefined
      ? undefined
      : {
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          totalTokens: input.usage.totalTokens,
          ...(input.usage.cost === undefined ? {} : { cost: input.usage.cost }),
        };
  return deepFreeze({
    id: input.id,
    nodeId: input.nodeId,
    value: cloneJson(input.value),
    finalText: input.finalText,
    ...(input.structuredOutput === undefined ? {} : { structuredOutput: cloneJson(input.structuredOutput) }),
    ...(usage === undefined ? {} : { usage }),
  });
}

/** Create a detached immutable output for a deterministic node. */
export function createDeterministicArtifact(
  input: Omit<DeterministicArtifact, "value"> & { readonly value: JsonValue },
): DeterministicArtifact {
  assertId(input.id, "artifact.id");
  assertId(input.nodeId, "artifact.nodeId");
  if (!isJsonValue(input.value)) contract("invalid_graph", "must be JSON-serializable", "artifact.value");
  if (input.usage !== undefined) validateUsage(input.usage, "artifact.usage");
  return deepFreeze({
    id: input.id,
    nodeId: input.nodeId,
    value: cloneJson(input.value),
    ...(input.usage === undefined
      ? {}
      : {
          usage: {
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            totalTokens: input.usage.totalTokens,
            ...(input.usage.cost === undefined ? {} : { cost: input.usage.cost }),
          },
        }),
  });
}

type SafeRegexToken =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "space"; readonly many: boolean };

function safeRegexTokens(pattern: string): SafeRegexToken[] {
  const tokens: SafeRegexToken[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "\\") {
      const escapedCharacter = pattern[++index];
      if (escapedCharacter === "s") {
        const many = pattern[index + 1] === "*";
        if (many) index += 1;
        tokens.push({ kind: "space", many });
      } else {
        tokens.push({
          kind: "literal",
          value: escapedCharacter ?? "",
        });
      }
    } else tokens.push({ kind: "literal", value: pattern[index] });
  }
  return tokens;
}

function isWhitespace(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 0x0009 && code <= 0x000d) ||
    code === 0x0020 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function safeRegexMatches(pattern: string, flags: string, text: string): boolean {
  const tokens = safeRegexTokens(pattern);
  const insensitive = flags.includes("i");
  const equal = (left: string, right: string): boolean =>
    insensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
  // Simulate the finite automaton over all possible substring starts. Each
  // token scans the bounded input once: no recursive or exponential backtracking.
  let positions = new Uint8Array(text.length + 1);
  positions.fill(1);
  for (const token of tokens) {
    const next = new Uint8Array(text.length + 1);
    if (token.kind === "literal") {
      for (let position = 0; position < text.length; position += 1) {
        if (positions[position] === 1 && equal(text[position], token.value)) next[position + 1] = 1;
      }
    } else if (token.many) {
      next.set(positions);
      for (let position = 1; position <= text.length; position += 1) {
        if (isWhitespace(text[position - 1]) && next[position - 1] === 1) next[position] = 1;
      }
    } else {
      for (let position = 0; position < text.length; position += 1) {
        if (positions[position] === 1 && isWhitespace(text[position])) next[position + 1] = 1;
      }
    }
    positions = next;
    if (!positions.some((position) => position === 1)) return false;
  }
  return positions.some((position) => position === 1);
}

/** Validate a final-text predicate and match only bounded finalText (never thinking/tool output). */
export function matchesFinalText(predicate: GraphPredicate, finalText: string): boolean {
  if (predicate.type !== "finalText") return false;
  if (typeof finalText !== "string") contract("invalid_graph", "finalText must be a string", "finalText");
  validatePredicate(predicate, "predicate");
  return safeRegexMatches(
    predicate.regex.pattern,
    predicate.regex.flags ?? "",
    finalText.slice(0, MAX_FINAL_TEXT_INPUT_LENGTH),
  );
}

function jsonPointerGet(value: JsonValue, pointer: string): { found: boolean; value?: JsonValue } {
  let current: JsonValue = value;
  for (const segment of pointer.slice(1).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(key) || Number(key) >= current.length) return { found: false };
      current = current[Number(key)];
    } else if (isRecord(current) && Object.hasOwn(current, key)) {
      current = current[key] as JsonValue;
    } else return { found: false };
  }
  return { found: true, value: current };
}

function jsonEqual(left: JsonValue | undefined, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function matchesJsonPredicate(predicate: GraphPredicate, value: JsonValue): boolean {
  if (predicate.type !== "json") return false;
  validatePredicate(predicate, "predicate");
  const result = jsonPointerGet(value, predicate.predicate.path);
  if (predicate.predicate.exists !== undefined && result.found !== predicate.predicate.exists) return false;
  return (
    predicate.predicate.equals === undefined || (result.found && jsonEqual(result.value, predicate.predicate.equals))
  );
}

function edgeMatches(edge: GraphEdge, artifact: Artifact): boolean {
  if (edge.route === undefined || edge.route.kind === "always" || edge.route.kind === "otherwise") return false;
  const routePredicate = edge.route.predicate;
  if (routePredicate === undefined) return false;
  if (routePredicate.type === "finalText")
    return (
      "finalText" in artifact &&
      typeof artifact.finalText === "string" &&
      matchesFinalText(routePredicate, artifact.finalText)
    );
  return (
    "structuredOutput" in artifact &&
    artifact.structuredOutput !== undefined &&
    matchesJsonPredicate(routePredicate, artifact.structuredOutput)
  );
}

/** Select conditional outgoing edges: a matching predicate wins, otherwise wins only when none match. */
export function selectGraphRoutes(edges: readonly GraphEdge[], artifact: Artifact): readonly GraphEdge[] {
  const predicateEdges = edges.filter((edge) => edge.route?.kind === "predicate");
  const otherwiseEdges = edges.filter((edge) => edge.route?.kind === "otherwise");
  if (otherwiseEdges.length > 1)
    throw new GraphContractError("invalid_graph", "at most one otherwise route is allowed");
  const matching = predicateEdges.filter((edge) => edgeMatches(edge, artifact));
  return matching.length > 0
    ? matching
    : otherwiseEdges.length > 0
      ? otherwiseEdges
      : edges.filter((edge) => edge.route === undefined || edge.route.kind === "always");
}

/** Convenience form for the common single-route conditional branch. */
export function selectGraphRoute(edges: readonly GraphEdge[], artifact: Artifact): GraphEdge | undefined {
  const selected = selectGraphRoutes(edges, artifact);
  return selected.length === 1 ? selected[0] : undefined;
}

/** A join is satisfied when every active incoming dependency succeeded. */
export function isJoinSatisfied(
  joinNodeId: string,
  graph: GraphSpec,
  snapshots: readonly NodeSnapshot[],
  artifacts: readonly Artifact[] = [],
): boolean {
  const join = graph.nodes.find((node) => node.id === joinNodeId);
  if (join?.kind !== "deterministic" || join.operation !== "join") return false;
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const artifactByNode = new Map(artifacts.map((artifact) => [artifact.nodeId, artifact]));
  const incoming = graph.edges.filter((edge) => edge.to === joinNodeId);
  let active = false;
  for (const edge of incoming) {
    const source = byId.get(edge.from);
    if (!source) return false;
    if (source.state === "skipped" && source.skipReason === "route_not_selected") continue;
    if (source.state !== "succeeded") return false;
    const outgoing = graph.edges.filter((candidate) => candidate.from === edge.from);
    const sourceArtifact = artifactByNode.get(edge.from);
    if (outgoing.some((candidate) => candidate.route?.kind === "predicate") && sourceArtifact === undefined)
      return false;
    const selected = selectGraphRoutes(outgoing, sourceArtifact ?? { id: "missing", nodeId: edge.from, value: null });
    if (!selected.some((candidate) => candidate.id === edge.id)) continue;
    active = true;
  }
  return active;
}
