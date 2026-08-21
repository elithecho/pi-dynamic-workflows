# Graph JS — declarative script authoring for graph-native workflows

> **Historical planning document:** superseded for current product scope by [ADR 0003](adr/0003-remove-legacy-imperative-workflow.md). Legacy comparisons and migration assumptions below describe the original design history; current authoring uses `workflow_graph` exclusively.
>
> **Status: plan — amendment 2, ready for staged execution.** This supersedes the first draft
> and resolves the solo-review critique (below). It adopts a deliberately **small v1 grammar**,
> fixes the examples, and adds the staged-workflow handoff. Implementation lands as
> Integration-2 and records `docs/adr/0002-graph-script-dsl.md` at merge time.

## Goal

Let the main Pi agent author a graph-native workflow the way it authors the legacy `workflow`
tool — a small JavaScript script (`export const meta` first, then natural JS) — except the
script is **declarative**: it declares agent nodes and regex-routed edges. A compiler turns
the script into the frozen `GraphSpec`, and the **existing** background graph runtime executes
it (start returns a `runId` immediately; `status`/`wait`/`cancel` manage it). No new runtime,
no sandboxed agent spawning, no main-agent relay of intermediate results.

This is the JS-shaped authoring mirror of the JSON `definition` surface
(`compileGraphDefinition`) and the raw `graph` (GraphSpec) escape hatch. All three compile to
the same frozen contract.

## v1 DSL (adopted after review)

The smallest grammar that still expresses linear chains, fan-out, conditional routes, and
convergence — while keeping identity, safety, diagnostics, and idempotence straightforward.

**Allowed top-level forms, in order:**

```text
export const meta = { name, description, id? }        // first statement, literal value
const <id> = agent(<static prompt>, <static opts>?)   // direct declarations only
<handle>.to(<handle>)                                 // always edge
<handle>.when(<static regex>, <handle>).otherwise(<handle>)   // predicate edge + fallback
budget({ ... })                                       // at most once
```

**Globals:**

| Global | Signature | Semantics |
| --- | --- | --- |
| `agent` | `agent(prompt, opts?) → Handle` | Declares an agent node. `opts = { role?, model?: { provider, modelId }, thinking? }`. The **node id is the `const` binding name** (`coder`, `review`, …). No `opts.id` in v1 — the binding name is the sole id source (removes a whole class of ambiguity). |
| `to` | `handle.to(target) → target` | Always edge `handle → target`. Returns the target so chaining reads naturally. |
| `when` | `handle.when(regex, target) → Router` | Predicate edge `handle → target`; fires when the source's **final text** matches `regex`. `regex` is a string or `/<re>/i` literal; `i` flag only; frozen safe subset only (literal chars + `\s`/`\s*`, ≤256 chars). |
| `otherwise` | `router.otherwise(target) → handle` | Fallback edge from the same source; fires when no `when` matches. Returns the source handle. |
| `budget` | `budget({ maxConcurrency?, maxAttempts?, maxInputTokens?, maxOutputTokens?, maxCost? })` | Sets `GraphSpec.budgets`. At most one call. |

**Explicitly out of v1:** nested `agent(...)` inside `to()`, aliases, `log()`, `args`, `cwd`,
ambient built-ins (no `JSON`/`Math`/`Promise`/constructors in the interpreter; see Safety),
`await`, `return`, loops, functions, assignments, updates, imports.

## Canonical example — `coder → review → fix or done` with the join

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

**Compiled graph (this is the join the example demonstrates):**

```text
nodes:  coder, review, fixer, done, done_join
edges:
  coder → review                                  (always)
  review → fixer                                  (predicate: <verdict>change</verdict>)
  review → done_join                              (otherwise)
  fixer → done_join                               (always)
  done_join → done                                (always)
done.inputArtifacts = [{ nodeId: "done_join", output: "value" }]
```

`done` has two distinct sources (`review` via otherwise, `fixer` via always), so the compiler
auto-inserts a deterministic `join` node (`done_join`) and rewrites both inbound edges onto it.
`done` then receives `done_join.value`:

- **change path** — `review` emits `<verdict>change</verdict>` → `review → fixer` selected →
  `fixer` runs → `fixer → done_join` active → `done` receives `{ fixer: "<finalText>" }`.
- **pass path** — `review` emits `<verdict>pass</verdict>` → `review → fixer` not selected →
  `fixer` skipped `route_not_selected` → `review → done_join` (otherwise) active → `done`
  receives `{ review: "<verdict>pass</verdict>" }`.

`fixer` itself receives `review.finalText` directly (single source → inferred input). This one
fixture is the shared acceptance example used by the compiler tests, the scenario tests, and
the docs, so those surfaces cannot drift.

## Fan-out + synthesis (parallelism)

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

`facts`, `risks`, `dups` all become ready after `scan` and run **concurrently**, bounded by
`maxConcurrency` (default 4 from the frozen runtime). `report` has three distinct sources, so
`report_join` is auto-inserted and `report` receives `{ facts, risks, dups }` keyed by the
active source ids. Concurrency admission, retries, budget stops, and cancellation remain
exclusively the frozen runtime's job.

## Grammar enforcement (allowlist AST pass, not parse failure)

The compiler parses with acorn, then applies an explicit allowlist over the body AST:

- First statement must be `export const meta = { … }`.
- Remaining statements must each be: a `const <Identifier> = agent(...)` declaration, a
  `handle.to(handle)` expression, a `handle.when(re, handle).otherwise(handle)` expression, or
  one `budget(...)` call.
- Rejected by name/kind (each with a `script_*` code + `loc`): `AwaitExpression`, `ReturnStatement`,
  loops, function declarations/expressions, assignment/update expressions, `Import`/`Require`,
  class expressions, computed member access on handles, and any unknown global identifier.
- Referenced handles must be previously bound (`script_use_before_declaration` otherwise).
  Identity is resolved first (a bind pass), then edges are collected in program order.

Imperative legacy `workflow` scripts (`await agent(...)`, `parallel(...)`) fail here with
`script_not_declarative` and a pointer to the legacy `workflow` tool — deterministically, not
by relying on parse failure.

## Static-argument grammar (determinism)

Every argument to `agent` / `when` / `to` / `budget` must be **static**: a primitive literal, an
object literal whose keys and values are all static, a template string **without interpolation**,
or a RegExp literal (for `when`). Any `CallExpression` or member access inside an argument is
`script_non_static_argument`. This single rule rejects `Date.now()`, `Math.random()`, constructor
chains, computed keys, spreads, and template smuggling in one stroke — the graph is therefore
byte-identical across compiles.

## Safety model (pure AST interpreter — no vm, no ambient sandbox)

The compiler **interprets** the restricted AST directly against its own literal evaluator and
compiler-owned opaque handles. There is no `node:vm` context and no ambient globals
(`JSON`/`Math`/`Array`/`Promise`/constructors). User code is never evaluated; only literal data
is produced. Constructor-chain and network escapes are *rejected by grammar*, not "made safe by
a frozen context" — there is nothing to escape.

Regex safety is inherited unchanged from the frozen `validateRegex`/`matchesFinalText`
safe-subset matcher; the compiler never widens it.

## Error taxonomy + diagnostics

- **Script-authoring mistakes** → `GraphScriptError { code, message, loc?, cause? }`, codes
  **outside** the frozen `GraphErrorCode` union: `script_meta_required`, `script_meta_not_literal`,
  `script_unknown_option`, `script_non_static_argument`, `script_not_declarative`,
  `script_unknown_identifier`, `script_use_before_declaration`, `script_duplicate_budget`.
  `loc` is the acorn position; `cause` carries a wrapped inner error when present.
- **Graph-shape mistakes** (bad regex, selector, otherwise-without-when, cycle, duplicate id) →
  existing `invalid_regex` / `invalid_model_selector` / `invalid_graph` via
  `compileGraphDefinition`, surfaced with `cause` = the `GraphContractError`. `src/graph.ts` is
  never modified.

Unknown keys policy (deterministic rejection, not silent acceptance): extra keys in `meta`,
agent `opts`, `model`, and `budget` are `script_unknown_option`; duplicate object keys, aliases,
and multiple `budget()` calls are rejected.

## `meta` contract

```text
meta = { name: string (required), description: string (required), id?: string }
```

- `name` → `GraphSpec.name`, and slugified into the graph id when `meta.id` is absent.
- `meta.id` (optional) overrides the graph id; must match `[A-Za-z][A-Za-z0-9_-]{0,63}`.
- `description` is **documentation-only** (tool-facing compile metadata; `GraphSpec` has no
  description field). It is required mirroring legacy `workflow`, but it is not carried into the
  frozen graph.

## Generated-id contract (requires hardening `src/graph-definition.ts`)

The DSL delegates to `compileGraphDefinition`, whose generated edge/join ids are today **not**
closed over valid 64-char node ids (a `from_to_to` edge id can exceed 64 chars, `<target>_join`
can exceed 64 chars, and `node_N`/join ids can collide with user ids). Integration-2 therefore
hardens `src/graph-definition.ts`:

- **Edge ids:** `from_to_to` when valid (≤64, matches id pattern) and unused, else a bounded
  `edge_{n}` counter.
- **Join ids:** `target_join` when valid and unused, else `join_{n}`.
- **Collision-safe:** generated ids (especially join **node** ids, which share the node-id
  namespace) are checked against the full existing id set — user node ids + previously generated
  ids — with a deterministic `_k` suffix or counter fallback.
- Deterministic and idempotent; boundary + collision tests added (64-char node ids; author node
  named `done_join`; author node named `edge_1`).

Short-id behavior is preserved, so existing Stage-2 tests (`a_to_b`, `final_verification_join`)
stay green; only boundary cases change.

## Module layout & edits

New:

| File | Purpose |
| --- | --- |
| `src/graph-script.ts` | `compileGraphScript(script): GraphSpec` — meta parse, static-argument guard, binding table, allowlist AST pass, `GraphDefinition` assembly, then `compileGraphDefinition`. Exports `GraphScriptError`. |
| `tests/graph-script.test.ts` | Parser/compiler unit tests (grammar matrix, guard-bypass matrix, idempotence, canonical fixture). |
| `tests/graph-script-scenario.test.ts` | End-to-end: script → `runGraph` with fake executor (pass/change routing, fan-out concurrency, join, terminal-only completion relay). |
| `types/workflow-graph.d.ts` | Editor IntelliSense for `agent`/`to`/`when`/`otherwise`/`budget`. |
| `docs/adr/0002-graph-script-dsl.md` | ADR recording the v1 grammar, collector-vs-return, static-argument, error-taxonomy, and generated-id decisions. |

Edited (graph runtime files remain scoped to this graph feature):

| File | Change |
| --- | --- |
| `src/graph-definition.ts` | Harden generated ids (see Generated-id contract). |
| `tests/graph-definition.test.ts` | Boundary + collision tests. |
| `src/graph-tool.ts` | Add `script` param + `prepareArguments` three-way mutual exclusion + prompt/guidelines teach the DSL. |
| `tests/graph-tool.test.ts` | Flip the current "rejects script" assertion to acceptance; add graph/definition/script mutual exclusion. |
| `src/index.ts` | Export `compileGraphScript` + `GraphScriptError`. |
| `package.json` | Add `"./workflow-graph"` types subpath export. |
| `README.md` | Document the new surface; contrast declarative `workflow_graph` vs imperative `workflow`. |

Out of scope for the graph feature: `src/workflow.ts`, `src/workflow-tool.ts`, `src/agent.ts`,
`src/display.ts`, `src/structured-output.ts`, `src/graph.ts`, `src/graph-runtime.ts`,
`src/graph-agent.ts`, `src/graph-registry.ts`, `src/graph-display.ts`, `src/staged-workflow.ts`.
These files are not immutable; later targeted repairs may update the legacy workflow surfaces.

> Note: the earlier "shared `src/script-ast.ts` extraction from `workflow.ts`" idea is dropped.
> `graph-script.ts` owns a small self-contained literal evaluator; the imperative workflow runtime
> remains off the graph critical path.

## Tool surface

`workflow_graph` start inputs become mutually exclusive `graph` | `definition` | `script`:

```text
workflow_graph { operation: "start", script: "<js above>" }
  → runId immediately; status/wait/cancel by runId; terminal completion wakes the parent with the final answer
```

Tool guidance leads with `script`, keeps `definition` (JSON) and `graph` (raw GraphSpec) as
escape hatches, and explicitly contrasts with the legacy imperative `workflow` tool.

## Solo review critique — resolution map

| # | Blocking finding | Resolution (this amendment) |
| --- | --- | --- |
| 1 | Examples didn't express the claimed workflow | Canonical example rewritten: `coder.to(review)`; `review.when(change,fixer).otherwise(done)`; `fixer.to(done)`; join walkthrough shown. Fan-out example links all three into `report`. |
| 2 | Binding-derived ids underspecified / conflict with chaining | v1 grammar forbids nested `agent()`; id = the `const` binding name, always. No `opts.id`. |
| 3 | Static-argument rule rejected its own examples | Explicit accepted AST grammar; static value language enumerates literals/objects/templates/RegExp; `to` covered. |
| 4 | "No await" can't rely on parse failure | Allowlist AST pass rejects AwaitExpression/loops/functions/assignments/updates/imports by kind. |
| 5 | Generated ids unbounded/collision-prone | `graph-definition.ts` added to edit list with the Generated-id contract + boundary/collision tests. |
| 6 | Safety model described a sandbox that shouldn't exist | Pure AST interpreter, no vm, no ambient built-ins; escape vectors rejected by grammar. |

Design gaps resolved: `meta.description` documented as tool-facing metadata; `meta.id` supported;
`GraphScriptError` carries `loc` + `cause`; `log()` dropped from v1; unknown-key/duplicate policy
is explicit rejection; no shared extraction from the imperative workflow runtime; canonical fixture is the single
shared acceptance example; regression gate reworded to named frozen artifacts + idempotence.

---

# Staged implementation plan (Integration-2)

## Minimum shippable scope

- `compileGraphScript(script): GraphSpec` implementing the v1 grammar + static-argument guard +
  `GraphScriptError` (+ `loc`/`cause`).
- Hardened deterministic/bounded/collision-safe generated ids in `compileGraphDefinition`.
- `workflow_graph {operation:"start", script}` with three-way mutual exclusion and guidance that
  teaches the DSL.
- The canonical `coder→review→(fix|done)` and fan-out+join fixtures proven end-to-end through the
  frozen runtime.
- Frozen graph runtime contracts remain compatible; legacy workflow behavior is covered separately by its own regression tests.

## Deferred surfaces (non-blocking)

- `publish()`/`phase()` sugar; a `fanout(...)` shorthand; nested `agent()` in `to()`; aliases; `log()`.
- Per-node skill/instructions injection beyond literal prompt text.
- JSON-predicate routes (`whenJson`), richer regex flags.
- Registry artifact eviction for long-lived sessions.
- Editor IntelliSense (`types/workflow-graph.d.ts`) is a Wave-1 nicety but may be deferred if budget tightens.

## Agent budget and stop condition

- Target **8 agents**: contract owner, id-hardening executor, compiler executor, docs/types
  executor, tool executor, scenario executor, persistent reviewer, final verifier. Hard stop **10**
  (≤2 repair executors).
- Stop and ask if: the v1 grammar cannot express chain + fan-out + conditional + convergence via
  the existing compiler; hardening ids requires touching frozen `graph.ts`; safe regex needs an
  unapproved dependency; a valid boundary input (64-char ids) cannot be made safe without changing
  the frozen id pattern.

## Executor work items

- [ ] **Contract-1: Freeze the v1 grammar + acceptance fixtures**
  - Files: `docs/adr/0002-graph-script-dsl.md` (draft), this doc's canonical fixtures.
  - Depends on: none.
  - Must not touch: `src/**`.
  - Deliverable: exact grammar, `GraphScriptError` code list + `loc`/`cause` shape, generated-id
    contract, the canonical script + expected compiled GraphSpec (nodes `coder,review,fixer,done,
    done_join`; edges incl. the otherwise→`done_join` rewrite), fan-out fixture + `report_join`.
    Publish the initial Parallel Path (below).
  - Verification: fixtures hand-checked against frozen `graph.ts` rules (predicate requires one
    otherwise; join semantics; id pattern). No code.

- [ ] **Impl-A: Harden generated ids in `src/graph-definition.ts`**
  - Files: `src/graph-definition.ts`, `tests/graph-definition.test.ts`.
  - Depends on: Contract-1 (id contract).
  - Must not touch: `graph-script.ts`, `graph-tool.ts`, `graph.ts`, `graph-runtime.ts`, `graph-agent.ts`.
  - Deliverable: deterministic bounded collision-safe edge/join ids; readable-when-fits (`from_to_to` /
    `target_join`), else `edge_{n}`/`join_{n}`; collision-checked against all node ids; short-id
    behavior unchanged.
  - Verification: boundary/collision tests (64-char ids; author `done_join`; author `edge_1`);
    existing `graph-definition`/`graph-scenarios`/`staged-workflow` tests stay green.

- [ ] **Impl-B: Implement `compileGraphScript` in `src/graph-script.ts`**
  - Files: `src/graph-script.ts`, `tests/graph-script.test.ts`.
  - Depends on: Contract-1 (grammar; treats `compileGraphDefinition` as a stable API).
  - Must not touch: `graph-definition.ts`, `graph-tool.ts`, `graph.ts`, `graph-runtime.ts`, `graph-agent.ts`.
  - Deliverable: `compileGraphScript(script): GraphSpec`; meta + static guard + binding table +
    allowlist AST pass; `GraphScriptError` with `loc`/`cause`; idempotent.
  - Verification: grammar accept/reject matrix; guard-bypass matrix; idempotence (two compiles →
    identical serialized GraphSpec); canonical fixture assertions.

- [ ] **Docs-C: IntelliSense types + exports + README**
  - Files: `types/workflow-graph.d.ts`, `package.json`, `README.md`.
  - Depends on: Contract-1 (grammar).
  - Must not touch: `src/**`.
  - Deliverable: `agent`/`to`/`when`/`otherwise`/`budget` ambient types; `"./workflow-graph"` subpath;
    README section.
  - Verification: reference fixture typechecks; exports resolve; README renders. (Off critical path;
    may fold into Tool-D if budget tightens.)

- [ ] **Tool-D: Wire `script` into `workflow_graph`**
  - Files: `src/graph-tool.ts`, `tests/graph-tool.test.ts`, `src/index.ts`.
  - Depends on: Impl-B (implemented `compileGraphScript`); Impl-A before review.
  - Must not touch: `graph-script.ts`, `graph-definition.ts`, `graph.ts`, `graph-runtime.ts`, `graph-agent.ts`.
  - Deliverable: `script` param; three-way mutual exclusion; guidance teaches the DSL; flip the
    existing rejection test; export `compileGraphScript` + `GraphScriptError` from `src/index.ts`.
  - Verification: tool test (`script` start → runId, status/wait shared, terminal-only completion, disambiguation);
    tsc + biome.

- [ ] **Scenario-E: End-to-end graph script scenarios**
  - Files: `tests/graph-script-scenario.test.ts`.
  - Depends on: Impl-B (runtime path) + Tool-D (tool-script path).
  - Must not touch: `src/**`.
  - Deliverable: canonical pass/change routing; fan-out concurrency ≤ `maxConcurrency`; `report_join`
    joins three; terminal completion excludes intermediate artifacts.
  - Verification: tests pass.

- [ ] **Review-1: Integration review gate**
  - Reviewer: not an executor of the reviewed work (persistent reviewer).
  - Review: checklist below.
  - Block fan-out until: zero critical/high; mediums have ship/[[follow-up]] decisions; ≤2 repair rounds.

- [ ] **Verify-1: Final cross-cutting verification**
  - Depends on: Review-1.
  - Deliverable: checklist below.

## Dependency graph and critical path

```text
Contract-1 ─┬─ Impl-A ──────────────┐
            ├─ Impl-B ──────────────┼─ Tool-D ─ Scenario-E ─ Review-1 ─ Verify-1
            └─ Docs-C ──────────────┘          (Docs-C off critical path)
```

**Critical path:** Contract-1 → Impl-B → Tool-D → Scenario-E → Review-1 → Verify-1.
Impl-A joins before Review-1 (its id safety is reviewed end-to-end); Docs-C may complete any time
after Contract-1.

## Fan-out order and non-overlap rules

1. Contract-1 freezes the grammar + fixtures before any implementation fan-out.
2. Impl-A, Impl-B, Docs-C run concurrently in **isolated worktrees** after Contract-1 (disjoint files).
3. Tool-D is serialized after Impl-B (imports the real module) and owns the high-conflict
   `graph-tool.ts` + `src/index.ts`.
4. Scenario-E after Tool-D (covers both runtime and tool paths).
5. No graph implementation lane expands into unrelated legacy surfaces; each graph file has exactly one owner:
   `graph-definition.ts`=A, `graph-script.ts`=B, `types/`+`package.json`+`README`=Docs-C,
   `graph-tool.ts`+`index.ts`=Tool-D, `graph-script-scenario.test.ts`=Scenario-E.

## Parallelization audit

- **Challenged serial edges removed:** Impl-A and Impl-B were formerly believed serial because B calls
  `compileGraphDefinition`; B only needs its API (stable), so both run after Contract-1. Docs-C was
  pulled from "after implementation" to Wave 1 (needs only the frozen grammar).
- **Useful splits:** the tool-script relay test stays with Tool-D, but the compiler→runtime scenario
  is a separate lane (Scenario-E) so compiler work isn't blocked on tool wiring.
- **Rejected unsafe splits:** Tool-D cannot split from Impl-B (imports its module); `graph-tool.ts`
  and `src/index.ts` stay single-owner; `graph-script.ts` vs `graph-definition.ts` are kept separate
  to avoid two lanes editing the compiler seam at once.
- **Peak safe concurrency:** 3 lanes (Wave 1). Any lower and the remaining serial edge (B→Tool-D)
  would have an explained reason, not be a default.

## Parallel path

```text
Contract lock (grammar + canonical fixtures + id contract)
   ├─ Impl-A: graph-definition id hardening ─────────┐
   ├─ Impl-B: graph-script compiler ──────────────────┼─ integration review (Review-1)
   └─ Docs-C: types/exports/README ────────────────────┘          │
                                              Tool-D (tool wiring)┘
                                                   │
                                              Scenario-E ─ Verify-1
```

- Lane start conditions: Impl-A/B/Docs-C start from the Contract-1 commit/fixtures (contract-only
  consumers); Tool-D starts from Impl-B's merged commit; Scenario-E from Tool-D.
- Join points: Tool-D joins A+B; the integration review gate joins A+B+D; Verify-1 is the final join.

## Persistent review gate checklist (Review-1)

- [ ] Canonical script compiles to the documented GraphSpec (incl. `done_join` + edge rewrite).
- [ ] Change path → fixer→done (join `{ fixer }`); pass path → done (join `{ review }`); fixer skipped `route_not_selected` on pass.
- [ ] Fan-out runs concurrently ≤ `maxConcurrency`; `report_join` joins the three sources.
- [ ] Static-argument guard rejects the full bypass matrix; allowlist AST rejects await/return/loops/functions/assignments/updates/imports.
- [ ] `GraphScriptError` carries `code`+`loc`+`cause`; graph-shape errors wrap as `cause`.
- [ ] Generated ids bounded/collision-safe incl. 64-char and reserved-name boundary cases.
- [ ] Legacy `workflow` behavior remains covered by regression tests; graph runtime contracts stay compatible.
- [ ] Tool `script` path: start returns `runId` before completion; one terminal follow-up wakes the parent with the canonical final answer while intermediate artifacts remain unrelayed; status/wait observe the same run.
- [ ] Idempotence: same script twice → byte-identical serialized GraphSpec.

## Final verification checklist (Verify-1)

- [ ] `npm test` green (biome + tsc + all unit tests, legacy `workflow` tests unchanged).
- [ ] `git diff --exit-code <frozen-commit> -- src/graph.ts tests/graph-contract.test.ts` (byte-identical where required); legacy repairs are reviewed separately.
- [ ] Manual pass + change routing snapshot of the canonical fixture (fixer skipped vs ran; `done` join value correct).
- [ ] Manual fan-out concurrency snapshot (`maxConcurrency` respected; `report_join` value correct).
- [ ] Tool `script` path terminal-only completion (intermediate artifacts excluded) + start-before-completion.
- [ ] Deferred non-blocking follow-ups listed.

## Handoff contract

Wave 0 (Contract-1) freezes the v1 grammar, the `GraphScriptError` taxonomy (+`loc`/`cause`), the
generated-id contract, and the canonical + fan-out acceptance fixtures into a commit. That commit
is the **handoff point**: Impl-A, Impl-B, and Docs-C each start from it and consume only its
frozen fixtures (no one rediscovers grammar or id rules). Tool-D starts from Impl-B's merged commit
and the Contract-1 fixtures. The persistent reviewer carries the Review-1 checklist across the gate.
