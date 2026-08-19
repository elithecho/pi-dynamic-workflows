/**
 * Staged-review workflows expressed as a thin layer over the generic graph
 * definition compiler: Implementation → Review 1 → (pass | otherwise
 * Remediation → Review 2 …) → final verification, with `rounds` bounding the
 * remediation cycles. Convergence onto the final verification is auto-joined
 * by the generic compiler (`final_verification_join`).
 */
import {
  DEFAULT_FINAL_TEXT_PATTERN,
  type ExecutionDefaults,
  type GraphBudgets,
  GraphContractError,
  type GraphSpec,
} from "./graph.js";
import { compileGraphDefinition, type GraphDefinitionNode, type GraphDefinitionRoute } from "./graph-definition.js";

export const STAGED_WORKFLOW_MAX_ROUNDS = 3;

const DEFAULT_REMEDIATION_PROMPT = "Address every finding from the most recent review and produce a revised result.";

export interface StagedWorkflowPolicy {
  readonly id?: string;
  readonly name?: string;
  readonly rounds?: number; // integer 1..STAGED_WORKFLOW_MAX_ROUNDS, default 1
  readonly finalTextPattern?: string; // default DEFAULT_FINAL_TEXT_PATTERN
  readonly finalTextFlags?: string; // default "" (only "i" supported by contract)
  readonly implementationPrompt: string;
  readonly reviewerPrompt: string;
  readonly remediationPrompt?: string; // default DEFAULT_REMEDIATION_PROMPT
  readonly verificationPrompt: string;
  readonly roleDefaults?: Partial<Record<"implementation" | "reviewer" | "verifier", ExecutionDefaults>>;
  readonly budgets?: GraphBudgets;
}

/**
 * The dynamic review-verdict instruction, derived from the actual final-text
 * pattern and flags (never hardcoded to a tag).
 */
export function stagedReviewVerdictInstruction(
  pattern: string = DEFAULT_FINAL_TEXT_PATTERN,
  flags: string = "",
): string {
  const example = pattern.replace(/\\s\*/g, "").replace(/\\s/g, " ");
  const sensitivity = flags.includes("i") ? "case-insensitive" : "case-sensitive";
  return `Review verdict contract: approve the work by making your final message match the regex \`${pattern}\` (${sensitivity}). For example, \`${example}\` matches. Any other final message takes the non-pass route.`;
}

function contractError(message: string): never {
  throw new GraphContractError("invalid_graph", message);
}

function requirePrompt(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) contractError(`${name} must be a non-empty string`);
  return value;
}

function requireRounds(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > STAGED_WORKFLOW_MAX_ROUNDS) {
    contractError(`rounds must be an integer in [1, ${STAGED_WORKFLOW_MAX_ROUNDS}]`);
  }
  return value;
}

function requireFinalTextFlags(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") contractError("finalTextFlags must be a string");
  for (const flag of value) {
    if (flag !== "i") contractError(`finalTextFlags supports only the "i" flag, got "${flag}"`);
  }
  return value;
}

type StagedRole = "implementation" | "reviewer" | "verifier";

/** Flatten role defaults onto the nodes; the generic compiler collects the roles map. */
function roleDefaultsFor(
  role: StagedRole,
  roleDefaults: NonNullable<StagedWorkflowPolicy["roleDefaults"]>,
): Pick<ExecutionDefaults, "model" | "thinking"> {
  const defaults = roleDefaults[role];
  return {
    ...(defaults?.model === undefined ? {} : { model: defaults.model }),
    ...(defaults?.thinking === undefined ? {} : { thinking: defaults.thinking }),
  };
}

export function compileStagedWorkflowGraph(policy: StagedWorkflowPolicy): GraphSpec {
  const policyValue: unknown = policy;
  if (typeof policyValue !== "object" || policyValue === null) contractError("policy must be an object");

  const implementationPrompt = requirePrompt(policy.implementationPrompt, "implementationPrompt");
  const reviewerPrompt = requirePrompt(policy.reviewerPrompt, "reviewerPrompt");
  const verificationPrompt = requirePrompt(policy.verificationPrompt, "verificationPrompt");
  const rounds = requireRounds(policy.rounds);
  const finalTextFlags = requireFinalTextFlags(policy.finalTextFlags);
  const remediationPrompt = policy.remediationPrompt ?? DEFAULT_REMEDIATION_PROMPT;
  const pattern = policy.finalTextPattern ?? DEFAULT_FINAL_TEXT_PATTERN;

  const roleDefaults = policy.roleDefaults ?? {};
  const reviewPrompt = `${reviewerPrompt}\n\n${stagedReviewVerdictInstruction(pattern, finalTextFlags)}`;
  const defaultsFor = (role: StagedRole): Partial<GraphDefinitionNode> => roleDefaultsFor(role, roleDefaults);

  const nodes: GraphDefinitionNode[] = [
    { id: "implementation", prompt: implementationPrompt, role: "implementation", ...defaultsFor("implementation") },
  ];
  for (let round = 1; round <= rounds; round += 1) {
    nodes.push({ id: `review_${round}`, prompt: reviewPrompt, role: "reviewer", ...defaultsFor("reviewer") });
    nodes.push({
      id: `remediation_${round}`,
      prompt: remediationPrompt,
      role: "implementation",
      ...defaultsFor("implementation"),
    });
  }
  nodes.push({ id: `review_${rounds + 1}`, prompt: reviewPrompt, role: "reviewer", ...defaultsFor("reviewer") });
  nodes.push({
    id: "final_verification",
    prompt: verificationPrompt,
    role: "verifier",
    ...defaultsFor("verifier"),
  });

  const routes: GraphDefinitionRoute[] = [{ from: "implementation", to: "review_1" }];
  for (let round = 1; round <= rounds; round += 1) {
    routes.push({
      from: `review_${round}`,
      to: "final_verification",
      when: pattern,
      ...(finalTextFlags.length === 0 ? {} : { flags: finalTextFlags }),
    });
    routes.push({ from: `review_${round}`, to: `remediation_${round}`, otherwise: true });
    routes.push({ from: `remediation_${round}`, to: `review_${round + 1}` });
  }
  routes.push({ from: `review_${rounds + 1}`, to: "final_verification" });

  return compileGraphDefinition({
    ...(policy.id === undefined ? {} : { id: policy.id }),
    ...(policy.name === undefined ? {} : { name: policy.name }),
    nodes,
    routes,
    ...(policy.budgets === undefined ? {} : { budgets: policy.budgets }),
  });
}
