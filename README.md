# pi-dynamic-workflows

> Graph-native dynamic workflows for [Pi](https://github.com/earendil-works/pi).

A Pi extension for declarative multi-agent graphs. Agents declare nodes, routing edges, fan-out,
joins, and budgets; `workflow_graph` compiles and runs the graph in the background.

## Breaking change in 2.0.0

The legacy imperative `workflow` tool has been removed. The `./workflow` package subpath and
legacy root exports (`createWorkflowTool`, `runWorkflow`, `WorkflowAgent`, and legacy display
helpers) are also removed. `workflow_graph` is now the sole workflow tool and uses a declarative
DSL. Migrate imperative scripts to `workflow_graph` scripts, or use its `definition` and `graph`
inputs for programmatic builders; see [`docs/usage.md`](docs/usage.md).

## Install

```bash
pi install git:github.com/elithecho/pi-dynamic-workflows
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

Then in Pi, run `/reload`. The extension registers and activates the `workflow_graph` and `wait_for_workflow` tools.

## Skill

This repo ships a Pi skill at `skills/pi-workflow/SKILL.md` for agents authoring graph workflows.
Install it with one of:

```bash
npx skills add https://github.com/elithecho/pi-dynamic-workflows --skill pi-workflow
pnpx skills add https://github.com/elithecho/pi-dynamic-workflows --skill pi-workflow
bunx skills add https://github.com/elithecho/pi-dynamic-workflows --skill pi-workflow
```

## Graph workflow scripts

The leading authoring surface is a small declarative JavaScript DSL. It is compiled into a
`GraphSpec`; scripts are never evaluated as general JavaScript.

```js
export const meta = { name: 'fix_or_ship', description: 'Coder → review → fix then ship, or ship directly.' }

const coder  = agent('Implement the change.', { role: 'implementation' })
const review = agent('Review the change.', { role: 'reviewer' })
const fixer  = agent('Apply requested changes.', { role: 'implementation' })
const done   = agent('Finalize and report.', { role: 'verifier' })

coder.to(review)
review.when('<verdict>change</verdict>', fixer).otherwise(done)
fixer.to(done)
```

A convergent target receives an automatic deterministic join. Fan-out is multiple `.to()` edges:

```js
export const meta = { name: 'audit', description: 'Scan, analyze, and synthesize.' }
const scan = agent('Inventory the repository.')
const facts = agent('Collect structural facts.')
const risks = agent('Collect security risks.')
const report = agent('Synthesize the analyses.')
scan.to(facts)
scan.to(risks)
facts.to(report)
risks.to(report)
budget({ maxConcurrency: 3 })
```

The `start` operation accepts exactly one input:

| Input | Use |
| --- | --- |
| `script` | Declarative Graph JS DSL; recommended for agent-authored workflows. |
| `definition` | JSON nodes and routes for programmatic builders. |
| `graph` | A complete, validated raw `GraphSpec`. |

```text
workflow_graph { operation: "start", script: "<graph script>" } → runId
workflow_graph { operation: "status", runId }                  → run state
workflow_graph { operation: "wait", runId, timeoutMs? }        → run state/final answer
workflow_graph { operation: "cancel", runId, reason? }         → cancellation result
wait_for_workflow { runId }                                    → terminal run state/final answer
```

`start` returns immediately while the graph runs in the background. The start tool-result row
refreshes with current progress; no bottom widget is used. A terminal follow-up normally wakes the
parent with the canonical final answer from successful sinks; intermediate artifacts remain inside
the graph runtime. Use
`wait_for_workflow { runId }` when the parent should block until completion; it claims a still-running
run, returns the same bounded terminal result as `workflow_graph wait`, and ends the parent turn
without an additional model response. Both tools share one process-local, in-memory registry per
extension runtime. Aborting the wait only aborts that caller's wait, not the graph: the same run
remains queryable by its `runId` while that Pi process lives, but not after process exit or restart.
Do not rely on an exact-once terminal notification if waiter abortion races with completion; query by
`runId` instead.

### DSL rules

The first statement must be `export const meta = { name, description, id? }`. Remaining statements
are agent declarations, `.to()` edges, `.when(...).otherwise(...)` routed edges, and at most one
`budget({...})` call. Arguments are static literals only: no `await`, `return`, loops, imports,
arrays, spreads, interpolation, or other calls or arbitrary member access. The declared `.to()`,
`.when()`, and `.otherwise()` edge methods are allowed.

```js
/// <reference types="pi-dynamic-workflows/workflow-graph" />
```

The full grammar, error taxonomy, and acceptance fixtures are in
[`docs/adr/0002-graph-script-dsl.md`](docs/adr/0002-graph-script-dsl.md); the usage guide is
[`docs/usage.md`](docs/usage.md).

## How it works

```text
user prompt
  → Pi model writes a declarative graph script
  → workflow_graph compiles the script to GraphSpec
  → graph runtime schedules nodes, routes, joins, retries, and budgets
  → child Pi sessions publish finalText artifacts to downstream nodes
  → terminal graph state wakes the parent with the canonical answer
```

Graph nodes run in fresh in-memory Pi sessions with standard coding tools. The graph runtime owns
concurrency, routing, retries, cancellation, and artifact handoff. Structured output remains
available to graph nodes through the shared `structured-output` module.

## Library modules

| File | Purpose |
| --- | --- |
| `src/graph.ts` | Graph contract, validation, routes, artifacts, and final answers. |
| `src/graph-tool.ts` | The Pi `workflow_graph` tool and its DSL guidance. |
| `src/wait-for-workflow-tool.ts` | The bounded terminal `wait_for_workflow` tool. |
| `src/graph-agent.ts` | Direct Pi child-session execution for graph nodes. |
| `src/graph-runtime.ts` | Background graph scheduler and execution state. |
| `src/graph-definition.ts` | JSON graph-definition compiler. |
| `src/graph-script.ts` | Declarative Graph JS compiler. |
| `src/structured-output.ts` | Shared terminating structured-output tool. |
| `extensions/workflow.ts` | The Pi extension entrypoint. |

## Development

```bash
npm install
npm test     # biome check + tsc + unit tests
npm run dev
```

The graph contract targets the Pi SDK `0.78.x` API surface. The development dependencies are
pinned to `0.78.0`.

## Status

This is a prototype. It implements process-local background graph runs but does not yet implement
persisted or resumable runs, or a `/workflows` manager.

## License

MIT
