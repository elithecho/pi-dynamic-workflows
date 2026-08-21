---
status: accepted
---

# Graph JS: freeze the v1 declarative script DSL contract

The graph-native workflow mode gains a third authoring surface: a small declarative JavaScript
script (`export const meta` first, then `const <id> = agent(...)`, `.to()`, `.when().otherwise()`,
`budget()`) compiled into the frozen `GraphSpec` and executed by the existing background graph
runtime. This ADR freezes the v1 grammar, the static-argument value language, the safety model,
the `GraphScriptError` taxonomy, the generated-id contract, and the two canonical acceptance
fixtures so Impl-A (id hardening), Impl-B (compiler), and Docs-C (types/README) can implement in
parallel without rediscovering rules. Normative sources: this ADR plus
[`../graph-js.md`](../graph-js.md) (amendment 2). `src/graph.ts` is frozen and untouchable; where
this document is exact, it is exact *because of* `src/graph.ts` and `src/graph-definition.ts`.

## 1. v1 grammar

**Allowed top-level statements, in order of appearance:**

```text
export const meta = { name, description, id? }        // FIRST statement; static object literal
const <id> = agent(<static prompt>, <static opts>?)   // direct declarations only
<handle>.to(<handle>)                                 // always edge
<handle>.when(<static regex>, <handle>).otherwise(<handle>)   // predicate edge + fallback
budget({ ... })                                       // at most once
```

Rules:

- `export const meta = …` is the mandatory first statement of the program (empty program or any
  other first statement → `script_meta_required`). It is the only permitted export.
- After meta, statements may appear in any order (only meta-first is positional); `budget(...)`
  at most once (`script_duplicate_budget` on the second call).
- Edges are collected in **program order**; identity is resolved first (a binding pass), so a
  handle must be declared by its `const … = agent(…)` statement **before** any edge statement
  references it (`script_use_before_declaration`). An identifier in a handle position that is
  never bound anywhere is `script_unknown_identifier`.
- The node id **is** the `const` binding name. No `opts.id` in v1. The binding name must satisfy
  the frozen node-id pattern `[A-Za-z][A-Za-z0-9_-]{0,63}` (max 64 chars, letter-initial);
  violation surfaces as a wrapped graph-shape `invalid_graph` (see §4), with `cause` carrying the
  `GraphContractError` from `compileGraphDefinition`'s id check.
- Each edge statement declares exactly one edge. Multi-hop chaining (`a.to(b).to(c)`) and
  chaining off a `.to()` return value are not allowed top-level forms in v1 → `script_not_declarative`.
- `.when(...)` without `.otherwise(...)` — and `.otherwise(...)` on anything that is not the
  `Router` returned by `.when(...)` — is not an allowed top-level form → `script_not_declarative`.
  The grammar itself enforces predicate/otherwise pairing; the frozen GraphSpec rule
  ("predicate routes require exactly one otherwise") remains as the backstop for `definition` /
  `graph` inputs.

**Globals table (the complete v1 surface):**

| Global | Signature | Semantics |
| --- | --- | --- |
| `agent` | `agent(prompt, opts?) → Handle` | Declares an agent node. `opts = { role?, model?: { provider, modelId }, thinking? }` — no other keys (`script_unknown_option`). The node id is the `const` binding name; it is the sole id source. |
| `to` | `handle.to(target) → target` | Always edge `handle → target`. Returns the target (the value documents identity; it is not a new statement form in v1). |
| `when` | `handle.when(regex, target) → Router` | Predicate edge `handle → target`; fires when the source's **final text** matches `regex`. `regex` is a string literal/template (no flags) or a `/<re>/i` RegExp literal (`i` flag only). The pattern must satisfy the frozen safe subset — literal characters plus `\s` / `\s*`, ≤ 256 chars — enforced by the frozen `validateRegex`. |
| `otherwise` | `router.otherwise(target) → handle` | Fallback edge from the same source; fires when no `when` matches. Returns the source handle. |
| `budget` | `budget({ maxConcurrency?, maxAttempts?, maxInputTokens?, maxOutputTokens?, maxCost? })` | Sets `GraphSpec.budgets`. At most one call; no other keys (`script_unknown_option`). |

**Handle-position rules:** the target arguments of `to` / `when` / `otherwise` and the receiver of
each call must be plain identifiers of previously bound handles. A non-identifier argument
(e.g. `coder.to('review')`) fails the allowed-form check → `script_not_declarative`; an identifier
argument that is unbound → `script_unknown_identifier`; bound later in the program →
`script_use_before_declaration`.

**`meta` contract:**

```text
meta = { name: string (required, non-empty), description: string (required, non-empty), id?: string }
```

- `name` → `GraphSpec.name`, and is slugified into the graph id when `meta.id` is absent, using
  the existing frozen `deriveGraphId` algorithm (lowercase; `[^a-z0-9_-]` → `-`; collapse runs;
  trim leading/trailing `-`; if the result is empty or not letter-initial, prefix `s`).
- `meta.id` (optional) overrides the graph id and must match `[A-Za-z][A-Za-z0-9_-]{0,63}`;
  otherwise → `script_meta_not_literal`.
- `description` is **documentation-only** tool-facing compile metadata (the frozen `GraphSpec` has
  no description field); required mirroring legacy `workflow`, never carried into the graph.
- Extra keys in `meta` → `script_unknown_option`.

**Explicitly out of v1** (rejected, each with a `script_*` code + `loc`): nested `agent(...)`
inside `to()`; aliases (`const f = coder` → not an allowed declaration form); `log()`; `args`;
`cwd`; ambient built-ins — no `JSON` / `Math` / `Array` / `Promise` / constructors exist in the
interpreter, any reference is `script_unknown_identifier`; `await`; `return`; loops; functions;
assignments; updates; imports; classes; computed member access on handles. Additionally rejected
by the allowlist: multi-hop `to` chaining (above), array literals / spreads / computed keys
anywhere in arguments (§2), any non-meta export, and any statement kind not listed above.

## 2. Static-argument grammar

Every argument to `agent` / `when` / `to` / `budget` (and every nested value inside them) must be
**static**. The accepted AST value language is exactly:

- **Primitive literals:** string literals (`'…'`, `"…"`), number literals (finite decimal /
  integer forms), `true`, `false`, `null`.
- **Object literals** whose keys are static (plain identifier keys or string-literal keys — no
  computed keys, no duplicates) and whose values are recursively static per this list.
- **Template literals with no interpolation** (quasis only; any `${…}` is rejected).
- **RegExp literals, for `when` only**, with flags ⊆ {`i`} (`/<re>/`, `/<re>/i`). Any other flag
  (`g`, `m`, `s`, `y`, …) is rejected. The pattern must additionally satisfy the frozen safe
  regex subset of §1.

Rejected (each → `script_non_static_argument` at the offending node, with `loc`): any
`CallExpression` or member access inside an argument (`Date.now()`, `Math.random()`, `x.y`),
identifiers (including `undefined`, `NaN`, `Infinity`), array literals, computed keys
(`{[k]: v}`), spreads (`{...x}`, `[...x]`), template interpolation, duplicate object keys,
RegExp literals with unsupported flags or used outside `when`, and any unary / binary / logical /
conditional / arrow / `new` expression (`-1`, `'a' + 'b'`, `!0`). This one rule rejects
`Date.now()`, `Math.random()`, constructor chains, computed keys, spreads, and template
smuggling in a single stroke — the compiled graph is byte-identical across compiles.

Positional typing on top of the value language: `agent`'s prompt is a static string; `opts` is a
static object with keys ⊆ {`role`, `model`, `thinking`} (`role`: non-empty string; `model`:
static `{ provider, modelId }` of non-empty strings; `thinking`: string — invalid level values
surface as wrapped graph-shape errors, see §4); `when`'s regex is a static string or RegExp
literal; `budget`'s argument is a static object with the five keys of §1.

## 3. Safety model

- The compiler parses with acorn and **interprets the restricted AST directly** against its own
  literal evaluator and compiler-owned opaque handles. There is no `node:vm` context and no
  ambient globals (`JSON` / `Math` / `Array` / `Promise` / constructors do not exist). User code
  is never evaluated; only literal data is produced.
- Constructor-chain and network escapes are **rejected by grammar**, not "made safe by a frozen
  context" — there is nothing to escape to. The allowlist AST pass (§1) is the enforcement point;
  imperative legacy `workflow` scripts (`await agent(...)`, `parallel(...)`) fail there with
  `script_not_declarative` deterministically, never by relying on parse failure.
- Regex safety is inherited unchanged from the frozen `validateRegex` / `matchesFinalText`
  safe-subset matcher (literal chars + `\s` / `\s*`, ≤ 256 chars, `i` flag only, unanchored
  substring match over the source's finalText); the script compiler never widens it.

## 4. `GraphScriptError` taxonomy

```ts
class GraphScriptError extends Error {
  readonly code: GraphScriptErrorCode | GraphErrorCode; // script_* codes, or the wrapped shape code
  readonly message: string;
  readonly loc?: { line: number; column: number }; // acorn position; line 1-based, column 0-based
  readonly cause?: unknown;                          // wrapped inner error when present
}
```

**Script-authoring codes** (outside the frozen `GraphErrorCode` union):

| Code | Fires when |
| --- | --- |
| `script_meta_required` | The program is empty or its first statement is not `export const meta = …`. |
| `script_meta_not_literal` | The `meta` initializer is not a static object literal of the required shape: missing/empty/mistyped `name` or `description`, non-string values, or an `id` that fails the id pattern. |
| `script_unknown_option` | Extra keys in `meta`, agent `opts`, the `model` object, or `budget`. |
| `script_non_static_argument` | Any argument (or nested value) outside the §2 value language, including calls, member access, identifiers, arrays, computed keys, spreads, interpolation, duplicate object keys, and unsupported RegExp flags. |
| `script_not_declarative` | A statement that is not one of the §1 allowed forms: `await` / `return` / loops / functions / assignments / updates / imports / classes / non-meta exports / bare `.when` without `.otherwise` / `.otherwise` on a non-router / multi-hop chaining / non-agent `const` initializers / non-identifier handle arguments. Also the wrapper for an unparseable script (acorn `SyntaxError` attached as `cause`, `loc` from acorn). |
| `script_unknown_identifier` | An identifier used as a global or in a handle position that is not `agent`, `budget`, a bound handle, or a handle method (`to` / `when` / `otherwise`) — e.g. `parallel(...)`, `log(...)`, `JSON`, `Date` — or a handle-position identifier never bound anywhere. |
| `script_use_before_declaration` | A handle identifier referenced by an edge statement before its `const … = agent(…)` declaration in program order. |
| `script_duplicate_budget` | A second `budget(...)` call. |

**Graph-shape mistakes** (bad regex subset/length, bad selector, invalid thinking level,
otherwise-without-when, cycle, duplicate id, id-pattern violations on binding names) are detected
by `compileGraphDefinition` / `validateGraphSpec` on the assembled definition. The script compiler
catches the `GraphContractError` and rethrows it as a `GraphScriptError` that **preserves the
underlying code** (`invalid_regex` / `invalid_model_selector` / `invalid_thinking_level` /
`invalid_graph`) and message, with `cause` = the original `GraphContractError` and `loc` pointing
at the offending script statement when the compiler can attribute one (otherwise omitted).
`src/graph.ts` is never modified; the eight `script_*` codes remain distinct from the frozen
`GraphErrorCode` union.

**Resolution order (deterministic):** parse → meta check → binding pass (identity) → allowlist +
static-argument pass per statement in program order → definition assembly →
`compileGraphDefinition` (shape errors wrap per above). The first violation wins.

## 5. Generated-id contract

The DSL delegates to `compileGraphDefinition`; Integration-2 hardens its generated ids to be
deterministic, bounded, and collision-safe (`src/graph.ts` untouched):

- **Edge ids:** `from_to_to` when it matches the id pattern `[A-Za-z][A-Za-z0-9_-]{0,63}`
  (≤ 64 chars) and is unused, else a bounded `edge_{n}` counter.
- **Join ids:** `target_join` when valid and unused, else `join_{n}`.
- **Collision-safe:** generated ids — especially join **node** ids, which share the node-id
  namespace — are checked against the full existing id set (user node ids + previously generated
  ids, node and edge namespaces each unique among themselves) with a deterministic `_k` suffix or
  counter fallback.
- **Deterministic + idempotent:** the same input always yields the same ids; compiling the same
  script twice yields a byte-identical serialized `GraphSpec`.
- **Short-id behavior preserved:** existing readable ids (`a_to_b`, `final_verification_join`)
  are unchanged; only boundary cases change.
- Boundary/collision test cases are named by the plan: 64-char node ids; an author node named
  `done_join`; an author node named `edge_1`.

**Graph id:** from `meta.id` when present; else the `meta.name` slug per the frozen
`deriveGraphId` algorithm (§1). For the fixtures: `fix_or_ship` and `audit`.

**Emission shape and ordering (frozen for byte-identity):**

- An **always edge carries no `route` key at all** (`{ id, from, to }`); `route: { kind: "always" }`
  is valid `GraphEdge` but is never emitted by this compiler path. `predicate` routes carry
  `{ kind: "predicate", predicate: { type: "finalText", regex: { source: "finalText", pattern, flags? } } }`
  with `flags` present iff `i` was requested; `otherwise` routes carry `{ kind: "otherwise" }`.
- Nodes are emitted as agent nodes in declaration order, then deterministic join nodes in target
  declaration order. Edges are emitted as route edges in program order (retargeted onto the join
  where convergent), then the `join → target` edges in target declaration order.
- Object key order matches `compileGraphDefinition`'s construction: spec
  `version, id, name, nodes, edges, roles?, budgets?`; agent node
  `kind, id, prompt, role?, model?, thinking?, inputArtifacts?`; join node `kind, id, operation`;
  edge `id, from, to, route?`. A `role` opt compiles to **both** `node.role` and an entry
  `roles[role] = {}` (first-seen declaration order), because the frozen contract requires every
  referenced role to be declared in `graph.roles`. `roles` and `budgets` keys are omitted
  entirely when empty/absent.

## 6. Canonical acceptance fixture — `fix_or_ship` (THE shared acceptance example)

Script (verbatim from `docs/graph-js.md`):

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

Complete expected compiled `GraphSpec` (exact JSON; `description` is documentation-only and
dropped; `done`'s two distinct sources — `review` via otherwise, `fixer` via always — are
rewritten onto the auto-inserted `done_join`, which then feeds `done`):

```json
{
  "version": 1,
  "id": "fix_or_ship",
  "name": "fix_or_ship",
  "nodes": [
    {
      "kind": "agent",
      "id": "coder",
      "prompt": "You are a coder agent. Read the coder skill and implement the change.",
      "role": "implementation"
    },
    {
      "kind": "agent",
      "id": "review",
      "prompt": "Review the change. Respond with exactly <verdict>change</verdict> or <verdict>pass</verdict>.",
      "role": "reviewer",
      "inputArtifacts": [{ "nodeId": "coder", "output": "finalText" }]
    },
    {
      "kind": "agent",
      "id": "fixer",
      "prompt": "Apply the requested changes.",
      "role": "implementation",
      "inputArtifacts": [{ "nodeId": "review", "output": "finalText" }]
    },
    {
      "kind": "agent",
      "id": "done",
      "prompt": "Finalize and report.",
      "role": "verifier",
      "inputArtifacts": [{ "nodeId": "done_join", "output": "value" }]
    },
    { "kind": "deterministic", "id": "done_join", "operation": "join" }
  ],
  "edges": [
    { "id": "coder_to_review", "from": "coder", "to": "review" },
    {
      "id": "review_to_fixer",
      "from": "review",
      "to": "fixer",
      "route": {
        "kind": "predicate",
        "predicate": {
          "type": "finalText",
          "regex": { "source": "finalText", "pattern": "<verdict>change</verdict>" }
        }
      }
    },
    { "id": "review_to_done_join", "from": "review", "to": "done_join", "route": { "kind": "otherwise" } },
    { "id": "fixer_to_done_join", "from": "fixer", "to": "done_join" },
    { "id": "done_join_to_done", "from": "done_join", "to": "done" }
  ],
  "roles": { "implementation": {}, "reviewer": {}, "verifier": {} }
}
```

Notes pinned by this fixture: the predicate regex carries **no `flags`** (plain string `when`,
no `i` requested); `fixer` has a single source so its input is the inferred
`review.finalText`; `coder` has no inbound sources so it carries no `inputArtifacts` key; all ids
(`coder_to_review`, `review_to_fixer`, `review_to_done_join`, `fixer_to_done_join`,
`done_join_to_done`, `done_join`) are ≤ 64 chars, letter-initial, and collision-free, so the
readable forms of §5 apply; the `review` source pairs exactly one predicate edge with exactly one
otherwise edge and no always edge, satisfying the frozen route rules.

**Runtime outcomes (frozen):**

- **change path** — `review`'s finalText contains `<verdict>change</verdict>` → predicate edge
  `review_to_fixer` selected (otherwise edge inactive) → `fixer` runs on `review.finalText`,
  succeeds → `fixer_to_done_join` active → `done_join` satisfied → `done` runs and receives
  `{ fixer: "<fixer finalText>" }`.
- **pass path** — `review` emits `<verdict>pass</verdict>` (unanchored, case-sensitive here; no
  match on the change pattern) → `review_to_fixer` not selected → `fixer` skipped with
  `skipReason: "route_not_selected"` → otherwise edge `review_to_done_join` fires → `done_join`
  satisfied via `review` → `done` receives `{ review: "<review finalText>" }`.

This one fixture is the shared acceptance example for the compiler tests, the scenario tests, and
the docs; those surfaces cannot drift from it.

## 7. Fan-out acceptance fixture — `audit`

Script (verbatim from `docs/graph-js.md`):

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

Complete expected compiled `GraphSpec` (exact JSON; no `roles` key — no role opts — and
`budgets` from the single `budget()` call):

```json
{
  "version": 1,
  "id": "audit",
  "name": "audit",
  "nodes": [
    { "kind": "agent", "id": "scan", "prompt": "Inventory the repo." },
    {
      "kind": "agent",
      "id": "facts",
      "prompt": "Collect facts about structure.",
      "inputArtifacts": [{ "nodeId": "scan", "output": "finalText" }]
    },
    {
      "kind": "agent",
      "id": "risks",
      "prompt": "Collect risks about security.",
      "inputArtifacts": [{ "nodeId": "scan", "output": "finalText" }]
    },
    {
      "kind": "agent",
      "id": "dups",
      "prompt": "Find duplicated responsibility.",
      "inputArtifacts": [{ "nodeId": "scan", "output": "finalText" }]
    },
    {
      "kind": "agent",
      "id": "report",
      "prompt": "Synthesize the three analyses.",
      "inputArtifacts": [{ "nodeId": "report_join", "output": "value" }]
    },
    { "kind": "deterministic", "id": "report_join", "operation": "join" }
  ],
  "edges": [
    { "id": "scan_to_facts", "from": "scan", "to": "facts" },
    { "id": "scan_to_risks", "from": "scan", "to": "risks" },
    { "id": "scan_to_dups", "from": "scan", "to": "dups" },
    { "id": "facts_to_report_join", "from": "facts", "to": "report_join" },
    { "id": "risks_to_report_join", "from": "risks", "to": "report_join" },
    { "id": "dups_to_report_join", "from": "dups", "to": "report_join" },
    { "id": "report_join_to_report", "from": "report_join", "to": "report" }
  ],
  "budgets": { "maxConcurrency": 3 }
}
```

Runtime note (frozen): `facts`, `risks`, and `dups` all become ready after `scan` succeeds and
run **concurrently**, bounded by `maxConcurrency: 3` here (the frozen runtime default is 4 when
unset). `report` has three distinct sources, so `report_join` is auto-inserted, waits for all
three, and `report` receives `{ facts, risks, dups }` keyed by the active source ids.
Concurrency admission, retries, budget stops, and cancellation remain exclusively the frozen
runtime's job.

## 8. Tool surface

`workflow_graph` start inputs become **mutually exclusive** `graph` | `definition` | `script` —
exactly one must be provided; providing none or more than one is a tool-input error.

- `script` — the leading surface: a v1 DSL script compiled by `compileGraphScript` into a frozen
  `GraphSpec` and started in the background (`start` returns a `runId` immediately;
  `status` / `wait` / `cancel` manage the run; completion is surfaced via the UI widget and
  lifecycle events, then wakes the parent once with terminal state and the successful final answer
  from every topology sink; intermediate artifacts are never relayed through a main-agent turn).
- `definition` — the JSON `nodes`/`routes` escape hatch compiled by `compileGraphDefinition`,
  for programmatic graph builders that prefer data over JS.
- `graph` — the raw frozen `GraphSpec` escape hatch, validated by `validateGraphSpec` for
  full-contract control.

Tool guidance leads with `script`, keeps `definition` and `graph` as escape hatches, and
explicitly contrasts the declarative `workflow_graph` with the imperative legacy `workflow` tool.

## 9. Handoff

This ADR together with [`../graph-js.md`](../graph-js.md) (amendment 2) is the **contract
source** for Integration-2:

- **Impl-A** (harden generated ids in `src/graph-definition.ts`) consumes §5.
- **Impl-B** (`compileGraphScript` in `src/graph-script.ts`) consumes §1–§4 and must reproduce
  the §6/§7 fixtures byte-for-byte.
- **Docs-C** (`types/workflow-graph.d.ts`, `package.json`, `README.md`) consumes §1 and the
  globals table.
- Tool-D and Scenario-E consume the §6/§7 fixtures as their acceptance examples.

The fixtures in §6 and §7 are **frozen**: a deviation from them is a defect, not a
reinterpretation. Any change to grammar, taxonomy, ids, or fixtures requires a new ADR
superseding this one.

## 10. Contract clarifications

The plan (`docs/graph-js.md`, amendment 2) and the frozen `src/graph.ts` contain no
contradiction that forces a fixture change — both fixtures above compile and validate under the
frozen contract (hand-checked node/edge ids against `[A-Za-z][A-Za-z0-9_-]{0,63}`, predicate/
otherwise pairing, acyclicity, and artifact-ancestor rules). The following points were
underspecified or ambiguous in the plan and are pinned here so the three executors cannot
diverge:

1. **Always edges omit `route`.** The plan's compiled-graph sketch labels edges "(always)", but
   `compileGraphDefinition` emits `{ id, from, to }` with no `route` key for always edges. The
   fixtures pin the omission (an explicit `route: { kind: "always" }` is valid `GraphEdge` but
   never emitted on this path).
2. **`role` compiles to node field + `graph.roles` entry.** The plan's DSL table does not mention
   that a `role` opt produces both `node.role` and `roles[role] = {}` (empty defaults). This is
   forced by the frozen rule that every referenced role must be declared in `graph.roles`; the
   canonical fixture pins it, including first-seen key order.
3. **Wrapper code for graph-shape errors.** The plan says shape errors surface "with `cause` =
   the `GraphContractError`" but does not name the wrapper's `code`. Frozen: the rethrown
   `GraphScriptError` preserves the underlying code (`invalid_regex` / `invalid_model_selector` /
   `invalid_thinking_level` / `invalid_graph`) and message. The plan names three codes;
   `invalid_thinking_level` is additionally reachable via an invalid `opts.thinking` string
   through `validateDefaults`.
4. **Unparseable scripts.** The plan assigns no code to acorn parse failures. Frozen:
   `script_not_declarative` with `loc` from the `SyntaxError` and `cause` = the `SyntaxError`
   (distinct from the allowlist path, which fires on parseable-but-imperative code).
5. **Bare `.when` and multi-hop chaining.** "Returns the target so chaining reads naturally"
   could be read as permitting `a.to(b).to(c)` or a bare `.when(...)` statement. Frozen: each
   statement declares exactly one edge and `.when` must be immediately chained with
   `.otherwise`; both violations are `script_not_declarative`. Consequently
   otherwise-without-when is impossible to express from a script (the graph-shape rule remains
   the backstop for `definition`/`graph` inputs).
6. **Budget position.** "Allowed top-level forms, in order" is frozen as: only `meta` is
   positionally constrained (first); `budget(...)` may appear anywhere after meta, at most once.
7. **Code assignments the plan left unnamed:** duplicate object keys, array literals, and
   unsupported RegExp flags → `script_non_static_argument` (§2 value-language violations);
   missing/empty/mistyped `meta.name`/`description` or malformed `meta.id` →
   `script_meta_not_literal`; non-identifier handle arguments → `script_not_declarative`;
   never-bound handle-position identifiers → `script_unknown_identifier`; invalid binding names
   (id-pattern violation) → wrapped `invalid_graph`.
8. **Ordering and byte-identity.** Node/edge ordering and object key order are frozen as emitted
   by `compileGraphDefinition` (§5) so that the idempotence requirement — two compiles of the
   same script yield byte-identical serialized `GraphSpec` — is testable by exact string/JSON
   comparison.
