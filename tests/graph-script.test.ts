/**
 * compileGraphScript tests — pinned to the frozen fixtures of ADR 0002 (§6, §7)
 * and the error taxonomy (§4).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileGraphScript, GraphScriptError } from "../src/graph-script.js";

const FIX_OR_SHIP = `export const meta = { name: 'fix_or_ship', description: 'Coder → review → fix then ship, or ship directly.' }

const coder  = agent('You are a coder agent. Read the coder skill and implement the change.', { role: 'implementation' })
const review = agent('Review the change. Respond with exactly <verdict>change</verdict> or <verdict>pass</verdict>.', { role: 'reviewer' })
const fixer  = agent('Apply the requested changes.', { role: 'implementation' })
const done   = agent('Finalize and report.', { role: 'verifier' })

coder.to(review)
review.when('<verdict>change</verdict>', fixer).otherwise(done)
fixer.to(done)
`;

const AUDIT = `export const meta = { name: 'audit', description: 'Scan, then three analyses, then synthesize.' }

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
`;

// --- 1. Canonical acceptance fixture: fix_or_ship (ADR §6) ---
test("fix_or_ship compiles to the exact frozen GraphSpec", () => {
  const actual = compileGraphScript(FIX_OR_SHIP);
  const expected = {
    version: 1,
    id: "fix_or_ship",
    name: "fix_or_ship",
    nodes: [
      {
        kind: "agent",
        id: "coder",
        prompt: "You are a coder agent. Read the coder skill and implement the change.",
        role: "implementation",
      },
      {
        kind: "agent",
        id: "review",
        prompt: "Review the change. Respond with exactly <verdict>change</verdict> or <verdict>pass</verdict>.",
        role: "reviewer",
        inputArtifacts: [{ nodeId: "coder", output: "finalText" }],
      },
      {
        kind: "agent",
        id: "fixer",
        prompt: "Apply the requested changes.",
        role: "implementation",
        inputArtifacts: [{ nodeId: "review", output: "finalText" }],
      },
      {
        kind: "agent",
        id: "done",
        prompt: "Finalize and report.",
        role: "verifier",
        inputArtifacts: [{ nodeId: "done_join", output: "value" }],
      },
      { kind: "deterministic", id: "done_join", operation: "join" },
    ],
    edges: [
      { id: "coder_to_review", from: "coder", to: "review" },
      {
        id: "review_to_fixer",
        from: "review",
        to: "fixer",
        route: {
          kind: "predicate",
          predicate: {
            type: "finalText",
            regex: { source: "finalText", pattern: "<verdict>change</verdict>" },
          },
        },
      },
      { id: "review_to_done_join", from: "review", to: "done_join", route: { kind: "otherwise" } },
      { id: "fixer_to_done_join", from: "fixer", to: "done_join" },
      { id: "done_join_to_done", from: "done_join", to: "done" },
    ],
    roles: { implementation: {}, reviewer: {}, verifier: {} },
  };
  assert.deepStrictEqual(actual, expected);
});

// --- 2. Fan-out acceptance fixture: audit (ADR §7) ---
test("audit compiles to the exact frozen GraphSpec", () => {
  const actual = compileGraphScript(AUDIT);
  const expected = {
    version: 1,
    id: "audit",
    name: "audit",
    nodes: [
      { kind: "agent", id: "scan", prompt: "Inventory the repo." },
      {
        kind: "agent",
        id: "facts",
        prompt: "Collect facts about structure.",
        inputArtifacts: [{ nodeId: "scan", output: "finalText" }],
      },
      {
        kind: "agent",
        id: "risks",
        prompt: "Collect risks about security.",
        inputArtifacts: [{ nodeId: "scan", output: "finalText" }],
      },
      {
        kind: "agent",
        id: "dups",
        prompt: "Find duplicated responsibility.",
        inputArtifacts: [{ nodeId: "scan", output: "finalText" }],
      },
      {
        kind: "agent",
        id: "report",
        prompt: "Synthesize the three analyses.",
        inputArtifacts: [{ nodeId: "report_join", output: "value" }],
      },
      { kind: "deterministic", id: "report_join", operation: "join" },
    ],
    edges: [
      { id: "scan_to_facts", from: "scan", to: "facts" },
      { id: "scan_to_risks", from: "scan", to: "risks" },
      { id: "scan_to_dups", from: "scan", to: "dups" },
      { id: "facts_to_report_join", from: "facts", to: "report_join" },
      { id: "risks_to_report_join", from: "risks", to: "report_join" },
      { id: "dups_to_report_join", from: "dups", to: "report_join" },
      { id: "report_join_to_report", from: "report_join", to: "report" },
    ],
    budgets: { maxConcurrency: 3 },
  };
  assert.deepStrictEqual(actual, expected);
});

// --- 3. Idempotence: byte-identical serialized output across compiles ---
test("compiling the same script twice is byte-identical", () => {
  const first = compileGraphScript(AUDIT);
  const second = compileGraphScript(AUDIT);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

// --- 4. Error-code mapping ---
function assertScriptError(script: string, code: string): void {
  assert.throws(
    () => compileGraphScript(script),
    (error: unknown) => error instanceof GraphScriptError && error.code === code,
    `expected code ${code}`,
  );
}

test("imperative await agent(...) is script_not_declarative", () => {
  const script = `export const meta = { name: 't', description: 't' }
await agent('x')
`;
  assertScriptError(script, "script_not_declarative");
});

test("bare .when(...) without .otherwise is script_not_declarative", () => {
  const script = `export const meta = { name: 't', description: 't' }
const coder = agent('x')
const review = agent('y')
coder.when('z', review)
`;
  assertScriptError(script, "script_not_declarative");
});

test("multi-hop a.to(b).to(c) chaining is script_not_declarative", () => {
  const script = `export const meta = { name: 't', description: 't' }
const a = agent('x')
const b = agent('y')
const c = agent('z')
a.to(b).to(c)
`;
  assertScriptError(script, "script_not_declarative");
});

test("use-before-declaration is script_use_before_declaration", () => {
  const script = `export const meta = { name: 't', description: 't' }
const coder = agent('x')
coder.to(review)
const review = agent('y')
`;
  assertScriptError(script, "script_use_before_declaration");
});

test("unknown global identifier is script_unknown_identifier", () => {
  const script = `export const meta = { name: 't', description: 't' }
JSON.stringify({})
`;
  assertScriptError(script, "script_unknown_identifier");
});

test("unknown meta key is script_unknown_option", () => {
  const script = `export const meta = { name: 't', description: 't', bogus: 1 }
`;
  assertScriptError(script, "script_unknown_option");
});

test("non-static argument is script_non_static_argument", () => {
  const script = `export const meta = { name: 't', description: 't' }
const coder = agent('x ' + 'y')
`;
  assertScriptError(script, "script_non_static_argument");
});

test("duplicate budget() call is script_duplicate_budget", () => {
  const script = `export const meta = { name: 't', description: 't' }
const a = agent('x')
budget({ maxConcurrency: 1 })
budget({ maxConcurrency: 2 })
`;
  assertScriptError(script, "script_duplicate_budget");
});

test("missing meta name is script_meta_required", () => {
  const script = `export const meta = { description: 't' }
`;
  assertScriptError(script, "script_meta_required");
});

test("non-literal meta initializer is script_meta_not_literal", () => {
  const script = `export const meta = 42
`;
  assertScriptError(script, "script_meta_not_literal");
});

// --- 5. loc / cause shape ---
test("GraphScriptError carries loc and cause for wrapped/shape errors", () => {
  // invalid regex (graph-shape error) is wrapped preserving the code and cause
  const badRegex = `export const meta = { name: 't', description: 't' }
const a = agent('x')
const b = agent('y')
a.when('a+b', b).otherwise(b)
`;
  let wrapped: unknown;
  try {
    compileGraphScript(badRegex);
    assert.fail("expected compileGraphScript to throw");
  } catch (error) {
    wrapped = error;
  }
  assert.ok(wrapped instanceof GraphScriptError);
  assert.equal(wrapped.code, "invalid_regex");
  assert.equal((wrapped.cause as { code?: string }).code, "invalid_regex");
  // loc is attributed to the offending (last processed) statement
  assert.deepEqual(wrapped.loc, { line: 4, column: 0 });
});
