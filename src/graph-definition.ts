/**
 * Generic graph definition compiler: a concise `nodes`/`routes` shape that
 * compiles into the frozen GraphSpec contract. Routes are either bare (always),
 * `when` (a finalText predicate over the source node's output), or `otherwise`
 * (the fallback). Targets with more than one distinct source are auto-joined
 * through a deterministic join node.
 */
import {
  type ArtifactRef,
  type ExecutionDefaults,
  GRAPH_CONTRACT_VERSION,
  type GraphBudgets,
  GraphContractError,
  type GraphEdge,
  type GraphNode,
  type GraphRoute,
  type GraphSpec,
  type GraphThinkingLevel,
  type ModelSelector,
  validateGraphSpec,
} from "./graph.js";

export interface GraphDefinitionNode {
  readonly id: string;
  readonly prompt: string;
  readonly role?: string;
  readonly model?: ModelSelector;
  readonly thinking?: GraphThinkingLevel;
}

export interface GraphDefinitionRoute {
  readonly from: string;
  readonly to: string;
  /** Regex over the source node's finalText; when matched, this edge fires. */
  readonly when?: string;
  /** Optional regex flags; only "i" supported. */
  readonly flags?: string;
  /** Fallback edge: fires when none of the source's `when` edges match. */
  readonly otherwise?: boolean;
}

export interface GraphDefinition {
  readonly id?: string;
  readonly name?: string;
  readonly nodes: readonly GraphDefinitionNode[];
  readonly routes: readonly GraphDefinitionRoute[];
  readonly budgets?: GraphBudgets;
}

const NODE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function contractError(message: string): never {
  throw new GraphContractError("invalid_graph", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deriveGraphId(definition: GraphDefinition): string {
  if (definition.id !== undefined) return definition.id;
  const name = definition.name;
  if (typeof name !== "string" || name.trim().length === 0) return "workflow";
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0 || !/^[a-z]/.test(slug)) return `s${slug}`;
  return slug;
}

/** Validate a generic definition, then compile it into a frozen GraphSpec. */
export function compileGraphDefinition(definition: GraphDefinition): GraphSpec {
  if (!isRecord(definition)) contractError("definition must be an object");
  if (!Array.isArray(definition.nodes) || definition.nodes.length === 0) {
    contractError("definition.nodes must be a non-empty array");
  }
  if (!Array.isArray(definition.routes)) contractError("definition.routes must be an array");

  const nodeIds = new Set<string>();
  for (const [index, node] of definition.nodes.entries()) {
    if (!isRecord(node)) contractError(`definition.nodes[${index}] must be an object`);
    const nodeId = node.id;
    if (typeof nodeId !== "string" || !NODE_ID_PATTERN.test(nodeId)) {
      contractError(`definition.nodes[${index}].id must match [A-Za-z][A-Za-z0-9_-]{0,63}`);
    }
    if (nodeIds.has(nodeId)) contractError(`duplicate node id ${nodeId}`);
    nodeIds.add(nodeId);
    if (typeof node.prompt !== "string" || node.prompt.length === 0) {
      contractError(`definition.nodes.${nodeId}.prompt must be a non-empty string`);
    }
    if (node.role !== undefined && (typeof node.role !== "string" || node.role.length === 0)) {
      contractError(`definition.nodes.${nodeId}.role must be a non-empty string`);
    }
  }

  const routes = definition.routes as readonly GraphDefinitionRoute[];
  const perSource = new Map<string, GraphDefinitionRoute[]>();
  for (const [index, route] of routes.entries()) {
    if (!isRecord(route)) contractError(`definition.routes[${index}] must be an object`);
    if (typeof route.from !== "string" || !nodeIds.has(route.from)) {
      contractError(`definition.routes[${index}].from must reference a declared node id`);
    }
    if (typeof route.to !== "string" || !nodeIds.has(route.to)) {
      contractError(`definition.routes[${index}].to must reference a declared node id`);
    }
    if (route.when !== undefined && (typeof route.when !== "string" || route.when.length === 0)) {
      contractError(`definition.routes[${index}].when must be a non-empty string`);
    }
    if (
      route.flags !== undefined &&
      (typeof route.flags !== "string" || [...route.flags].some((flag) => flag !== "i"))
    ) {
      contractError(`definition.routes[${index}].flags supports only the "i" flag`);
    }
    if (route.when !== undefined && route.otherwise === true) {
      contractError(`definition.routes[${index}] must not set both when and otherwise`);
    }
    perSource.set(route.from, [...(perSource.get(route.from) ?? []), route]);
  }
  for (const [source, sourceRoutes] of perSource) {
    const withWhen = sourceRoutes.filter((route) => route.when !== undefined);
    const withOtherwise = sourceRoutes.filter((route) => route.otherwise === true);
    const withAlways = sourceRoutes.filter((route) => route.when === undefined && route.otherwise !== true);
    if (withOtherwise.length > 1) contractError(`at most one otherwise route is allowed from ${source}`);
    if (withWhen.length > 0 && withOtherwise.length !== 1) {
      contractError(`routes with when from ${source} require exactly one otherwise fallback`);
    }
    if (withOtherwise.length > 0 && withWhen.length === 0) {
      contractError(`otherwise route from ${source} requires a when route from the same source`);
    }
    if (withWhen.length > 0 && withAlways.length > 0) {
      contractError(`when routes from ${source} cannot mix with always routes`);
    }
    if (withOtherwise.length > 0 && withAlways.length > 0) {
      contractError(`otherwise routes from ${source} cannot mix with always routes`);
    }
  }

  const sourcesByTarget = new Map<string, Set<string>>();
  for (const route of routes) {
    sourcesByTarget.set(route.to, new Set([...(sourcesByTarget.get(route.to) ?? []), route.from]));
  }
  const convergentTargets = new Set<string>();
  for (const [target, sources] of sourcesByTarget) {
    if (sources.size > 1) convergentTargets.add(target);
  }

  const edges: GraphEdge[] = [];
  const edgeIdCounts = new Map<string, number>();
  const pushEdge = (from: string, to: string, route?: GraphRoute): void => {
    const base = `${from}_to_${to}`;
    const ordinal = (edgeIdCounts.get(base) ?? 0) + 1;
    edgeIdCounts.set(base, ordinal);
    const id = ordinal === 1 ? base : `${base}_${ordinal}`;
    edges.push(route === undefined ? { id, from, to } : { id, from, to, route });
  };

  for (const route of routes) {
    const target = convergentTargets.has(route.to) ? `${route.to}_join` : route.to;
    if (route.when !== undefined) {
      pushEdge(route.from, target, {
        kind: "predicate",
        predicate: {
          type: "finalText",
          regex: {
            source: "finalText",
            pattern: route.when,
            ...(route.flags === undefined ? {} : { flags: route.flags }),
          },
        },
      });
    } else if (route.otherwise === true) {
      pushEdge(route.from, target, { kind: "otherwise" });
    } else {
      pushEdge(route.from, target);
    }
  }

  const inputArtifactsFor = (node: GraphDefinitionNode): ArtifactRef[] | undefined => {
    const sources = sourcesByTarget.get(node.id);
    if (sources === undefined || sources.size === 0) return undefined;
    if (convergentTargets.has(node.id)) return [{ nodeId: `${node.id}_join`, output: "value" }];
    const source = [...sources][0];
    return source === undefined ? undefined : [{ nodeId: source, output: "finalText" }];
  };

  const agentNodes: GraphNode[] = definition.nodes.map((node) => {
    const inputArtifacts = inputArtifactsFor(node);
    return {
      kind: "agent",
      id: node.id,
      prompt: node.prompt,
      ...(node.role === undefined ? {} : { role: node.role }),
      ...(node.model === undefined ? {} : { model: node.model }),
      ...(node.thinking === undefined ? {} : { thinking: node.thinking }),
      ...(inputArtifacts === undefined ? {} : { inputArtifacts }),
    };
  });

  const joinNodes: GraphNode[] = [];
  for (const node of definition.nodes) {
    if (convergentTargets.has(node.id)) {
      joinNodes.push({ kind: "deterministic", id: `${node.id}_join`, operation: "join" });
      pushEdge(`${node.id}_join`, node.id);
    }
  }

  const roles: Record<string, ExecutionDefaults> = {};
  for (const node of definition.nodes) {
    if (node.role !== undefined && !Object.hasOwn(roles, node.role)) roles[node.role] = {};
  }

  const graph: GraphSpec = {
    version: GRAPH_CONTRACT_VERSION,
    id: deriveGraphId(definition),
    name: definition.name ?? "Workflow",
    nodes: [...agentNodes, ...joinNodes],
    edges,
    ...(Object.keys(roles).length === 0 ? {} : { roles }),
    ...(definition.budgets === undefined ? {} : { budgets: definition.budgets }),
  };
  return validateGraphSpec(graph);
}
