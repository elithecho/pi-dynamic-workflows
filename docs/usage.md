# How an agent uses the dynamic workflows

This guide is for an **agent** — e.g. the main Pi agent — that needs to invoke one of the two
tools this package registers (`workflow_graph` and `workflow`) to do multi-step work. It is a
distillation: the frozen contract lives in
[`docs/adr/0002-graph-script-dsl.md`](adr/0002-graph-script-dsl.md) and the full design
walkthrough in [`docs/graph-js.md`](graph-js.md). Read those for deeper detail.

## Overview

Pick the tool by the shape of the work. `workflow_graph` is **declarative**: you author a small
graph script — agent nodes, routed edges, budgets — that the tool compiles into a `GraphSpec`
and runs in the background with conditional routing, fan-out, automatic joins, and budget
enforcement. `workflow` is the **legacy imperative** tool: a plain JavaScript script
(`await agent(...)`, `parallel(...)`, `return`) that runs to completion in a sandbox and returns
its result to the calling turn. New work should be authored as `workflow_graph` scripts; a
declared graph is deterministic, verifiable, and self-limiting.

## Decision table

| | `workflow_graph` (declarative) | `workflow` (imperative) |
| --- | --- | --- |
| Authoring | Declares nodes and edges; no control flow in the script | Plain JS: `await`, loops, `parallel(...)`, `pipeline(...)`, `return` |
| Topology | Fixed up front — every edge is declared in the script | Decided at runtime by loops and conditionals |
| Routing | Regex predicates over a source's final text, with an `otherwise` fallback | Explicit program logic |
| Joins | Auto-inserted deterministic join nodes on convergent edges | Manual — you decide what to pass on and what to `return` |
| Budgets | `budget({ maxConcurrency, ... })` enforced by the background runtime | Token tracker: `budget.total / spent() / remaining()` |
| Completion | Background run; surfaced via the UI widget, never relayed | Runs to completion; the result returns to the calling turn |
| Extra surfaces | None — pure AST interpretation, static arguments only | `phase`, `log`, `args`, `cwd`, `opts.schema` structured output |

Use `workflow_graph` when you have ≥ 3 agents in a fixed topology and want predicate routing,
automatic joins, and budget enforcement. Use `workflow` when you need an imperative sequence or a
topology decided at runtime, or access to non-DSL surfaces. When unsure, prefer `workflow_graph` —
declarative is more deterministic.

## workflow_graph — three input shapes

`start` takes exactly one of three mutually-exclusive inputs (`script`, `definition`, `graph`);
providing none or more than one is a tool-input error.

### script — recommended for new graphs

The v1 declarative DSL. `export const meta = { name, description }` is the mandatory first
statement; `const <id> = agent(...)` declares a node whose id is the binding name; edges are
`<handle>.to(<handle>)` or `<handle>.when(regex, <handle>).otherwise(<handle>)`; at most one
`budget(...)`. Canonical example (ADR §6):

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

How it routes: `coder` always feeds `review`. `review`'s outbound edges are a pair — the
predicate `when('<verdict>change</verdict>')` and its `otherwise` fallback. If `review`'s final
text contains the change verdict the predicate edge fires and `fixer` runs on
`review.finalText`; on any other verdict the predicate misses, `fixer` is skipped
(`route_not_selected`), and the otherwise edge fires instead. `done` has two distinct sources
(`review` via otherwise, `fixer` via always), so the compiler auto-inserts a deterministic join
node `done_join`, rewrites both inbound edges onto it, and `done` receives the joined value —
`{ fixer: "<fixer finalText>" }` on the change path, `{ review: "<review finalText>" }` on the
pass path.

### definition — the JSON escape hatch

The same graph as data: `nodes` (with `id`, `prompt`, and optional `role` / `model` /
`thinking`) and `routes` (`{ from, to, when? }` or `{ from, to, otherwise: true }`), compiled by
`compileGraphDefinition`. For programmatic builders that prefer data over JS:

```json
{
  "name": "fix_or_ship",
  "nodes": [
    { "id": "coder", "prompt": "You are a coder agent. Read the coder skill and implement the change.", "role": "implementation" },
    { "id": "review", "prompt": "Review the change. Respond with exactly <verdict>change</verdict> or <verdict>pass</verdict>.", "role": "reviewer" },
    { "id": "fixer", "prompt": "Apply the requested changes.", "role": "implementation" },
    { "id": "done", "prompt": "Finalize and report.", "role": "verifier" }
  ],
  "routes": [
    { "from": "coder", "to": "review" },
    { "from": "review", "to": "fixer", "when": "<verdict>change</verdict>" },
    { "from": "review", "to": "done", "otherwise": true },
    { "from": "fixer", "to": "done" }
  ]
}
```

This compiles to the same graph — including the same `done_join` convergence — as the script
above.

### graph — the raw GraphSpec escape hatch

Pass a complete `GraphSpec` v1 JSON (`version`, `id`, `name`, `nodes`, `edges`, optional
`roles` / `budgets`) validated by `validateGraphSpec` for full-contract control. Use it when you
already hold a serialized spec (for example, round-tripping through a store) and want zero
compilation. It is the most verbose surface and not recommended for agent authorship.

## Tool semantics

- **`start`** compiles/runs the graph and returns a `runId` **immediately** — it does NOT block
  on completion. The graph runs in the background and the main agent stays available for other
  work.
- **`status`** / **`wait`** / **`cancel`** all take the `runId` (plus optional `timeoutMs` for
  `wait` and an optional `reason` — `requested` | `parent_aborted` | `timeout` |
  `budget_exhausted` — for `cancel`).
- Completion surfaces through the `workflow_graph` UI widget (and lifecycle events), **never**
  relayed to the main agent as a follow-up turn.

Two guarantees to rely on: **start-before-completion** — the `start` call returns as soon as the
run is registered, whatever the graph's duration; and **relay-absence** — the tool never sends a
completion message into the main agent's turn. If the agent needs the outcome, it must poll with
`status` / `wait` itself; otherwise the user watches the widget.

Call shapes:

```text
workflow_graph { operation: "start", script: "<v1 DSL source>" }   → runId, state, immediately
workflow_graph { operation: "start", definition: { nodes, routes } }  → runId, state, immediately
workflow_graph { operation: "start", graph: { version: 1, ... } }     → runId, state, immediately
workflow_graph { operation: "status", runId }                         → run state + skipped/failed counts
workflow_graph { operation: "wait", runId, timeoutMs? }               → run state or "still running"
workflow_graph { operation: "cancel", runId, reason? }                → "cancel accepted" or "not accepted"
```

`start` inputs are mutually exclusive — pass exactly one of `script`, `definition`, or `graph`.

## DSL cheat-sheet

Globals (the complete v1 surface):

| Global | Signature | Semantics |
| --- | --- | --- |
| `agent` | `agent(prompt, opts?) → Handle` | Declares an agent node. `opts = { role?, model?: { provider, modelId }, thinking? }` — no other keys (`script_unknown_option`). The node id is the `const` binding name; it is the sole id source. |
| `to` | `handle.to(target) → target` | Always edge `handle → target`. Returns the target (the value documents identity; it is not a new statement form in v1). |
| `when` | `handle.when(regex, target) → Router` | Predicate edge `handle → target`; fires when the source's **final text** matches `regex`. `regex` is a string literal/template (no flags) or a `/<re>/i` RegExp literal (`i` flag only). The pattern must satisfy the frozen safe subset — literal characters plus `\s` / `\s*`, ≤ 256 chars — enforced by the frozen `validateRegex`. |
| `otherwise` | `router.otherwise(target) → handle` | Fallback edge from the same source; fires when no `when` matches. Returns the source handle. |
| `budget` | `budget({ maxConcurrency?, maxAttempts?, maxInputTokens?, maxOutputTokens?, maxCost? })` | Sets `GraphSpec.budgets`. At most one call; no other keys (`script_unknown_option`). |

Top-level forms, in order: `export const meta = { name, description, id? }` first; then `const
<id> = agent(...)` declarations, edge statements (`to` / `when(...).otherwise(...)`), and at most
one `budget(...)` in any order. Exactly one edge per statement — multi-hop chaining and bare
`.when` are rejected.

**Static-argument rule:** every argument to `agent` / `when` / `to` / `budget` (and every nested
value) must be static — primitive literals, object literals with plain static keys, template
literals with no interpolation, and (for `when` only) RegExp literals with flags ⊆ {`i`}. Calls
(`Date.now()`, `Math.random()`), member access, identifiers, arrays, spreads, computed keys,
interpolation, and duplicate keys are all `script_non_static_argument`.

Error codes:

| Code | Fires when |
| --- | --- |
| `script_meta_required` | Program is empty or its first statement is not `export const meta = …`. |
| `script_meta_not_literal` | `meta` initializer is not a static literal of the required shape — missing/empty `name` or `description`, non-string values, or a malformed `id`. |
| `script_unknown_option` | Extra keys in `meta`, agent `opts`, the `model` object, or `budget`. |
| `script_non_static_argument` | Any argument (or nested value) outside the static value language. |
| `script_not_declarative` | A statement that is not an allowed top-level form — imperative code (`await`, `return`, loops), bare `.when`, multi-hop chaining, non-identifier handle args, or an unparseable script. |
| `script_unknown_identifier` | An identifier used as a global or in a handle position that is not `agent`, `budget`, a bound handle, or a handle method (`parallel`, `log`, `JSON`, `Date`). |
| `script_use_before_declaration` | A handle referenced by an edge statement before its `const … = agent(…)` declaration. |
| `script_duplicate_budget` | A second `budget(...)` call. |

Graph-shape mistakes (bad regex subset/length, bad selector, invalid thinking level,
otherwise-without-when, cycle, duplicate id, id-pattern violation) wrap with the underlying
code preserved — `invalid_regex` / `invalid_model_selector` / `invalid_thinking_level` /
`invalid_graph` — plus `cause` = the original `GraphContractError` and `loc` when the compiler
can attribute one.

## Fan-out example

Fan-out is multiple `.to()` edges from one node; targets become ready together and run
concurrently, bounded by `budget({ maxConcurrency })`. Canonical fan-out (ADR §7):

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

Join semantics: `facts`, `risks`, and `dups` all become ready after `scan` succeeds and run
**concurrently**. `report` has three distinct sources, so the compiler auto-inserts a
deterministic `report_join` node; the join waits for all three active sources and `report`
receives `{ facts, risks, dups }` keyed by the active source ids. `maxConcurrency: 3` bounds the
fan-out here; the frozen runtime default is 4 when unset.

## workflow — legacy imperative

The imperative tool takes a plain JS script and runs it to completion in a sandbox. Minimal
shape:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules.',
}

const inventory = await agent('Inspect the repository structure.', { label: 'repo inventory' })
const summary = await agent('Summarize the main modules from this inventory:\n' + inventory, {
  label: 'module summary',
})

return { inventory, summary }
```

`name` and `description` are required meta keys (optional `phases` docs an expected outline);
`phase(...)` calls drive the live progress view at runtime, and `Esc` cancels an active run. It
still works and is the right tool for imperative sequences (`parallel`, `pipeline`,
`opts.schema` structured output, `args`, `cwd`), but it is not the recommended path for new
graphs — prefer `workflow_graph`.

## Picking a budget

`budget({ maxConcurrency, maxAttempts, maxInputTokens, maxOutputTokens, maxCost })` — at most one
call, with no other keys — sets `GraphSpec.budgets`. `maxConcurrency` bounds how many agent nodes
run at once; the frozen runtime default is **4**, so fan-outs of three or four branches need no
explicit setting. Raise it only when you have more parallel branches than workers — each
concurrent node occupies its own subagent session — and prefer a modest value: it is the knob
that most directly controls wall-clock time and resource use. The remaining fields cap retries
per node (`maxAttempts`), per-node input/output tokens, and total spend (`maxCost`); any unset
field falls back to the runtime's default.
