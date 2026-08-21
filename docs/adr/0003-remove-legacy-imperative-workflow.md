---
status: accepted
---

# Make `workflow_graph` the sole workflow tool

ADR 0003 supersedes the preserve-legacy decision in [ADR 0001](0001-graph-native-staged-workflows.md).
The product now exposes only the declarative `workflow_graph` runtime and extension tool.

## Decision

Remove the imperative JavaScript workflow runtime and its Pi tool. `workflow_graph` is the sole
workflow authoring and execution surface because it provides a frozen, validated graph contract,
explicit routing and joins, bounded concurrency and budgets, process-local background lifecycle
operations, direct artifact handoff, and terminal-only parent completion. Maintaining a second
sandboxed imperative runtime would duplicate orchestration and lifecycle behavior, preserve a
conflicting authoring model, and continue exposing APIs that the graph product no longer needs.

Graph scripts are declarative: they declare agent nodes, edges, and budgets. Runtime topology is
not mutated by arbitrary JavaScript control flow. JSON `definition` and raw `GraphSpec` remain
supported escape hatches through the same `workflow_graph` tool.

## Consequences

The following legacy implementation files, tests, types, and public APIs are deleted:

- `src/workflow.ts`, `src/workflow-tool.ts`, `src/agent.ts`, and `src/display.ts`;
- their imperative runtime/tool/display tests;
- `types/workflow.d.ts` and the `./workflow` package export;
- root exports for `WorkflowAgent`, `runWorkflow`, `createWorkflowTool`, and imperative display/parser
  types and helpers.

The extension registers and activates only `workflow_graph`. Existing graph modules and behavior
remain unchanged. Consumers importing the removed `./workflow` subpath or named exports must migrate
to graph scripts and the `workflow_graph` tool; there is no compatibility shim.

The shared `structured-output` module is intentionally preserved. Graph agent execution can still
use terminating structured output where a graph node needs a schema, and structured output remains
part of the package's graph-supporting public API.

## Migration

- Rewrite imperative scripts as declarative `workflow_graph` `script` inputs: declare each agent as
  `const <id> = agent(prompt, opts?)`, connect nodes with `.to()` or
  `.when(...).otherwise(...)`, and set limits with `budget({...})`.
- Use `definition` for programmatic JSON builders or `graph` for an already-built `GraphSpec`.
- Replace direct `runWorkflow`/`WorkflowAgent` usage with the graph compiler/runtime and graph tool
  lifecycle (`start`, `status`, `wait`, `cancel`).
- Replace imperative display callbacks with graph snapshots and the graph extension's terminal
  completion follow-up.
- Keep structured output schemas in graph node execution; this capability was not removed.

Historical ADRs and planning documents retain their original wording where it records the design
history, but are marked as superseded and must not be used as current API guidance.
