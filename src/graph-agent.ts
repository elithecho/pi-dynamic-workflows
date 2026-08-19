/**
 * Graph-owned Pi agent runner (Execution-1).
 *
 * Executes one frozen `AgentNode` as a direct Pi SDK child session:
 * - exact model/thinking resolution comes from the engine's frozen
 *   `resolveExecutionContext` output (node → role → workflow → parent);
 * - the resolved model selector is looked up through a model registry and
 *   passed explicitly to `createAgentSession` — an unavailable model fails
 *   with `model_unavailable` and no session is created (no silent fallback);
 * - only the final assistant text becomes `finalText` (never thinking, tool
 *   calls, or intermediate messages);
 * - structured output stays optional: a node declaring `structuredOutput`
 *   requires a caller-supplied schema (the frozen GraphSpec carries none),
 *   otherwise the runner fails loudly instead of producing nothing;
 * - cancellation, timeout, failures, and disposal are handled on every path;
 * - nested agent/workflow orchestration is disabled by default: the runner
 *   never registers subagent/workflow tools in child sessions.
 */

import type { Usage as AiUsage, AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { GraphContractError, type GraphError, type JsonValue, type Usage } from "./graph.js";
import type { NodeExecutionRequest, NodeExecutor, NodeExecutorResult, RoutedArtifact } from "./graph-runtime.js";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

/** Maps the pi-ai assistant usage to the frozen contract `Usage` shape. */
function mapUsage(usage: AiUsage): Usage {
  return {
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...(usage.cost === undefined ? {} : { cost: usage.cost.total }),
  };
}

/** Sum the usage across all assistant messages known to the session. */
export function sumAssistantUsage(messages: readonly unknown[]): Usage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costSum = 0;
  let costDefined = false;
  let found = false;
  for (const message of messages) {
    const assistant = message as Partial<AssistantMessage> | undefined;
    if (assistant?.role !== "assistant" || assistant.usage === undefined || assistant.usage === null) continue;
    const usage = mapUsage(assistant.usage);
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    totalTokens += usage.totalTokens;
    if (usage.cost !== undefined) {
      costSum += usage.cost;
      costDefined = true;
    }
    found = true;
  }
  if (!found) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(costDefined ? { cost: costSum } : {}),
  };
}

/** Capture ONLY the last assistant message's text (never thinking/tool content). */
export function lastAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const parts = message.content.filter((part): part is TextContent => part.type === "text");
    const text = parts.map((part) => part.text).join("");
    if (text.trim()) return text;
  }
  return "";
}

/** The minimal registry surface the runner needs: `find` returns the SDK Model. */
export interface GraphModelRegistryLike {
  readonly find: (provider: string, modelId: string) => Model<any> | undefined;
}

/** Result of creating a child session; injected so tests stay hermetic. */
export interface GraphSession {
  readonly messages: AgentMessageLike[];
  prompt(input: string): Promise<void>;
  abort(): void;
  dispose(): void;
}

export interface AgentMessageLike {
  readonly role: string;
  readonly content?: string | readonly unknown[];
  readonly usage?: AiUsage;
}

export type GraphSessionFactory = (options: CreateAgentSessionOptions) => Promise<GraphSession>;

export interface GraphAgentRunnerOptions {
  cwd?: string;
  /** Model registry used to resolve the frozen `ModelSelector` to a session Model. Required. */
  modelRegistry: GraphModelRegistryLike;
  /** Base tools for child sessions. Default: `createCodingTools(cwd)`. Workflow/subagent tools are never auto-added. */
  tools?: ToolDefinition[];
  /** Per-node structured-output schemas, required when a node declares `outputs: ["structuredOutput"]`. */
  structuredOutputSchemas?: Readonly<Record<string, TSchema>>;
  /** Per-node session timeout in ms. When it fires, the session is aborted and the node fails. */
  timeoutMs?: number;
  /** Injectable session factory for hermetic tests. Defaults to the real `createAgentSession`. */
  sessionFactory?: GraphSessionFactory;
}

/**
 * Executes one agent node against the Pi SDK. Implements the engine's
 * `NodeExecutor` boundary: builds the session prompt from the node prompt plus
 * the engine-routed input artifacts, resolves the model/thinking from the
 * request's frozen `resolvedContext`, and reports a structured result.
 */
export class GraphAgentRunner implements NodeExecutor {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly modelRegistry: GraphModelRegistryLike;
  private readonly structuredOutputSchemas: Readonly<Record<string, TSchema>>;
  private readonly timeoutMs?: number;
  private readonly sessionFactory: GraphSessionFactory;

  constructor(options: GraphAgentRunnerOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.modelRegistry = options.modelRegistry;
    this.structuredOutputSchemas = options.structuredOutputSchemas ?? {};
    this.timeoutMs = options.timeoutMs;
    this.sessionFactory = options.sessionFactory ?? this.defaultSessionFactory;
  }

  private async defaultSessionFactory(options: CreateAgentSessionOptions): Promise<GraphSession> {
    const { session } = await createAgentSession(options);
    return session;
  }

  async execute(request: NodeExecutionRequest): Promise<NodeExecutorResult> {
    const { node, resolvedContext } = request;
    if (node.kind !== "agent") {
      return this.fail(node.id, "invalid_graph", `node ${node.id} is not an agent node`);
    }
    const schema = node.outputs?.includes("structuredOutput") ? this.structuredOutputSchemas[node.id] : undefined;
    if (node.outputs?.includes("structuredOutput") && schema === undefined) {
      return this.fail(
        node.id,
        "invalid_state",
        `node ${node.id} declares structuredOutput but no schema was supplied to the runner`,
      );
    }
    if (resolvedContext === undefined) {
      return this.fail(node.id, "missing_parent_model", "the engine did not provide a resolved context");
    }
    const model = this.modelRegistry.find(resolvedContext.model.provider, resolvedContext.model.modelId);
    if (model === undefined) {
      return this.fail(
        node.id,
        "model_unavailable",
        `model ${resolvedContext.model.provider}/${resolvedContext.model.modelId} is unavailable`,
      );
    }
    const capture: StructuredOutputCapture<Static<TSchema>> | undefined =
      schema === undefined ? undefined : { called: false, value: undefined };
    const customTools: ToolDefinition[] = [...this.baseTools];
    if (schema !== undefined && capture !== undefined) {
      customTools.push(createStructuredOutputTool({ schema, capture }) as unknown as ToolDefinition);
    }
    const agentDir = getAgentDir();
    const sessionOptions: CreateAgentSessionOptions = {
      cwd: this.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(this.cwd),
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      customTools,
      model,
      thinkingLevel: resolvedContext.thinking,
    };
    const { session, abortTimer, timedOut } = await this.createWithTimeout(node.id, sessionOptions);
    let removeAbortListener: (() => void) | undefined;
    try {
      if (request.signal.aborted) {
        session.abort();
        return this.fail(node.id, "invalid_state", "node execution cancelled before start");
      }
      const onAbort = () => session.abort();
      request.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => request.signal.removeEventListener("abort", onAbort);

      await session.prompt(this.buildPrompt(request));
      if (request.signal.aborted) {
        return this.fail(node.id, "invalid_state", "node execution cancelled");
      }
      if (timedOut()) {
        return this.fail(node.id, "invalid_state", `node execution timed out after ${this.timeoutMs}ms`);
      }
      const finalText = lastAssistantText(session.messages);
      if (capture !== undefined) {
        if (!capture.called) {
          return this.fail(node.id, "invalid_state", "subagent finished without calling structured_output");
        }
        return {
          ok: true,
          output: {
            finalText,
            // The structured-output tool captures whatever the model produced;
            // the graph contract requires structured output to be JSON, which
            // the capture tool enforces for JSON-schema TypeBox schemas.
            ...(schema !== undefined ? { structuredOutput: capture.value as JsonValue } : {}),
          },
          usage: sumAssistantUsage(session.messages),
        };
      }
      return { ok: true, output: { finalText }, usage: sumAssistantUsage(session.messages) };
    } catch (error) {
      if (request.signal.aborted) {
        return this.fail(node.id, "invalid_state", "node execution cancelled");
      }
      return this.fail(node.id, "invalid_state", `node execution failed: ${formatError(error)}`);
    } finally {
      removeAbortListener?.();
      clearTimeout(abortTimer);
      session.dispose();
    }
  }

  private async createWithTimeout(
    nodeId: string,
    sessionOptions: CreateAgentSessionOptions,
  ): Promise<{
    session: GraphSession;
    abortTimer?: ReturnType<typeof setTimeout>;
    timedOut: () => boolean;
  }> {
    try {
      const session = await this.sessionFactory(sessionOptions);
      if (this.timeoutMs === undefined) return { session, timedOut: () => false };
      let aborted = false;
      const abortTimer = setTimeout(() => {
        aborted = true;
        session.abort();
      }, this.timeoutMs);
      return { session, abortTimer, timedOut: () => aborted };
    } catch (error) {
      throw new GraphContractError("invalid_state", `failed to create session for ${nodeId}: ${formatError(error)}`);
    }
  }

  private buildPrompt(request: NodeExecutionRequest): string {
    const parts: string[] = [request.node.prompt];
    if (request.inputArtifacts.length > 0) {
      const sections = request.inputArtifacts.map((routed: RoutedArtifact) => {
        const label = `${routed.ref.nodeId} (${routed.ref.output})`;
        const serialized = JSON.stringify(routed.value, null, 2);
        return `### Artifact from ${label}\n\`\`\`json\n${serialized}\n\`\`\``;
      });
      parts.push(`Input artifacts:\n${sections.join("\n\n")}`);
    }
    return parts.join("\n\n");
  }

  private fail(nodeId: string, code: GraphError["code"], message: string): NodeExecutorResult {
    return { ok: false, error: { code, message, nodeId, retryable: false } };
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
