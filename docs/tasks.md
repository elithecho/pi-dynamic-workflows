# Graph-Native Staged Workflows — Execution Plan

> **Historical planning document:** superseded for current product scope by [ADR 0003](adr/0003-remove-legacy-imperative-workflow.md). Legacy workflow references below describe the original implementation plan and are not current API guidance.

**Status:** Accepted for staged implementation
**Target repository:** `/Users/elijah/Workspace/pi-dynamic-workflows`
**Reference repository:** `/Users/elijah/Workspace/pi-subagents` (patterns only; no required runtime dependency)
**Architectural decision:** [`docs/adr/0001-graph-native-staged-workflows.md`](adr/0001-graph-native-staged-workflows.md)

## Locked Architecture

`staged-workflow` becomes a graph-native dynamic workflow executed directly by `pi-dynamic-workflows`.

- Preserve the existing JavaScript `workflow` tool and runtime as legacy mode.
- Add a distinct graph-native mode, provisionally named `workflow_graph`.
- The graph runtime creates child Pi sessions directly with the Pi SDK.
- Graph nodes may select a `model` and `thinking` level. Resolution order is:
  1. node override
  2. role default
  3. workflow default
  4. invoking parent session's actual model/thinking level
- An explicit unavailable model fails node preflight; it must not silently fall back.
- Every agent node publishes its final assistant message as `finalText`.
- Thinking, tool output, intermediate messages, and full transcripts are not routed by default.
- The graph engine passes declared artifacts directly to downstream nodes. The main agent does not relay or rewrite intermediate results.
- Graph runs execute in the background. Starting `workflow_graph` returns a `runId` immediately; status, wait, and cancel operations manage the process-local run while the main agent remains available.
- Completion is exposed through graph UI/lifecycle events rather than an intermediate-context follow-up turn.
- Structured JSON output remains optional. Ordinary final-text matching is a first-class routing mechanism.
- Graph concurrency and budget admission belong to the graph runtime. Nested agent/workflow orchestration is disabled by default inside graph nodes.

## Dynamic Review Contract

The default staged review route evaluates only the reviewer agent's final assistant message.

```text
Implementation ─► Review 1 ─┬─ regex pass ───────────────► Final verification
                             │
                             └─ no match ─► Remediation ─► Review 2 ─► Final verification
```

The pass route uses a configurable text predicate equivalent to:

```regex
<verdict>\s*pass\s*</verdict>
```

Defaults:

- matching is case-sensitive unless flags explicitly change it;
- only `finalText` is searched;
- a match skips remediation and Review 2;
- no match follows the non-pass route;
- malformed regex is a graph validation error, not a no-match result;
- skipped nodes remain in graph state with an explicit `route_not_selected` reason;
- the exact compact response `<verdict>pass</verdict>` is supported and recommended.

Regex definitions contain `source`, `pattern`, and optional `flags`. Graph validation must reject unsupported flags and oversized patterns. Runtime matching must use bounded input and a safe regex strategy to mitigate catastrophic backtracking.

## Minimum Shippable Scope

The first shippable tracer bullet includes:

- a versioned declarative graph specification;
- agent nodes and directed edges;
- direct child-session execution through the Pi SDK;
- per-node model/thinking overrides with parent inheritance;
- in-memory immutable artifacts;
- `finalText` publication;
- regex predicates over `finalText`;
- optional JSON predicates over structured output;
- deterministic routes, joins, skips, retries, and cancellation;
- graph-owned concurrency admission;
- process-local background run registry with start, status, wait, and cancel operations;
- bounded staged review expansion;
- observable pass and non-pass review paths;
- preservation of the existing JavaScript workflow runtime.

## Deferred Surfaces

- background runs surviving a Pi process restart;
- persisted and resumable graph runs;
- event journal and run lease;
- Git worktree creation, commit artifacts, and deterministic integration;
- trusted shell versus sandbox policy for editing agents;
- rich interactive graph visualization;
- Mermaid/DOT export;
- automatic application of workflow commits to the user's branch;
- arbitrary runtime graph mutation and general cyclic graphs;
- graphing the internals of legacy JavaScript workflows.

## Canonical Graph Concepts

- **GraphSpec:** versioned, serializable graph definition.
- **Run:** one execution of a frozen GraphSpec.
- **Node:** one agent or deterministic graph operation.
- **Edge:** dependency or conditional route between nodes.
- **Route:** a set of predicates selecting downstream edges.
- **Artifact:** immutable output published by a successful node.
- **finalText:** the producing agent's final assistant message.
- **Role default:** model/thinking configuration shared by nodes with the same staged role.
- **Skip:** terminal node outcome caused by routing or an unavailable dependency, not successful execution.

Node states:

```text
pending → ready → running → succeeded
                         ├─ failed
                         ├─ cancelled
                         └─ waiting_retry → ready

pending → skipped
```

Expected route-based skips do not fail a run. Failed required nodes or missing required graph outputs do.

## Agent Budget and Stop Condition

Target implementation budget:

- contract owner: 1 agent
- Pi execution/model lane: 1 agent
- graph scheduler lane: 1 agent
- tracer-bullet integrator: 1 agent
- persistent reviewer: 1 agent
- final verifier: 1 agent
- repair executors: at most 2

Target: **6 agents**, hard stop: **8 agents**.
Peak planned concurrency: **2 implementation lanes** after the contract stage.

Stop and request a decision if:

- implementation requires changing the legacy workflow contract;
- explicit model inheritance cannot be obtained from the invoking Pi session;
- safe regex evaluation requires an unapproved dependency;
- graph nodes require unrestricted shell access during the MVP;
- the agent budget would exceed eight.

## Dependency Graph and Critical Path

```text
Contract + Pi baseline
        ├─ Pi agent/model execution lane ─┐
        └─ Pure graph runtime lane ───────┼─ Review-routing tracer bullet
                                         │
                                         ├─ Integration review gate
                                         └─ Final verification

Later: tracer bullet → persistence → Git workspaces/integration → richer UI
```

Critical path:

```text
Contract → slower of the two foundation lanes → tracer bullet → review → verification
```

## Executor Work Items

### Stage 0 — Lock the Runtime Contract

- [ ] **Contract-1: Freeze graph and execution contracts**
  - Files: new graph type/contract modules and tests; exact locations chosen during implementation exploration.
  - Depends on: none.
  - Must not touch: current legacy runtime behavior.
  - Deliverable:
    - GraphSpec, node, edge, route, artifact, run, and state definitions;
    - model/thinking inheritance rules;
    - final-text predicate contract;
    - review-flow acceptance fixtures;
    - error and cancellation semantics;
    - process-local background start/status/wait/cancel contracts.
  - Verification:
    - types compile;
    - valid/invalid fixture tests cover routes, regexes, and model selectors;
    - legacy parser/runtime tests remain unchanged.

- [ ] **Contract-2: Align and verify the supported Pi SDK baseline**
  - Files: package manifest/lockfile only where required.
  - Depends on: none.
  - Must not touch: graph or agent behavior.
  - Deliverable: one supported Pi SDK baseline and documented compatibility expectation.
  - Verification: clean install, typecheck, and existing tests.

### Stage 1 — Parallel Foundations

- [ ] **Execution-1: Add direct Pi graph-node execution**
  - Files: primarily `src/agent.ts` or a new graph-owned agent runner and focused tests.
  - Depends on: Contract-1 and Contract-2.
  - Must not touch: graph scheduler implementation or legacy workflow semantics.
  - Deliverable:
    - direct `createAgentSession` execution;
    - explicit model resolution through Pi's model runtime;
    - parent model/thinking inheritance;
    - final assistant text capture;
    - optional structured output;
    - cancellation, cleanup, and usage evidence;
    - nested orchestration disabled by default.
  - Verification:
    - explicit model selected;
    - omitted model inherits the invoking model;
    - unavailable explicit model fails preflight;
    - only final assistant text becomes `finalText`;
    - sessions dispose on success, failure, timeout, and cancellation.

- [ ] **Graph-1: Implement the pure graph runtime**
  - Files: new graph validator/scheduler/predicate/artifact modules and focused tests.
  - Depends on: Contract-1.
  - Must not touch: Pi session runner or legacy workflow implementation.
  - Deliverable:
    - deterministic ready-node scheduling;
    - graph-owned concurrency;
    - in-memory immutable artifacts;
    - final-text regex and optional JSON predicates;
    - route selection, joins, retries, skips, and cancellation;
    - bounded staged review expansion.
  - Verification:
    - fake-executor tests cover pass, no-match, invalid regex, failure, retry, cancellation, and concurrency;
    - skipped nodes retain reasons;
    - malformed regex fails validation before execution.

### Stage 2 — Graph-Native Staged Workflow Tracer Bullet

- [ ] **Integration-1: Add graph-native workflow entry point**
  - Files: graph tool, extension registration, graph runtime adapter, and integration tests.
  - Depends on: Execution-1 and Graph-1.
  - Must not touch: behavior of the existing `workflow` tool.
  - Deliverable:
    - provisional `workflow_graph` entry point returning a `runId` immediately;
    - process-local run registry and status/wait/cancel operations;
    - staged-workflow graph construction;
    - direct artifact handoff;
    - graph progress snapshots with visible skipped nodes.
  - Verification:
    - graph input cannot be interpreted as a legacy script and vice versa;
    - start returns before graph completion and the main agent remains available;
    - status and wait observe the same run, and cancel aborts active nodes and prevents new admission;
    - intermediate node results do not use a main-agent message or follow-up turn;
    - graph concurrency never exceeds its configured maximum.

- [ ] **Scenario-1: Pass-path review workflow**
  - Files: integration fixtures/tests only.
  - Depends on: Integration-1.
  - Must not touch: production behavior beyond fixture hooks.
  - Deliverable: Review 1 returns `<verdict>pass</verdict>` in its final message.
  - Verification:
    - pass regex matches;
    - remediation invocation count is zero;
    - Review 2 invocation count is zero;
    - both nodes are recorded skipped;
    - final verification runs.

- [ ] **Scenario-2: Non-pass review workflow**
  - Files: integration fixtures/tests only.
  - Depends on: Integration-1.
  - Must not touch: production behavior beyond fixture hooks.
  - Deliverable: Review 1 final text does not match the pass regex.
  - Verification:
    - remediation receives Review 1's finalText artifact directly;
    - Review 2 runs after remediation;
    - final verification receives the selected branch artifacts.

- [ ] **Scenario-3: Predicate safety and terminal-only completion**
  - Files: integration fixtures/tests only.
  - Depends on: Integration-1.
  - Must not touch: unrelated workflow features.
  - Deliverable: adversarial predicate and message-routing fixtures.
  - Verification:
    - tool output or thinking containing the verdict does not trigger the edge;
    - malformed regex is rejected;
    - bounded input prevents unbounded matching work;
    - instrumentation proves terminal completion may wake the parent once, but no `pi.sendMessage`, parent follow-up, or equivalent relay transports intermediate artifacts.

## Fan-Out Order and Non-Overlap Rules

1. Complete Stage 0 before implementation fan-out.
2. Run Execution-1 and Graph-1 concurrently in isolated worktrees or isolated patches.
3. Do not let both lanes edit `src/workflow.ts`, `src/workflow-tool.ts`, `src/index.ts`, or `extensions/workflow.ts` concurrently.
4. Integration-1 owns composition roots after both foundation lanes join.
5. Scenario tests may be split after Integration-1 stabilizes, provided fixtures do not share mutable files.
6. A graph consumer may begin from the frozen contract; it does not need to wait for Pi runner internals.

## Parallelization Audit

Challenged edges:

- Execution runner and graph scheduler require only the frozen Stage 0 contract, so they remain parallel.
- Graph tool integration requires implemented runner and scheduler behavior, so that join remains serialized.
- Review scenarios require the integrated entry point, so they remain after Integration-1.
- Persistence remains after the tracer bullet because its event protocol should capture proven runtime transitions.
- Git integration remains after persistence because crash-safe Git operations require durable operation records.

Rejected unsafe splits:

- concurrent edits to extension/tool composition roots;
- multiple executors changing legacy workflow parsing/runtime behavior;
- UI implementation before graph states and event shapes stabilize;
- Git integration before recovery semantics exist.

Peak safe concurrency for the MVP is **two implementation lanes**.

## Persistent Integration Review Gate

- [ ] **Review-1: Graph-native staged workflow integration review**
  - Reviewer: must not be an executor of the reviewed implementation.
  - Review checklist:
    - [ ] legacy `workflow` behavior is preserved;
    - [ ] graph mode has a distinct validated input contract;
    - [ ] explicit node model selection is enforced;
    - [ ] omitted model/thinking inherits the invoking session;
    - [ ] no silent model fallback occurs;
    - [ ] final-text routing observes only the final assistant message;
    - [ ] exact verdict pass takes the skip branch;
    - [ ] non-match takes remediation/Review 2;
    - [ ] regex errors fail validation;
    - [ ] skipped nodes and reasons are graph-visible;
    - [ ] intermediate artifacts bypass the main agent;
    - [ ] graph start returns a run ID immediately;
    - [ ] status, wait, and cancel operate on the background run;
    - [ ] completion uses graph lifecycle/UI events plus one terminal-only final-answer wake-up; intermediate artifacts never enter the parent context;
    - [ ] graph runtime alone controls graph concurrency;
    - [ ] structured output remains optional.
  - Block completion until: all critical/high findings are resolved and medium findings have an explicit ship-or-follow-up decision.

Use one continuing reviewer and at most two repair rounds. After the second failed gate review, close the gate, preserve unresolved findings with severity, and request direction if any critical/high finding invalidates the MVP.

## Final Verification

- [ ] **Verify-1: Cross-cutting MVP verification**
  - Files: no production edits unless a mechanically verified repair is required.
  - Depends on: Integration-1, Scenario-1, Scenario-2, Scenario-3, and Review-1.
  - Must not touch: product scope.
  - Deliverable: verification evidence mapped to the locked architecture.
  - Verification:
    - run formatter/lint checks;
    - run TypeScript typecheck;
    - run all existing tests;
    - run graph unit and integration tests;
    - manually inspect one pass and one non-pass graph snapshot;
    - confirm exact model inheritance and explicit model selection;
    - confirm cancellation and concurrency behavior;
    - list deferred non-blocking follow-ups.

## Completion Evidence

The MVP is complete only when evidence demonstrates:

1. Review 1's final message matching `<verdict>\s*pass\s*</verdict>` skips remediation and Review 2.
2. A non-match runs remediation and Review 2.
3. Thinking, tool output, and intermediate messages cannot trigger final-text routes.
4. Downstream nodes consume engine-routed artifacts without an intermediate-artifact main-agent relay.
5. Explicit node models execute on the requested available model.
6. Nodes without a model inherit the invoking parent model and thinking level.
7. An unavailable explicit model fails preflight without fallback.
8. Starting a graph returns a run ID before completion; status, wait, and cancel control that same process-local background run.
9. Graph concurrency obeys the graph limit.
10. Existing JavaScript workflows continue to pass their tests unchanged.
11. All lint, typecheck, unit, and integration checks pass.
