import assert from "node:assert/strict";
import test from "node:test";
import {
  createArtifact,
  createDeterministicArtifact,
  DEFAULT_FINAL_TEXT_PATTERN,
  GraphContractError,
  type GraphLifecycleEvent,
  type GraphSpec,
  getInvokingParentContext,
  isJoinSatisfied,
  MAX_REGEX_PATTERN_LENGTH,
  matchesFinalText,
  matchesJsonPredicate,
  resolveExecutionContext,
  selectGraphRoutes,
  validateGraphPreflight,
  validateGraphSpec,
} from "../src/index.js";

const parent = { model: { provider: "test", modelId: "parent" }, thinking: "medium" as const };

function reviewGraph(nonPass: boolean): GraphSpec {
  return {
    version: 1,
    id: nonPass ? "review-non-pass" : "review-pass",
    name: "staged review",
    defaults: { model: parent.model, thinking: parent.thinking },
    roles: { reviewer: {} },
    nodes: [
      { kind: "agent", id: "implementation", prompt: "Implement the change." },
      { kind: "agent", id: "review-1", role: "reviewer", prompt: "Review the implementation." },
      { kind: "agent", id: "remediation", prompt: "Address the review." },
      { kind: "agent", id: "review-2", prompt: "Review the remediation." },
      { kind: "deterministic", id: "final-verification", operation: "join" },
    ],
    edges: [
      { id: "implementation-review", from: "implementation", to: "review-1" },
      {
        id: "review-pass",
        from: "review-1",
        to: "final-verification",
        route: {
          kind: "predicate",
          predicate: {
            type: "finalText",
            regex: { source: "finalText", pattern: DEFAULT_FINAL_TEXT_PATTERN },
          },
        },
      },
      {
        id: "review-remediation",
        from: "review-1",
        to: "remediation",
        route: { kind: "otherwise" },
      },
      { id: "remediation-review", from: "remediation", to: "review-2" },
      { id: "review-2-final", from: "review-2", to: "final-verification" },
    ],
    budgets: { maxConcurrency: 2, maxAttempts: 4 },
  };
}

test("accepts canonical pass and otherwise review route shapes", () => {
  const pass = validateGraphSpec(reviewGraph(false));
  const nonPass = validateGraphSpec(reviewGraph(true));
  assert.equal(pass.nodes.length, 5);
  assert.equal(nonPass.edges.filter((edge) => edge.route?.kind === "predicate").length, 1);
  assert.equal(nonPass.edges.filter((edge) => edge.route?.kind === "otherwise").length, 1);
  const passPredicate = pass.edges[1]?.route?.predicate;
  assert.ok(passPredicate);
  assert.equal(matchesFinalText(passPredicate, "<verdict>pass</verdict>"), true);
  assert.equal(matchesFinalText(passPredicate, "<verdict>   pass </verdict>"), true);
  assert.equal(matchesFinalText(passPredicate, "<verdict>fail</verdict>"), false);
  assert.equal(matchesFinalText(passPredicate, "ordinary prose mentioning pass"), false);
  assert.equal(
    matchesFinalText({ type: "finalText", regex: { source: "finalText", pattern: "pass", flags: "i" } }, "PASS"),
    true,
  );
  assert.equal(matchesFinalText({ type: "finalText", regex: { source: "finalText", pattern: "\\s" } }, "\u000b"), true);
  assert.equal(matchesFinalText({ type: "finalText", regex: { source: "finalText", pattern: "\\s" } }, "\u00a0"), true);
  assert.equal(matchesFinalText({ type: "finalText", regex: { source: "finalText", pattern: "\\s" } }, "\ufeff"), true);
  const reviewArtifact = createArtifact({
    id: "review-1-output",
    nodeId: "review-1",
    value: null,
    finalText: "<verdict>fail</verdict>",
  });
  const outgoing = pass.edges.filter((edge) => edge.from === "review-1");
  assert.equal(selectGraphRoutes(outgoing, reviewArtifact)[0]?.to, "remediation");
  const passArtifact = { ...reviewArtifact, finalText: "<verdict>pass</verdict>" };
  assert.equal(selectGraphRoutes(outgoing, passArtifact)[0]?.to, "final-verification");
  const snapshots = [
    ...["implementation", "review-1"].map((id) => ({ id, state: "succeeded" as const, attempt: 1, artifactIds: [] })),
    {
      id: "remediation",
      state: "skipped" as const,
      skipReason: "route_not_selected" as const,
      attempt: 0,
      artifactIds: [],
    },
    {
      id: "review-2",
      state: "skipped" as const,
      skipReason: "route_not_selected" as const,
      attempt: 0,
      artifactIds: [],
    },
  ];
  assert.equal(isJoinSatisfied("final-verification", pass, snapshots, [passArtifact]), true);

  const nonPassSnapshots = [
    ...["implementation", "review-1", "remediation", "review-2"].map((id) => ({
      id,
      state: "succeeded" as const,
      attempt: 1,
      artifactIds: [],
    })),
  ];
  assert.equal(
    isJoinSatisfied("final-verification", nonPass, nonPassSnapshots, [
      reviewArtifact,
      createArtifact({ id: "review-2-output", nodeId: "review-2", value: null, finalText: "done" }),
    ]),
    true,
  );
});

test("rejects malformed regex, unsupported flags, catastrophic syntax, and oversized patterns", () => {
  const base = reviewGraph(false);
  const invalid = (regex: object) => ({
    ...base,
    edges: [
      { ...base.edges[1], route: { kind: "predicate" as const, predicate: { type: "finalText" as const, regex } } },
    ],
  });
  assert.throws(
    () => validateGraphSpec(invalid({ source: "finalText", pattern: "[" })),
    (error: unknown) => error instanceof GraphContractError && error.code === "invalid_regex",
  );
  assert.throws(
    () => validateGraphSpec(invalid({ source: "finalText", pattern: "((a+))+$" })),
    (error: unknown) => error instanceof GraphContractError && error.code === "invalid_regex",
  );
  assert.throws(
    () => validateGraphSpec(invalid({ source: "finalText", pattern: "pass", flags: "g" })),
    (error: unknown) => error instanceof GraphContractError && error.code === "invalid_regex",
  );
  assert.throws(
    () => validateGraphSpec(invalid({ source: "finalText", pattern: "pass", flags: "m" })),
    (error: unknown) => error instanceof GraphContractError && error.code === "invalid_regex",
  );
  assert.throws(
    () => validateGraphSpec(invalid({ source: "finalText", pattern: "x".repeat(MAX_REGEX_PATTERN_LENGTH + 1) })),
    (error: unknown) => error instanceof GraphContractError && error.code === "invalid_regex",
  );
});

test("selects every matching predicate in declaration order and otherwise only on no match", () => {
  const edges = [
    {
      id: "first",
      from: "review-1",
      to: "remediation",
      route: {
        kind: "predicate" as const,
        predicate: { type: "finalText" as const, regex: { source: "finalText" as const, pattern: "pass" } },
      },
    },
    {
      id: "second",
      from: "review-1",
      to: "review-2",
      route: {
        kind: "predicate" as const,
        predicate: { type: "finalText" as const, regex: { source: "finalText" as const, pattern: "review" } },
      },
    },
    { id: "fallback", from: "review-1", to: "implementation", route: { kind: "otherwise" as const } },
  ];
  const artifact = createArtifact({ id: "review", nodeId: "review-1", value: null, finalText: "pass review" });
  assert.deepEqual(
    selectGraphRoutes(edges, artifact).map((edge) => edge.id),
    ["first", "second"],
  );
  assert.deepEqual(
    selectGraphRoutes(edges, { ...artifact, finalText: "no match" }).map((edge) => edge.id),
    ["fallback"],
  );
});

test("matches JSON predicates and rejects graph topology errors", () => {
  assert.equal(
    matchesJsonPredicate(
      { type: "json", predicate: { source: "json", path: "/verdict", equals: "pass" } },
      { verdict: "pass" },
    ),
    true,
  );
  const topology: GraphSpec = {
    version: 1,
    id: "topology",
    name: "topology",
    nodes: [
      { kind: "agent", id: "a", prompt: "a" },
      { kind: "agent", id: "b", prompt: "b" },
    ],
    edges: [{ id: "a-b", from: "a", to: "b" }],
  };
  assert.throws(() => validateGraphSpec({ ...topology, nodes: [...topology.nodes, topology.nodes[0]] }));
  assert.throws(() => validateGraphSpec({ ...topology, edges: [{ ...topology.edges[0], to: "missing" }] }));
  assert.throws(() =>
    validateGraphSpec({
      ...topology,
      edges: [
        { id: "a-b", from: "a", to: "b" },
        { id: "a-b", from: "a", to: "b" },
      ],
    }),
  );
  assert.throws(() =>
    validateGraphSpec({
      ...topology,
      edges: [
        { id: "a-b", from: "a", to: "b" },
        { id: "b-a", from: "b", to: "a" },
      ],
    }),
  );
});

test("lifecycle and cancellation contracts remain serializable", () => {
  const snapshot = {
    runId: "run-1",
    graphId: "graph-1",
    state: "cancelled" as const,
    cancellation: { requested: true, reason: "requested" as const },
    nodes: [],
    artifacts: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
  const event: GraphLifecycleEvent = { type: "run_cancelled", runId: "run-1", snapshot };
  const rejection = {
    accepted: false as const,
    error: { code: "cancel_rejected" as const, message: "already complete" },
  };
  assert.doesNotThrow(() => JSON.stringify({ event, rejection }));
});

test("rejects incompatible predicate sources and union-only fields", () => {
  const graph = {
    version: 1,
    id: "predicate-sources",
    name: "predicate sources",
    nodes: [
      { kind: "deterministic", id: "join", operation: "join" as const },
      { kind: "agent", id: "agent", prompt: "agent" },
      { kind: "agent", id: "structured", prompt: "structured", outputs: ["structuredOutput"] as const },
    ],
    edges: [
      {
        id: "join-agent",
        from: "join",
        to: "agent",
        route: {
          kind: "predicate" as const,
          predicate: {
            type: "finalText" as const,
            regex: { source: "finalText" as const, pattern: "pass" },
          },
        },
      },
      { id: "join-structured", from: "join", to: "structured", route: { kind: "otherwise" as const } },
    ],
  };
  assert.throws(() => validateGraphSpec(graph));
  const jsonPredicate = {
    type: "json" as const,
    predicate: { source: "json" as const, path: "/verdict", equals: "pass" },
  };
  const jsonGraph = {
    ...reviewGraph(false),
    edges: reviewGraph(false).edges.map((edge) =>
      edge.id === "review-pass" ? { ...edge, route: { kind: "predicate" as const, predicate: jsonPredicate } } : edge,
    ),
  };
  assert.throws(() => validateGraphSpec(jsonGraph));
  assert.doesNotThrow(() =>
    validateGraphSpec({
      ...jsonGraph,
      nodes: jsonGraph.nodes.map((node) =>
        node.id === "review-1" ? { ...node, outputs: ["structuredOutput"] as const } : node,
      ),
    }),
  );
  assert.throws(() =>
    validateGraphSpec({
      ...graph,
      edges: graph.edges.map((edge) =>
        edge.id === "join-agent"
          ? { ...edge, route: { ...edge.route, predicate: { ...edge.route.predicate, predicate: {} } } }
          : edge,
      ),
    }),
  );
  assert.throws(() =>
    validateGraphSpec({
      ...reviewGraph(false),
      nodes: reviewGraph(false).nodes.map((node) =>
        node.id === "review-1" ? { ...node, role: "missing-role" } : node,
      ),
    }),
  );
  assert.throws(() => validateGraphSpec({ ...reviewGraph(false), roles: undefined }));
  assert.throws(() =>
    validateGraphSpec({
      ...reviewGraph(false),
      nodes: reviewGraph(false).nodes.map((node) => (node.id === "implementation" ? { ...node, modle: "typo" } : node)),
    }),
  );
  assert.throws(() =>
    validateGraphSpec({
      ...reviewGraph(false),
      nodes: reviewGraph(false).nodes.map((node) =>
        node.id === "implementation" ? { ...node, thinkingLevel: "high" } : node,
      ),
    }),
  );
});

test("resolves every model and thinking precedence level independently", () => {
  const modelSources = [
    ["node", { node: { model: { provider: "node", modelId: "m" } } }],
    ["role", { role: { model: { provider: "role", modelId: "m" } } }],
    ["workflow", { workflow: { model: { provider: "workflow", modelId: "m" } } }],
    ["parent", {}],
  ] as const;
  for (const [source, overrides] of modelSources) {
    const resolved = resolveExecutionContext({
      ...overrides,
      parent,
      workflow: source === "parent" ? undefined : { model: { provider: "workflow", modelId: "m" } },
    });
    assert.equal(resolved.modelSource, source);
  }
  const thinkingSources = [
    ["node", { node: { thinking: "high" as const } }],
    ["role", { role: { thinking: "high" as const } }],
    ["workflow", { workflow: { thinking: "low" as const } }],
    ["parent", {}],
  ] as const;
  for (const [source, overrides] of thinkingSources) {
    const resolved = resolveExecutionContext({
      ...overrides,
      parent,
      workflow: source === "parent" ? undefined : { thinking: "low" },
    });
    assert.equal(resolved.thinkingSource, source);
  }
});

test("resolves model and thinking independently with explicit parent context", () => {
  const resolved = resolveExecutionContext({
    node: { model: { provider: "node", modelId: "m" } },
    role: { thinking: "high" },
    workflow: { model: { provider: "workflow", modelId: "m" }, thinking: "low" },
    parent,
  });
  assert.deepEqual(resolved.model, { provider: "node", modelId: "m" });
  assert.equal(resolved.thinking, "high");
  assert.equal(resolved.modelSource, "node");
  assert.equal(resolved.thinkingSource, "role");
  assert.throws(
    () => resolveExecutionContext({ parent: { thinking: "medium" } as never }),
    (error: unknown) => error instanceof GraphContractError && error.code === "missing_parent_model",
  );
  assert.throws(
    () => getInvokingParentContext({ getModel: () => undefined, getThinkingLevel: () => "medium" }),
    /did not provide a model/,
  );
});

test("preflight requires a registry and rejects an unavailable explicit selector", () => {
  assert.throws(
    () => validateGraphPreflight(reviewGraph(false), parent),
    (error: unknown) => error instanceof GraphContractError && error.code === "missing_model_registry",
  );
  const base = reviewGraph(false);
  const graph = {
    ...base,
    nodes: base.nodes.map((node) =>
      node.id === "implementation" ? { ...node, model: { provider: "missing", modelId: "model" } } : node,
    ),
  } as GraphSpec;
  const registry = {
    find: (provider: string, modelId: string) =>
      provider === "test" && modelId === "parent" ? { provider, id: modelId } : undefined,
  };
  assert.throws(
    () => validateGraphPreflight(graph, parent, registry),
    (error: unknown) => error instanceof GraphContractError && error.code === "model_unavailable",
  );
});

test("bounds finalText artifacts", () => {
  assert.throws(() =>
    createArtifact({
      id: "too-long",
      nodeId: "review-1",
      value: null,
      finalText: "x".repeat(MAX_FINAL_TEXT_INPUT_LENGTH + 1),
    }),
  );
});

test("deterministic artifacts hand off only their value", () => {
  const artifact = createDeterministicArtifact({ id: "join-output", nodeId: "join", value: { ok: true } });
  assert.deepEqual(artifact.value, { ok: true });
  assert.equal(Object.hasOwn(artifact, "structuredOutput"), false);
  assert.equal(Object.isFrozen(artifact), true);
  assert.equal(
    validateGraphSpec({
      version: 1,
      id: "deterministic-handoff",
      name: "deterministic handoff",
      nodes: [
        { kind: "deterministic", id: "join", operation: "join" },
        {
          kind: "deterministic",
          id: "publish",
          operation: "publish",
          inputArtifacts: [{ nodeId: "join", output: "value" }],
        },
      ],
      edges: [{ id: "join-publish", from: "join", to: "publish" }],
    }).nodes.length,
    2,
  );
});

test("artifacts are detached and immutable, including usage", () => {
  const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
  const artifact = createArtifact({
    id: "review-output",
    nodeId: "review-1",
    value: { verdict: "pass" },
    finalText: "<verdict>pass</verdict>",
    usage,
  });
  assert.equal(Object.isFrozen(artifact), true);
  assert.equal(Object.isFrozen(artifact.value), true);
  assert.equal(Object.isFrozen(usage), false);
  usage.totalTokens = 99;
  assert.equal(artifact.usage?.totalTokens, 3);
  assert.throws(() => ((artifact.value as { verdict: string }).verdict = "fail"), TypeError);
});

test("validates typed artifact handoffs and strict ancestry", () => {
  const valid: GraphSpec = {
    version: 1,
    id: "handoff",
    name: "handoff",
    nodes: [
      { kind: "agent", id: "producer", prompt: "produce" },
      {
        kind: "agent",
        id: "consumer",
        prompt: "consume",
        inputArtifacts: [{ nodeId: "producer", output: "finalText" }],
      },
    ],
    edges: [{ id: "producer-consumer", from: "producer", to: "consumer" }],
  };
  assert.equal(validateGraphSpec(valid).nodes.length, 2);
  assert.throws(
    () =>
      validateGraphSpec({
        ...valid,
        nodes: valid.nodes.map((node) => (node.id === "consumer" ? { ...node, inputArtifacts: ["producer"] } : node)),
      }),
    (error: unknown) => error instanceof GraphContractError && error.code === "invalid_graph",
  );
  assert.throws(
    () =>
      validateGraphSpec({
        ...valid,
        nodes: valid.nodes.map((node) =>
          node.id === "consumer" ? { ...node, inputArtifacts: [{ nodeId: "consumer", output: "finalText" }] } : node,
        ),
      }),
    (error: unknown) => error instanceof GraphContractError && error.code === "invalid_graph",
  );
});
