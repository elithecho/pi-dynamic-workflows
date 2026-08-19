---
name: pi-workflow
description: Author and invoke multi-agent work through the declarative workflow_graph tool (graph scripts with routing, fan-out, joins, budgets) or the legacy imperative workflow tool.
---

# Pi Workflow

## When to use

Use `workflow_graph` when you are about to spawn multiple sub-agents and want:

- A fixed topology of ≥ 3 agents with declared nodes and edges.
- Conditional routing — regex predicates over a source's final text with an `otherwise` fallback.
- Fan-out plus automatic joins at convergence points.
- Budget enforcement — `budget({ maxConcurrency, ... })`.

Use `workflow` when you need:

- A sequential imperative sequence, or a topology decided at runtime by loops/conditionals.
- Non-DSL surfaces: `phase`, `log`, `args`, `cwd`, or structured output via `opts.schema`.

If unsure, prefer `workflow_graph` — declarative and deterministic.

## DSL quick reference

`workflow_graph` `script` input — a restrictive declarative JS DSL, compiled (never evaluated):

| Global | Signature | Semantics |
| --- | --- | --- |
| `agent` | `agent(prompt, opts?) → Handle` | Declares an agent node. `opts = { role?, model?: { provider, modelId }, thinking? }` — no other keys. Node id = the `const` binding name. |
| `to` | `handle.to(target) → target` | Always edge `handle → target`. |
| `when` | `handle.when(regex, target) → Router` | Predicate edge; fires when the source's final text matches `regex` (string or `/<re>/i`, safe subset ≤ 256 chars). |
| `otherwise` | `router.otherwise(target) → handle` | Fallback edge; fires when no `when` matches. |
| `budget` | `budget({ maxConcurrency?, maxAttempts?, maxInputTokens?, maxOutputTokens?, maxCost? })` | Sets `GraphSpec.budgets`. At most one call. |

Top-level forms:

1. `export const meta = { name, description, id? }` — mandatory **first** statement.
2. `const <id> = agent(prompt, opts?)` — direct declarations only.
3. Edges: `<h>.to(<h>)` or `<h>.when(re, <h>).otherwise(<h>)` — exactly one edge per statement, no chaining.
4. `budget({ ... })` — at most once, anywhere after meta.

**Static-argument rule:** every argument must be a static literal — primitives, plain object
literals, templates without interpolation, or RegExp literals with only the `i` flag (for `when`
only). Calls, member access, identifiers, arrays, spreads, computed keys → `script_non_static_argument`.

**Error codes:** `script_meta_required`, `script_meta_not_literal`, `script_unknown_option`,
`script_non_static_argument`, `script_not_declarative`, `script_unknown_identifier`,
`script_use_before_declaration`, `script_duplicate_budget`. Graph-shape mistakes wrap with the
code preserved: `invalid_regex`, `invalid_model_selector`, `invalid_thinking_level`,
`invalid_graph`.

## Canonical example

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

The predicate/otherwise pair routes `review` → `fixer` on a change verdict, else `review` → `done`.
Two sources into `done` trigger the auto-inserted `done_join`.

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

Three `.to()` edges from `scan` fan out concurrently (bounded by `maxConcurrency`); `report_join`
waits for all three sources and `report` receives `{ facts, risks, dups }`.

## Tool operations

- `start` — pass exactly one of `script`, `definition` (JSON nodes/routes), or `graph` (raw
  GraphSpec). Returns a `runId` **immediately**, NOT blocking on completion.
- `status` / `wait` — observe with the `runId` (`wait` takes optional `timeoutMs`).
- `cancel` — stop with the `runId` (optional reason: `requested` | `parent_aborted` | `timeout` |
  `budget_exhausted`).

Completion surfaces through the `workflow_graph` UI widget — the tool **never** relays a
completion message into your turn (relay-absence). If you need the outcome, poll
`status`/`wait` yourself.

## Failure modes

- `GraphScriptError` carries `code` (`script_*` or a wrapped shape code), a message, optional
  `loc` (`{ line, column }` of the offending statement), and optional `cause`.
- Frozen graph-shape mistakes (bad regex, bad selector, invalid thinking level,
  otherwise-without-when, cycle, duplicate id, id-pattern violation) surface with the underlying
  code preserved (`invalid_regex` etc.), `cause` = the `GraphContractError`, `loc` when
  attributable.
- Do not expect a `sendMessage` from the tool; if you do not poll, you will not hear about the
  outcome.

## Reference

- [`docs/usage.md`](../../docs/usage.md) — the full agent-facing guide.
- [`docs/adr/0002-graph-script-dsl.md`](../../docs/adr/0002-graph-script-dsl.md) — the frozen v1
  grammar, error taxonomy, and acceptance fixtures.
