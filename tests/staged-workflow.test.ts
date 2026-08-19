import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FINAL_TEXT_PATTERN,
  GRAPH_CONTRACT_VERSION,
  GraphContractError,
  validateGraphSpec,
} from "../src/graph.js";
import {
  compileStagedWorkflowGraph,
  STAGED_WORKFLOW_MAX_ROUNDS,
  type StagedWorkflowPolicy,
  stagedReviewVerdictInstruction,
} from "../src/staged-workflow.js";

function minimalValidPolicy(): StagedWorkflowPolicy {
  return {
    name: "demo",
    implementationPrompt: "impl",
    reviewerPrompt: "review",
    remediationPrompt: "fix",
    verificationPrompt: "verify",
  };
}

function withoutPrompt(key: "implementationPrompt" | "reviewerPrompt" | "verificationPrompt"): StagedWorkflowPolicy {
  return { ...minimalValidPolicy(), [key]: undefined } as unknown as StagedWorkflowPolicy;
}

function assertThrowsInvalidGraph(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof GraphContractError && error.code === "invalid_graph");
}

test("rounds=1 yields the canonical node order and a valid frozen graph", () => {
  const graph = compileStagedWorkflowGraph(minimalValidPolicy());
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ["implementation", "review_1", "remediation_1", "review_2", "final_verification", "final_verification_join"],
  );
  assert.doesNotThrow(() => validateGraphSpec(graph));
  assert.equal(graph.version, GRAPH_CONTRACT_VERSION);
  assert.equal(Object.isFrozen(graph), true);
});

test("rounds=1 edges connect exactly as specified", () => {
  const graph = compileStagedWorkflowGraph(minimalValidPolicy());
  assert.deepEqual(
    graph.edges.map((edge) => edge.id),
    [
      "implementation_to_review_1",
      "review_1_to_final_verification_join",
      "review_1_to_remediation_1",
      "remediation_1_to_review_2",
      "review_2_to_final_verification_join",
      "final_verification_join_to_final_verification",
    ],
  );
  const byId = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const implementationToReview = byId.get("implementation_to_review_1");
  assert.ok(implementationToReview);
  assert.equal(implementationToReview.from, "implementation");
  assert.equal(implementationToReview.to, "review_1");
  assert.equal(implementationToReview.route, undefined);

  const review1Predicate = byId.get("review_1_to_final_verification_join");
  assert.ok(review1Predicate);
  assert.equal(review1Predicate.from, "review_1");
  assert.equal(review1Predicate.to, "final_verification_join");
  assert.equal(review1Predicate.route?.kind, "predicate");
  const predicate = review1Predicate.route?.predicate;
  assert.equal(predicate?.type, "finalText");
  if (predicate?.type === "finalText") {
    assert.deepEqual(predicate, {
      type: "finalText",
      regex: { source: "finalText", pattern: DEFAULT_FINAL_TEXT_PATTERN },
    });
    assert.equal(Object.hasOwn(predicate.regex, "flags"), false);
  }

  const noMatch = byId.get("review_1_to_remediation_1");
  assert.ok(noMatch);
  assert.equal(noMatch.from, "review_1");
  assert.equal(noMatch.to, "remediation_1");
  assert.deepEqual(noMatch.route, { kind: "otherwise" });

  const remediationToReview = byId.get("remediation_1_to_review_2");
  assert.ok(remediationToReview);
  assert.equal(remediationToReview.from, "remediation_1");
  assert.equal(remediationToReview.to, "review_2");
  assert.equal(remediationToReview.route, undefined);

  const review2ToJoin = byId.get("review_2_to_final_verification_join");
  assert.ok(review2ToJoin);
  assert.equal(review2ToJoin.from, "review_2");
  assert.equal(review2ToJoin.to, "final_verification_join");
  assert.equal(review2ToJoin.route, undefined);

  const joinToVerification = byId.get("final_verification_join_to_final_verification");
  assert.ok(joinToVerification);
  assert.equal(joinToVerification.from, "final_verification_join");
  assert.equal(joinToVerification.to, "final_verification");
  assert.equal(joinToVerification.route, undefined);
});

test("artifact inputs wire implementation → review → remediation → final verification", () => {
  const graph = compileStagedWorkflowGraph(minimalValidPolicy());
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.deepEqual(byId.get("review_1")?.inputArtifacts, [{ nodeId: "implementation", output: "finalText" }]);
  assert.deepEqual(byId.get("remediation_1")?.inputArtifacts, [{ nodeId: "review_1", output: "finalText" }]);
  assert.deepEqual(byId.get("review_2")?.inputArtifacts, [{ nodeId: "remediation_1", output: "finalText" }]);
  assert.deepEqual(byId.get("final_verification")?.inputArtifacts, [
    { nodeId: "final_verification_join", output: "value" },
  ]);
  const finalJoin = byId.get("final_verification_join");
  assert.ok(finalJoin);
  assert.equal(finalJoin.kind, "deterministic");
  if (finalJoin.kind === "deterministic") {
    assert.equal(finalJoin.operation, "join");
    assert.equal("inputArtifacts" in finalJoin, false);
  }
});

test("roles declare implementation, reviewer, verifier with defaults", () => {
  const graph = compileStagedWorkflowGraph(minimalValidPolicy());
  assert.deepEqual(Object.keys(graph.roles ?? {}).sort(), ["implementation", "reviewer", "verifier"]);
  assert.deepEqual(graph.roles?.implementation, {});
  assert.deepEqual(graph.roles?.reviewer, {});
  assert.deepEqual(graph.roles?.verifier, {});
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const rolePairs = [
    [byId.get("implementation"), "implementation"],
    [byId.get("review_1"), "reviewer"],
    [byId.get("remediation_1"), "implementation"],
    [byId.get("review_2"), "reviewer"],
    [byId.get("final_verification"), "verifier"],
  ] as const;
  for (const [node, expectedRole] of rolePairs) {
    assert.ok(node);
    assert.equal(node.kind, "agent");
    if (node.kind === "agent") assert.equal(node.role, expectedRole);
  }
});

test("roleDefaults apply model and thinking onto the nodes", () => {
  const graph = compileStagedWorkflowGraph({
    ...minimalValidPolicy(),
    roleDefaults: {
      implementation: { thinking: "minimal" },
      reviewer: { model: { provider: "anthropic", modelId: "claude-sonnet-4" }, thinking: "high" },
      verifier: {},
    },
  });
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const implementation = byId.get("implementation");
  assert.ok(implementation);
  assert.equal(implementation.kind, "agent");
  if (implementation.kind === "agent") assert.equal(implementation.thinking, "minimal");
  const review1 = byId.get("review_1");
  assert.ok(review1);
  assert.equal(review1.kind, "agent");
  if (review1.kind === "agent") {
    assert.deepEqual(review1.model, { provider: "anthropic", modelId: "claude-sonnet-4" });
    assert.equal(review1.thinking, "high");
  }
  const finalVerification = byId.get("final_verification");
  assert.ok(finalVerification);
  assert.equal(finalVerification.kind, "agent");
  if (finalVerification.kind === "agent") {
    assert.equal("model" in finalVerification, false);
    assert.equal("thinking" in finalVerification, false);
  }
  assert.deepEqual(graph.roles?.reviewer, {});
});

test("rounds=3 produces the full remediation ladder", () => {
  const graph = compileStagedWorkflowGraph({ ...minimalValidPolicy(), rounds: 3 });
  assert.equal(graph.nodes.length, 10);
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    [
      "implementation",
      "review_1",
      "remediation_1",
      "review_2",
      "remediation_2",
      "review_3",
      "remediation_3",
      "review_4",
      "final_verification",
      "final_verification_join",
    ],
  );
});

test("rounds outside [1, STAGED_WORKFLOW_MAX_ROUNDS] throws invalid_graph", () => {
  assert.equal(STAGED_WORKFLOW_MAX_ROUNDS, 3);
  assertThrowsInvalidGraph(() => compileStagedWorkflowGraph({ ...minimalValidPolicy(), rounds: 4 }));
  assertThrowsInvalidGraph(() => compileStagedWorkflowGraph({ ...minimalValidPolicy(), rounds: 0 }));
  assertThrowsInvalidGraph(() => compileStagedWorkflowGraph({ ...minimalValidPolicy(), rounds: 1.5 }));
});

test("missing required prompts throw invalid_graph", () => {
  assertThrowsInvalidGraph(() => compileStagedWorkflowGraph(withoutPrompt("implementationPrompt")));
  assertThrowsInvalidGraph(() => compileStagedWorkflowGraph(withoutPrompt("reviewerPrompt")));
  assertThrowsInvalidGraph(() => compileStagedWorkflowGraph(withoutPrompt("verificationPrompt")));
});

test("remediationPrompt defaults to the documented remediation instruction", () => {
  const graph = compileStagedWorkflowGraph({
    implementationPrompt: "impl",
    reviewerPrompt: "review",
    verificationPrompt: "verify",
  });
  const remediation = graph.nodes.find((node) => node.id === "remediation_1");
  assert.ok(remediation);
  if (remediation.kind !== "agent") throw new Error("remediation_1 must be an agent node");
  assert.equal(remediation.prompt, "Address every finding from the most recent review and produce a revised result.");
});

test("custom finalTextPattern and flags apply to every predicate edge", () => {
  const graph = compileStagedWorkflowGraph({
    ...minimalValidPolicy(),
    rounds: 2,
    finalTextPattern: "<ok>\\s*pass</ok>",
    finalTextFlags: "i",
  });
  for (let round = 1; round <= 2; round += 1) {
    const edge = graph.edges.find((candidate) => candidate.id === `review_${round}_to_final_verification_join`);
    assert.ok(edge);
    const predicate = edge.route?.predicate;
    assert.equal(predicate?.type, "finalText");
    if (predicate?.type === "finalText") {
      assert.deepEqual(predicate.regex, { source: "finalText", pattern: "<ok>\\s*pass</ok>", flags: "i" });
    }
  }
});

test("budgets propagate and are omitted when absent", () => {
  const graph = compileStagedWorkflowGraph({
    ...minimalValidPolicy(),
    budgets: { maxConcurrency: 2, maxAttempts: 3 },
  });
  assert.equal(graph.budgets?.maxConcurrency, 2);
  assert.equal(graph.budgets?.maxAttempts, 3);
  const withoutBudgets = compileStagedWorkflowGraph(minimalValidPolicy());
  assert.equal("budgets" in withoutBudgets, false);
});

test("id defaults from name, falls back to the generic workflow id", () => {
  const unnamed = compileStagedWorkflowGraph({
    implementationPrompt: "impl",
    reviewerPrompt: "review",
    verificationPrompt: "verify",
  });
  assert.equal(unnamed.id, "workflow");
  assert.equal(unnamed.name, "Workflow");
  const slugged = compileStagedWorkflowGraph({ ...minimalValidPolicy(), name: "My Demo Flow" });
  assert.equal(slugged.id, "my-demo-flow");
  const numeric = compileStagedWorkflowGraph({ ...minimalValidPolicy(), name: "42 flow" });
  assert.equal(numeric.id, "s42-flow");
});

test("explicit id is preserved; invalid ids throw invalid_graph", () => {
  const graph = compileStagedWorkflowGraph({ ...minimalValidPolicy(), id: "my-flow" });
  assert.equal(graph.id, "my-flow");
  assertThrowsInvalidGraph(() => compileStagedWorkflowGraph({ ...minimalValidPolicy(), id: "1bad" }));
});

test("review node prompts embed the dynamic verdict instruction", () => {
  const graph = compileStagedWorkflowGraph(minimalValidPolicy());
  const review1 = graph.nodes.find((node) => node.id === "review_1");
  assert.ok(review1);
  if (review1.kind !== "agent") throw new Error("review_1 must be an agent node");
  assert.ok(review1.prompt.startsWith("review"));
  assert.ok(review1.prompt.endsWith(stagedReviewVerdictInstruction()));
  assert.equal(review1.prompt, `review\n\n${stagedReviewVerdictInstruction()}`);
  assert.ok(stagedReviewVerdictInstruction().includes("<verdict>pass</verdict>"));
});

test("a custom pattern and flags change the verdict instruction", () => {
  const pattern = "<ok>\\s*pass</ok>";
  const graph = compileStagedWorkflowGraph({
    ...minimalValidPolicy(),
    finalTextPattern: pattern,
    finalTextFlags: "i",
  });
  const review1 = graph.nodes.find((node) => node.id === "review_1");
  assert.ok(review1);
  if (review1.kind !== "agent") throw new Error("review_1 must be an agent node");
  assert.equal(review1.prompt, `review\n\n${stagedReviewVerdictInstruction(pattern, "i")}`);
  assert.ok(review1.prompt.includes("<ok>pass</ok>"), "the example is derived from the actual pattern");
  assert.ok(review1.prompt.includes("case-insensitive"));
  assert.ok(!review1.prompt.includes("<verdict>pass</verdict>"), "the instruction is never hardcoded to a tag");
});
