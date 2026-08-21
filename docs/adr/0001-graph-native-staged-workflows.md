---
status: superseded
superseded-by: 0003-remove-legacy-imperative-workflow.md
---

# Make staged workflows graph-native in pi-dynamic-workflows

> **Superseded:** [ADR 0003](0003-remove-legacy-imperative-workflow.md) removes the separate imperative workflow mode. This ADR is preserved as the historical record of the original graph-native decision.

We will implement staged workflows as a declarative, graph-native execution mode in `pi-dynamic-workflows`, provisionally exposed as `workflow_graph`, while preserving the existing JavaScript `workflow` runtime as a separate legacy mode. The graph runtime will create Pi agent sessions directly through the Pi SDK; `pi-subagents` may inform implementation patterns but will not be a required runtime dependency.

This decision gives staged execution explicit nodes, dependencies, conditional routes, skipped states, model selection, and direct artifact handoff without forcing the existing dynamic JavaScript language into a statically graphable representation.

## Decisions

- A graph definition is validated and frozen before execution. Runtime agent results select declared edges; arbitrary runtime topology mutation and general cycles are not part of the initial design.
- `staged-workflow` becomes a policy/compiler that produces a graph containing contract work, safe parallel lanes, ownership boundaries, integration joins, bounded review routes, and final verification.
- Every agent node publishes its final assistant message as `finalText`. Thinking, tool output, intermediate messages, and full transcripts are not routed by default. A successful run's `finalAnswer` includes every successful topology sink in declaration order: agent sinks contribute `finalText`, deterministic sinks contribute raw strings or stable JSON text, and multiple sinks use labelled `### nodeId` blocks.
- Text-regex predicates over `finalText` are first-class routing conditions. Structured JSON output remains optional.
- The standard review pass predicate matches `<verdict>\s*pass\s*</verdict>`. A match skips remediation and Review 2; a non-match follows the remediation and Review 2 route. Invalid regex is a graph validation error, and skipped nodes remain visible with reasons.
- Intermediate artifacts are materialized by the graph engine directly into downstream node inputs. They are not relayed through the main agent.
- Graph runs execute in the background. Starting `workflow_graph` returns a `runId` immediately; separate status, wait, and cancel operations control the run while the main agent remains available.
- Background completion is surfaced through graph UI/lifecycle events and one terminal-only custom follow-up that wakes the parent with the run state and successful final answer; intermediate node context is never relayed.
- Nodes may specify model and thinking overrides. Resolution is node override, then role default, then workflow default, then the invoking parent session's actual model and thinking level. An explicitly requested unavailable model fails preflight without silent fallback.
- The graph runtime exclusively owns graph concurrency, retry admission, cancellation, and budgets. Nested agent/workflow orchestration is disabled by default in graph nodes.

## Considered Options

- **Import and execute through `pi-subagents`: rejected as a required boundary.** It would add queue, lifecycle, and compatibility coupling that the graph runtime does not need. Useful patterns can be adopted while Pi sessions remain locally owned.
- **Replace the existing JavaScript workflow runtime: rejected.** Existing workflows rely on runtime JavaScript conditions and loops that cannot generally be converted into a frozen, resumable graph.
- **Require structured output for routing: rejected.** Ordinary final assistant text with explicit regex predicates supports lightweight graph triggers such as the verdict tag. Structured output remains available when stronger contracts are needed.
- **Relay intermediate node results through the main agent: rejected.** It increases context use, lets the parent reinterpret artifacts, and prevents direct graph-to-graph handoff. A terminal-only completion follow-up is accepted so the parent can resume with the canonical final answer.

## Consequences

- The project will maintain two explicit workflow modes with different guarantees: dynamic legacy JavaScript and declarative graph execution.
- The MVP must prove background start/status/wait/cancel behavior, model inheritance, final-text routing, visible skipped nodes, graph-owned concurrency, and terminal-only parent wake-up without intermediate relay before persistence or Git integration is added.
- MVP background runs are process-local and do not survive a Pi process restart.
- Durable background persistence, crash recovery, editing worktrees, deterministic Git integration, shell confinement, and richer graph visualization remain later architectural increments.
- The implementation plan and acceptance gates are maintained in [`../tasks.md`](../tasks.md).
