# pi-dynamic-workflows

> Claude-Code-style dynamic workflows for [Pi](https://github.com/earendil-works/pi).

A Pi extension that adds a `workflow` tool. Instead of one assistant doing everything sequentially, the model writes a small JavaScript script that fans out the work across many isolated subagents, then synthesizes the results.

Great for codebase audits, multi-perspective review, large refactors, and fan-out research.

Inspired by Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

## Install

```bash
pi install npm:pi-dynamic-workflows
# or from a local checkout
pi install /path/to/pi-dynamic-workflows
```

Then in Pi:

```text
/reload
```

That's it. The extension registers a `workflow` tool and activates it on session start.

## Usage

Just ask Pi for a workflow in plain language:

```text
Run a workflow to inspect this repository and summarize the main modules.
```

The model will write a workflow script and call the `workflow` tool. Live progress shows up inline:

```text
◆ Workflow: inspect_project (3/3 done)
  ✓ Scan 1/1
    #1 ✓ repo inventory
  ✓ Analyze 2/2
    #2 ✓ source modules
    #3 ✓ final summary
```

Press `Esc` to cancel a running workflow. Active subagents are aborted and surfaced as skipped.

## Workflow script shape

A workflow is plain JavaScript. The first statement must export literal metadata. `name` and `description` are required; `phases` is optional documentation for an expected outline. The live progress view is driven by `phase(...)` calls at runtime:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [
    { title: 'Scan' },
    { title: 'Analyze' },
  ],
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', {
  label: 'repo inventory',
})

phase('Analyze')
const summary = await agent(
  'Summarize the main modules from this inventory:\n' + inventory,
  { label: 'module summary' },
)

return { inventory, summary }
```

Phases are discovered as the script runs, so conditional and loop-created phases work naturally. If a branch is skipped, its phase does not show up as an empty progress row.

### Editor IntelliSense

Reusable workflow files can opt into editor hints for workflow globals:

```js
/// <reference types="pi-dynamic-workflows/workflow" />
```

This declares `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `cwd`, and `budget` for TypeScript-aware editors.

### Available globals

| Global | Description |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text or, with `opts.schema`, a validated object. |
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Results are returned in input order. |
| `pipeline(items, ...stages)` | Run each item through sequential stages while items fan out. Each stage receives `(prev, original, index)`. |
| `phase(title)` | Mark the current phase. Used for grouping in the live progress view. |
| `log(message)` | Append a workflow-level log line. |
| `args` | Optional JSON value passed in via the tool's `args` parameter. |
| `cwd`, `process.cwd()` | Current working directory for subagents. |
| `budget` | `{ total, spent(), remaining() }` token budget tracker. |

### Determinism rules

Workflow scripts are evaluated inside a Node `vm` sandbox. The following are intentionally unavailable:

- `Date.now()`, `new Date()`
- `Math.random()`
- `require`, `import`, `fs`, network APIs
- spreads, computed keys, template interpolation, function calls inside `meta`

This keeps `meta` parseable, runs reproducible, and the surface area small.

### Structured subagent output

Pass a JSON Schema via `opts.schema` and the subagent will return a validated object:

```js
const finding = await agent('Find security-sensitive files.', {
  label: 'security scan',
  schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
    },
    required: ['paths', 'reason'],
  },
})
```

Under the hood this is a Pi `structured_output` tool with `terminate: true`, so the subagent ends on that call without an extra assistant turn.

## Graph workflows (`workflow_graph`)

The extension also registers a `workflow_graph` tool. Where `workflow` scripts are imperative
plain JS that runs to completion, `workflow_graph` scripts are **declarative**: they declare
agent nodes and regex-routed edges that compile into a graph and run in a background runtime.
Start returns a `runId` immediately; `status`, `wait`, and `cancel` manage the run.

The canonical example — code, review, then fix-or-ship — is one conditional plus a convergence
point:

```js
export const meta = { name: 'fix_or_ship', description: 'Coder → review → fix then ship, or ship directly.' }

const coder  = agent('You are a coder agent. Read the coder skill and implement the change.', { role: 'implementation' })
const review = agent('Review the change. Respond with exactly <verdict>change</verdict> or <verdict>pass</verdict>.', { role: 'reviewer' })
const fixer  = agent('Apply the requested changes.', { role: 'implementation' })
const done   = agent('Finalize and report.', { role: 'verifier' })

coder.to(review)
review.when('<verdict>change</verdict>', fixer).otherwise(done)
fixer.to(done)
```

`done` has two distinct sources (`review` via otherwise, `fixer` via always), so the compiler
auto-inserts a deterministic `join` node (`done_join`) and rewrites both inbound edges onto it.
On the **change path** the predicate matches, `fixer` runs on `review.finalText`, and `done`
receives `{ fixer: "<fixer finalText>" }`. On the **pass path** the predicate misses, `fixer` is
skipped (`route_not_selected`), the otherwise edge fires, and `done` receives `{ review: "<review
finalText>" }`.

Fan-out is just multiple `.to()` edges: targets become ready together and run concurrently,
bounded by `budget({ maxConcurrency })` (default 4):

```js
export const meta = { name: 'audit', description: 'Scan, then three analyses, then synthesize.' }

const scan   = agent('Inventory the repo.')
const facts  = agent('Collect facts about structure.')
const risks  = agent('Collect risks about security.')
const dups   = agent('Find duplicated responsibility.')
const report = agent('Synthesize the three analyses.')

scan.to(facts)
scan.to(risks)
scan.to(dups)
facts.to(report)
risks.to(report)
dups.to(report)

budget({ maxConcurrency: 3 })
```

The `start` operation takes exactly one of three mutually-exclusive inputs:

| Input | Form |
| --- | --- |
| `script` | A declarative script as above — the leading surface. |
| `definition` | JSON `nodes`/`routes` for programmatic builders that prefer data over JS. |
| `graph` | A raw `GraphSpec`, validated for full-contract control. |

Declarative vs imperative at a glance:

| | `workflow_graph` (declarative) | `workflow` (imperative) |
| --- | --- | --- |
| Script shape | Declares nodes and routed edges; no control flow | Plain JS: `await`, loops, `parallel(...)`, `return` |
| Execution | Compiled to a graph, run in the background by the graph runtime | Sandbox runs to completion; the result returns to the calling turn |
| Routing | Regex predicates over a source's final text | Explicit program logic |

The v1 grammar, error taxonomy, and both fixtures are frozen in
[`docs/adr/0002-graph-script-dsl.md`](docs/adr/0002-graph-script-dsl.md); the design walkthrough
lives in [`docs/graph-js.md`](docs/graph-js.md). For the imperative tool, see
[Workflow script shape](#workflow-script-shape) above. Graph scripts are never evaluated — the
compiler interprets a restricted AST, so there are no ambient built-ins (`JSON`, `Math`,
`Promise`), and every argument must be a static literal; violations surface as `script_*` errors
with a source location.

Editor IntelliSense for graph scripts:

```js
/// <reference types="pi-dynamic-workflows/workflow-graph" />
```

## How it works

```text
user prompt
  → Pi model writes a workflow script
  → workflow tool parses + runs script in a vm sandbox
  → script calls agent(), parallel(), pipeline()
  → each agent() spawns an in-memory Pi subagent session
  → snapshots stream back as compact progress
  → final structured result returned to the parent assistant
```

Subagents run in fresh in-memory Pi sessions with the standard coding tools, so they can read files, run shell commands, and call structured output exactly like a normal Pi turn.

## Library modules

| File | Purpose |
| --- | --- |
| `src/workflow.ts` | AST-validated parser and sandboxed workflow runtime. |
| `src/workflow-tool.ts` | The Pi `workflow` tool, prompt guidelines, rendering, abort handling. |
| `src/agent.ts` | `WorkflowAgent`, an in-memory Pi subagent runner. |
| `src/structured-output.ts` | Terminating structured-output tool backed by TypeBox/JSON Schema. |
| `src/display.ts` | Workflow snapshots and compact text renderers. |
| `extensions/workflow.ts` | The Pi extension entrypoint. |

## Development

```bash
npm install
npm test     # biome check + tsc + unit tests
npm run dev
```

The graph contract targets the Pi SDK `0.78.x` API surface (the development dependencies
are pinned to `0.78.0`); graph execution must obtain the invoking parent's actual model and
thinking level through its explicit extension adapter. Parser unit tests live in
`tests/workflow-parser.test.ts` and cover both accepted and rejected script shapes.

## Status

This is a prototype. It implements the core workflow primitive (script, subagents, parallel/pipeline, phases, abort, structured output) but does not yet implement persisted or resumable runs, or a `/workflows` manager.

## License

MIT
