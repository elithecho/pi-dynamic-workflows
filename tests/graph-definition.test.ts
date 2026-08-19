import assert from "node:assert/strict";
import test from "node:test";
import { GraphContractError, type GraphThinkingLevel, type ModelSelector, validateGraphSpec } from "../src/graph.js";
import { compileGraphDefinition, type GraphDefinition } from "../src/graph-definition.js";

function assertThrowsInvalidGraph(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof GraphContractError && error.code === "invalid_graph");
}

test("linear chain a→b→c compiles bare routes with sequential finalText inputs", () => {
  const definition: GraphDefinition = {
    name: "chain",
    nodes: [
      { id: "a", prompt: "A" },
      { id: "b", prompt: "B" },
      { id: "c", prompt: "C" },
    ],
    routes: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  };
  const graph = compileGraphDefinition(definition);
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    graph.edges.map((edge) => edge.id),
    ["a_to_b", "b_to_c"],
  );
  for (const edge of graph.edges) assert.equal("route" in edge, false);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const a = byId.get("a");
  assert.ok(a);
  assert.equal("inputArtifacts" in a, false, "a is a root with no input");
  assert.deepEqual(byId.get("b")?.inputArtifacts, [{ nodeId: "a", output: "finalText" }]);
  assert.deepEqual(byId.get("c")?.inputArtifacts, [{ nodeId: "b", output: "finalText" }]);
  assert.doesNotThrow(() => validateGraphSpec(graph));
  assert.equal(Object.isFrozen(graph), true);
});

test("conditional leaf branch compiles when/otherwise leaves without a join", () => {
  const definition: GraphDefinition = {
    name: "branch",
    nodes: [
      { id: "coder", prompt: "code" },
      { id: "review", prompt: "review" },
      { id: "fixer", prompt: "fix" },
      { id: "done", prompt: "done" },
    ],
    routes: [
      { from: "coder", to: "review" },
      { from: "review", to: "fixer", when: "<verdict>change</verdict>" },
      { from: "review", to: "done", otherwise: true },
    ],
  };
  const graph = compileGraphDefinition(definition);
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ["coder", "review", "fixer", "done"],
  );
  assert.equal(
    graph.nodes.some((node) => node.kind === "deterministic"),
    false,
    "leaf branches must not insert a join node",
  );
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.deepEqual(byId.get("fixer")?.inputArtifacts, [{ nodeId: "review", output: "finalText" }]);
  assert.deepEqual(byId.get("done")?.inputArtifacts, [{ nodeId: "review", output: "finalText" }]);
  const byEdgeId = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const reviewToFixer = byEdgeId.get("review_to_fixer");
  assert.ok(reviewToFixer);
  assert.equal(reviewToFixer.from, "review");
  assert.equal(reviewToFixer.to, "fixer");
  assert.equal(reviewToFixer.route?.kind, "predicate");
  const predicate = reviewToFixer.route?.predicate;
  assert.equal(predicate?.type, "finalText");
  if (predicate?.type === "finalText") {
    assert.deepEqual(predicate, {
      type: "finalText",
      regex: { source: "finalText", pattern: "<verdict>change</verdict>" },
    });
    assert.equal(Object.hasOwn(predicate.regex, "flags"), false);
  }
  const reviewToDone = byEdgeId.get("review_to_done");
  assert.ok(reviewToDone);
  assert.equal(reviewToDone.from, "review");
  assert.equal(reviewToDone.to, "done");
  assert.deepEqual(reviewToDone.route, { kind: "otherwise" });
});

test('flags "i" on a when route propagates to the predicate regex', () => {
  const graph = compileGraphDefinition({
    name: "ci",
    nodes: [
      { id: "a", prompt: "A" },
      { id: "b", prompt: "B" },
      { id: "c", prompt: "C" },
    ],
    routes: [
      { from: "a", to: "b", when: "<ok>pass</ok>", flags: "i" },
      { from: "a", to: "c", otherwise: true },
    ],
  });
  const edge = graph.edges.find((candidate) => candidate.id === "a_to_b");
  assert.ok(edge);
  const predicate = edge.route?.predicate;
  assert.equal(predicate?.type, "finalText");
  if (predicate?.type === "finalText") {
    assert.deepEqual(predicate.regex, { source: "finalText", pattern: "<ok>pass</ok>", flags: "i" });
  }
});

test("convergence auto-joins a target with multiple distinct sources", () => {
  const graph = compileGraphDefinition({
    name: "converge",
    nodes: [
      { id: "a", prompt: "A" },
      { id: "b", prompt: "B" },
      { id: "c", prompt: "C" },
    ],
    routes: [
      { from: "a", to: "c", when: "go" },
      { from: "a", to: "b", otherwise: true },
      { from: "b", to: "c" },
    ],
  });
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ["a", "b", "c", "c_join"],
  );
  const join = graph.nodes.find((node) => node.id === "c_join");
  assert.ok(join);
  assert.equal(join.kind, "deterministic");
  if (join.kind === "deterministic") {
    assert.equal(join.operation, "join");
    assert.equal("inputArtifacts" in join, false);
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const c = byId.get("c");
  assert.ok(c);
  assert.deepEqual(c.inputArtifacts, [{ nodeId: "c_join", output: "value" }]);
  assert.equal(c.inputArtifacts?.length, 1);
  const byEdgeId = new Map(graph.edges.map((edge) => [edge.id, edge]));
  assert.deepEqual(
    graph.edges.map((edge) => edge.id),
    ["a_to_c_join", "a_to_b", "b_to_c_join", "c_join_to_c"],
  );
  const aToJoin = byEdgeId.get("a_to_c_join");
  assert.ok(aToJoin);
  assert.equal(aToJoin.route?.kind, "predicate");
  const predicate = aToJoin.route?.predicate;
  assert.equal(predicate?.type, "finalText");
  if (predicate?.type === "finalText") {
    assert.deepEqual(predicate.regex, { source: "finalText", pattern: "go" });
  }
  const aToB = byEdgeId.get("a_to_b");
  assert.ok(aToB);
  assert.deepEqual(aToB.route, { kind: "otherwise" });
  const bToJoin = byEdgeId.get("b_to_c_join");
  assert.ok(bToJoin);
  assert.equal("route" in bToJoin, false);
  const joinToC = byEdgeId.get("c_join_to_c");
  assert.ok(joinToC);
  assert.equal(joinToC.from, "c_join");
  assert.equal(joinToC.to, "c");
  assert.equal("route" in joinToC, false);
  assert.doesNotThrow(() => validateGraphSpec(graph));
});

test("distinct roles are auto-collected and preserved on nodes", () => {
  const graph = compileGraphDefinition({
    name: "roles",
    nodes: [
      { id: "a", prompt: "A", role: "code" },
      { id: "b", prompt: "B", role: "reviewer" },
      { id: "c", prompt: "C" },
    ],
    routes: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  });
  assert.deepEqual(graph.roles, { code: {}, reviewer: {} });
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const a = byId.get("a");
  assert.ok(a);
  assert.equal(a.kind, "agent");
  if (a.kind === "agent") assert.equal(a.role, "code");
  const b = byId.get("b");
  assert.ok(b);
  assert.equal(b.kind, "agent");
  if (b.kind === "agent") assert.equal(b.role, "reviewer");
  const c = byId.get("c");
  assert.ok(c);
  assert.equal(c.kind, "agent");
  if (c.kind === "agent") assert.equal(c.role, undefined);
});

test("per-node model and thinking pass through to the agent node", () => {
  const model: ModelSelector = { provider: "anthropic", modelId: "claude-sonnet-4" };
  const graph = compileGraphDefinition({
    name: "model",
    nodes: [{ id: "a", prompt: "A", model, thinking: "high" as GraphThinkingLevel }],
    routes: [],
  });
  const node = graph.nodes[0];
  assert.ok(node);
  assert.equal(node.kind, "agent");
  if (node.kind === "agent") {
    assert.deepEqual(node.model, model);
    assert.equal(node.thinking, "high");
  }
});

test("id/name defaults slugify the name and fall back to workflow", () => {
  const unnamed = compileGraphDefinition({ nodes: [{ id: "a", prompt: "A" }], routes: [] });
  assert.equal(unnamed.id, "workflow");
  assert.equal(unnamed.name, "Workflow");

  const slugged = compileGraphDefinition({ name: "My Demo Flow", nodes: [{ id: "a", prompt: "A" }], routes: [] });
  assert.equal(slugged.id, "my-demo-flow");
  assert.equal(slugged.name, "My Demo Flow");

  const numeric = compileGraphDefinition({ name: "42 flow", nodes: [{ id: "a", prompt: "A" }], routes: [] });
  assert.equal(numeric.id, "s42-flow");

  const explicit = compileGraphDefinition({
    id: "my-flow",
    name: "Demo",
    nodes: [{ id: "a", prompt: "A" }],
    routes: [],
  });
  assert.equal(explicit.id, "my-flow");
  assert.equal(explicit.name, "Demo");

  const budgeted = compileGraphDefinition({
    name: "budgeted",
    budgets: { maxConcurrency: 2, maxAttempts: 3 },
    nodes: [{ id: "a", prompt: "A" }],
    routes: [],
  });
  assert.equal(budgeted.budgets?.maxConcurrency, 2);
  assert.equal(budgeted.budgets?.maxAttempts, 3);
  assert.equal("budgets" in unnamed, false);
});

test("route and node validation failures throw invalid_graph", () => {
  const nodes: GraphDefinition["nodes"] = [
    { id: "a", prompt: "A" },
    { id: "b", prompt: "B" },
  ];
  assertThrowsInvalidGraph(() => compileGraphDefinition({ nodes, routes: [{ from: "z", to: "a" }] }));
  assertThrowsInvalidGraph(() => compileGraphDefinition({ nodes, routes: [{ from: "a", to: "z" }] }));
  assertThrowsInvalidGraph(() =>
    compileGraphDefinition({ nodes, routes: [{ from: "a", to: "b", when: "x", otherwise: true }] }),
  );
  assertThrowsInvalidGraph(() => compileGraphDefinition({ nodes, routes: [{ from: "a", to: "b", otherwise: true }] }));
  assertThrowsInvalidGraph(() =>
    compileGraphDefinition({
      nodes,
      routes: [
        { from: "a", to: "b", otherwise: true },
        { from: "a", to: "a", otherwise: true },
      ],
    }),
  );
  assertThrowsInvalidGraph(() => compileGraphDefinition({ nodes, routes: [{ from: "a", to: "b", when: "x" }] }));
  assertThrowsInvalidGraph(() =>
    compileGraphDefinition({
      nodes,
      routes: [
        { from: "a", to: "b" },
        { from: "a", to: "a", when: "x" },
      ],
    }),
  );
  assertThrowsInvalidGraph(() =>
    compileGraphDefinition({ nodes, routes: [{ from: "a", to: "b", when: "x", flags: "g" }] }),
  );
  assertThrowsInvalidGraph(() => compileGraphDefinition({ nodes: [{ id: "1bad", prompt: "A" }], routes: [] }));
  assertThrowsInvalidGraph(() => compileGraphDefinition({ nodes: [{ id: "a", prompt: "" }], routes: [] }));
  assertThrowsInvalidGraph(() => compileGraphDefinition({ nodes, routes: [{ from: "a", to: "b", when: "" }] }));
});

// Generated ids share the 64-char [A-Za-z][A-Za-z0-9_-]{0,63} node-id namespace;
// these cases pin the counter fallbacks and author-name collisions.
const LONG_TARGET = "t".repeat(60);

function compileTwiceIdentical(definition: GraphDefinition): ReturnType<typeof compileGraphDefinition> {
  const first = JSON.stringify(compileGraphDefinition(definition));
  const second = compileGraphDefinition(definition);
  assert.equal(JSON.stringify(second), first, "compile must be idempotent");
  return second;
}

function findJoin(graph: ReturnType<typeof compileGraphDefinition>, id: string) {
  const join = graph.nodes.find((node) => node.id === id);
  assert.ok(join, `expected join node ${id}`);
  return join;
}

test("64-char target names force join and edge counter fallbacks", () => {
  assert.ok(`${LONG_TARGET}_join`.length > 64, "LONG_TARGET + _join must exceed the 64-char id limit");
  const graph = compileTwiceIdentical({
    name: "long-target",
    nodes: [
      { id: "a", prompt: "A" },
      { id: "b", prompt: "B" },
      { id: LONG_TARGET, prompt: "T" },
    ],
    routes: [
      { from: "a", to: LONG_TARGET },
      { from: "b", to: LONG_TARGET },
    ],
  });
  assert.equal(
    graph.nodes.some((node) => node.id === `${LONG_TARGET}_join`),
    false,
  );
  assert.equal(findJoin(graph, "join_1").kind, "deterministic");
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.deepEqual(byId.get(LONG_TARGET)?.inputArtifacts, [{ nodeId: "join_1", output: "value" }]);
  const joinToTarget = graph.edges.find((edge) => edge.from === "join_1" && edge.to === LONG_TARGET);
  assert.ok(joinToTarget, "expected a join_1 -> LONG_TARGET edge");
  assert.equal(joinToTarget.id, "edge_1", "join_1_to_<target> exceeds 64 chars, so the edge falls back to the counter");
});

test("author node named done_join does not collide with the auto-join for done", () => {
  const graph = compileTwiceIdentical({
    name: "done-join-collision",
    nodes: [
      { id: "a", prompt: "A" },
      { id: "b", prompt: "B" },
      { id: "done", prompt: "D" },
      { id: "done_join", prompt: "author-bound node" },
    ],
    routes: [
      { from: "a", to: "done" },
      { from: "b", to: "done" },
    ],
  });
  assert.equal(graph.nodes.filter((node) => node.id === "done_join").length, 1, "author node kept, no duplicate");
  assert.equal(findJoin(graph, "join_1").kind, "deterministic");
  assert.equal(
    graph.nodes.some((node) => node.id === "done_join" && node.kind === "deterministic"),
    false,
  );
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.deepEqual(byId.get("done")?.inputArtifacts, [{ nodeId: "join_1", output: "value" }]);
});

test("author node named edge_1 forces the counter to skip to edge_2", () => {
  const graph = compileTwiceIdentical({
    name: "edge-counter-collision",
    nodes: [
      { id: "a", prompt: "A" },
      { id: "b", prompt: "B" },
      { id: LONG_TARGET, prompt: "T" },
      { id: "edge_1", prompt: "author-bound node" },
    ],
    routes: [
      { from: "a", to: LONG_TARGET },
      { from: "b", to: LONG_TARGET },
    ],
  });
  assert.equal(graph.nodes.filter((node) => node.id === "edge_1").length, 1, "author node kept, no duplicate");
  assert.equal(findJoin(graph, "join_1").kind, "deterministic");
  const joinToTarget = graph.edges.find((edge) => edge.from === "join_1" && edge.to === LONG_TARGET);
  assert.ok(joinToTarget, "expected a join_1 -> LONG_TARGET edge");
  assert.equal(joinToTarget.id, "edge_2", "edge_1 is taken by the author node, so the counter skips to edge_2");
});
