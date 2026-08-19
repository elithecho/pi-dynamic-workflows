/**
 * Ambient globals available inside pi-dynamic-workflows graph workflow scripts.
 *
 * Graph scripts are declarative: they declare agent nodes and routed edges that compile into a
 * frozen `GraphSpec` and run in the existing background graph runtime. This is unlike the
 * imperative legacy `workflow` scripts (`await agent(...)`, `parallel(...)`), which execute as
 * a sandboxed program — see `docs/adr/0002-graph-script-dsl.md` for the frozen grammar.
 *
 * Add this to a JavaScript or TypeScript graph script file for editor IntelliSense:
 *
 *   /// <reference types="pi-dynamic-workflows/workflow-graph" />
 */

export {};

declare global {
  /** Literal graph metadata. Must be the first statement: `export const meta = { ... }`. */
  interface GraphScriptMeta {
    name: string;
    description: string;
    /** Overrides the graph id; when absent the id is slugified from `name`. */
    id?: string;
  }

  /** Requested model. `provider` and `modelId` are non-empty string literals. */
  interface GraphScriptModel {
    provider: string;
    modelId: string;
  }

  interface GraphScriptAgentOptions {
    /** Declared role. Compiles to the node's `role` plus an entry in `graph.roles`. */
    role?: string;
    model?: GraphScriptModel;
    /** Thinking level. Invalid values surface as `invalid_thinking_level` at compile time. */
    thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  }

  /**
   * An agent node declared by `const <id> = agent(...)`. The `const` binding name is the node id;
   * there is no `opts.id` in v1. Each edge statement declares exactly one edge.
   */
  interface AgentHandle {
    /** Always edge `this → target`. Returns the target. */
    to(target: AgentHandle): AgentHandle;
    /**
     * Predicate edge `this → target`, selected when this node's final text matches `regex` (a
     * string with no flags, or an `/<re>/i` literal; safe subset only). Must be immediately
     * chained with `.otherwise(...)`.
     */
    when(regex: string | RegExp, target: AgentHandle): Router;
  }

  /** Fallback router returned by `when`. Must be closed with exactly one `.otherwise(...)`. */
  interface Router {
    /** Fallback edge from the `when` source, fired when no `when` matches. Returns the source handle. */
    otherwise(target: AgentHandle): AgentHandle;
  }

  interface GraphScriptBudgetOptions {
    maxConcurrency?: number;
    maxAttempts?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxCost?: number;
  }

  /**
   * Declare an agent node. The node id is the `const` binding name; `prompt` and `opts` must be
   * static literals.
   */
  function agent(prompt: string, opts?: GraphScriptAgentOptions): AgentHandle;

  /** Set `GraphSpec.budgets`. At most one call per script; `opts` must be a static literal. */
  function budget(opts: GraphScriptBudgetOptions): void;
}
