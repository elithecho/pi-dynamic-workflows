/**
 * v1 graph script DSL compiler (ADR 0002).
 *
 * Parses a restrictive declarative JavaScript surface with acorn and interprets
 * the AST directly (user code is never evaluated). Graph construction is
 * delegated to the stable `compileGraphDefinition` API; the frozen `GraphSpec`
 * and `GraphContractError` types in `graph.ts` are used but never modified.
 */

import type {
  ArrayExpression,
  CallExpression,
  ExportNamedDeclaration,
  Expression,
  ExpressionStatement,
  Identifier,
  Literal,
  MemberExpression,
  Node,
  ObjectExpression,
  Program,
  SpreadElement,
  TemplateLiteral,
  VariableDeclaration,
  VariableDeclarator,
} from "acorn";
import { parse } from "acorn";
import type { GraphBudgets, GraphSpec, GraphThinkingLevel, JsonValue, ModelSelector } from "./graph.js";
import { GraphContractError } from "./graph.js";
import type { GraphDefinition, GraphDefinitionNode, GraphDefinitionRoute } from "./graph-definition.js";
import { compileGraphDefinition } from "./graph-definition.js";

export class GraphScriptError extends Error {
  readonly code: string;
  readonly loc?: { line: number; column: number };

  constructor(code: string, message: string, loc?: { line: number; column: number }, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GraphScriptError";
    this.code = code;
    this.loc = loc;
  }
}

/** Opaque compiler-owned handle for a declared agent binding. */
interface Handle {
  readonly nodeId: string;
}

type StaticValue = { kind: "json"; value: JsonValue } | { kind: "regex"; pattern: string; flags: string | undefined };

interface RawLiteral extends Literal {
  readonly regex?: { pattern: string; flags: string };
  readonly bigint?: string;
}

const GLOBAL_NAMES = new Set(["agent", "budget"]);
const META_KEYS = new Set(["name", "description", "id"]);
const AGENT_OPT_KEYS = new Set(["role", "model", "thinking"]);
const MODEL_KEYS = new Set(["provider", "modelId"]);
const BUDGET_KEYS = new Set(["maxConcurrency", "maxAttempts", "maxInputTokens", "maxOutputTokens", "maxCost"]);
const META_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const WRAPPED_CONTRACT_CODES = new Set([
  "invalid_regex",
  "invalid_model_selector",
  "invalid_thinking_level",
  "invalid_graph",
]);
const FORBIDDEN_STATEMENT_KINDS = new Set([
  "ReturnStatement",
  "ForStatement",
  "WhileStatement",
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "FunctionDeclaration",
  "ImportDeclaration",
  "ClassDeclaration",
]);

function nodeStart(node: Node): { line: number; column: number } | undefined {
  const start = (node as { loc?: { start?: { line: number; column: number } } | null }).loc?.start;
  return start === undefined ? undefined : { line: start.line, column: start.column };
}

function isGlobalCall(node: Node, name: string): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = (node as CallExpression).callee;
  return callee.type === "Identifier" && callee.name === name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compile a v1 declarative graph script into a frozen GraphSpec. */
export function compileGraphScript(script: string): GraphSpec {
  let program: Program;
  try {
    program = parse(script, { ecmaVersion: "latest", sourceType: "module", locations: true });
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (typeof error === "object" && error !== null && (error as { name?: string }).name === "SyntaxError")
    ) {
      const syntaxError = error as SyntaxError & { loc?: { line: number; column: number } };
      const parseLoc =
        syntaxError.loc === undefined ? undefined : { line: syntaxError.loc.line, column: syntaxError.loc.column };
      throw new GraphScriptError("script_not_declarative", syntaxError.message, parseLoc, { cause: error });
    }
    throw error;
  }
  return new Compiler(program.body as readonly Node[]).compile();
}

class Compiler {
  private readonly declaredAt = new Map<string, number>();
  private readonly handles = new Map<string, Handle>();
  private readonly nodes: GraphDefinitionNode[] = [];
  private readonly routes: GraphDefinitionRoute[] = [];
  private budgets: GraphBudgets | undefined;
  private budgetSeen = false;
  private metaId: string | undefined;
  private metaName = "";
  private lastLoc: { line: number; column: number } | undefined;

  constructor(private readonly body: readonly Node[]) {}

  compile(): GraphSpec {
    const first = this.body[0];
    if (first === undefined) {
      throw new GraphScriptError("script_meta_required", "script must begin with export const meta = { ... }", {
        line: 1,
        column: 0,
      });
    }
    this.lastLoc = nodeStart(first);
    this.collectDeclarations();
    this.parseMeta(first);
    for (let index = 1; index < this.body.length; index += 1) {
      const statement = this.body[index];
      this.lastLoc = nodeStart(statement);
      this.processStatement(statement, index);
    }
    const definition: GraphDefinition = {
      ...(this.metaId === undefined ? {} : { id: this.metaId }),
      name: this.metaName,
      nodes: this.nodes,
      routes: this.routes,
      ...(this.budgets === undefined ? {} : { budgets: this.budgets }),
    };
    try {
      return compileGraphDefinition(definition);
    } catch (error) {
      if (error instanceof GraphContractError && WRAPPED_CONTRACT_CODES.has(error.code)) {
        throw new GraphScriptError(error.code, error.message, this.lastLoc, { cause: error });
      }
      throw error;
    }
  }

  /** Binding pass: record the program position of every `const x = agent(...)`. */
  private collectDeclarations(): void {
    for (let index = 1; index < this.body.length; index += 1) {
      const statement = this.body[index];
      if (statement.type !== "VariableDeclaration") continue;
      const declaration = statement as VariableDeclaration;
      if (declaration.kind !== "const" || declaration.declarations.length !== 1) continue;
      const declarator = declaration.declarations[0];
      if (declarator.id.type !== "Identifier") continue;
      if (declarator.init == null || !isGlobalCall(declarator.init, "agent")) continue;
      this.declaredAt.set(declarator.id.name, index);
    }
  }

  /** Validate the mandatory first statement: `export const meta = { ... }`. */
  private parseMeta(statement: Node): void {
    if (statement.type !== "ExportNamedDeclaration") {
      throw new GraphScriptError(
        "script_meta_required",
        "the first statement must be export const meta = { name, description, id? }",
        nodeStart(statement),
      );
    }
    const exportDeclaration = statement as ExportNamedDeclaration;
    const declaration = exportDeclaration.declaration;
    if (declaration == null || declaration.type !== "VariableDeclaration") {
      throw new GraphScriptError(
        "script_meta_required",
        "meta must be declared as export const meta = { ... }",
        nodeStart(statement),
      );
    }
    const variable = declaration as VariableDeclaration;
    if (variable.kind !== "const" || variable.declarations.length !== 1) {
      throw new GraphScriptError(
        "script_meta_required",
        "meta must be declared as export const meta = { ... }",
        nodeStart(statement),
      );
    }
    const declarator = variable.declarations[0];
    if (declarator.id.type !== "Identifier" || declarator.id.name !== "meta") {
      throw new GraphScriptError("script_meta_required", "the first statement must declare meta", nodeStart(statement));
    }
    const init = declarator.init;
    if (init == null || init.type !== "ObjectExpression") {
      throw new GraphScriptError(
        "script_meta_not_literal",
        "meta must be a static object literal",
        nodeStart(init ?? statement),
      );
    }
    const meta: Record<string, JsonValue> = {};
    const seen = new Set<string>();
    for (const property of (init as ObjectExpression).properties) {
      if (property.type !== "Property" || property.computed || property.method || property.kind !== "init") {
        throw new GraphScriptError(
          "script_meta_not_literal",
          "meta properties must be static key/value pairs",
          nodeStart(property),
        );
      }
      const key = this.staticKeyName(property.key);
      if (key === undefined) {
        throw new GraphScriptError(
          "script_meta_not_literal",
          "meta keys must be identifiers or string literals",
          nodeStart(property.key),
        );
      }
      if (seen.has(key)) {
        throw new GraphScriptError("script_meta_not_literal", `duplicate meta key ${key}`, nodeStart(property));
      }
      seen.add(key);
      if (!META_KEYS.has(key)) {
        throw new GraphScriptError("script_unknown_option", `unknown meta option ${key}`, nodeStart(property));
      }
      let value: StaticValue;
      try {
        value = this.evaluateStatic(property.value, { allowRegex: false });
      } catch (error) {
        if (error instanceof GraphScriptError) {
          throw new GraphScriptError(
            "script_meta_not_literal",
            `meta value for ${key} is not static`,
            nodeStart(property.value),
            { cause: error },
          );
        }
        throw error;
      }
      if (value.kind !== "json") {
        throw new GraphScriptError(
          "script_meta_not_literal",
          `meta value for ${key} is not static`,
          nodeStart(property.value),
        );
      }
      meta[key] = value.value;
    }
    const name = meta.name;
    const description = meta.description;
    if (name === undefined || description === undefined) {
      throw new GraphScriptError("script_meta_required", "meta requires name and description", nodeStart(statement));
    }
    if (typeof name !== "string" || name.length === 0 || typeof description !== "string" || description.length === 0) {
      throw new GraphScriptError(
        "script_meta_not_literal",
        "meta name and description must be non-empty strings",
        nodeStart(statement),
      );
    }
    const id = meta.id;
    if (id !== undefined) {
      if (typeof id !== "string" || !META_ID_PATTERN.test(id)) {
        throw new GraphScriptError(
          "script_meta_not_literal",
          "meta id must match [A-Za-z][A-Za-z0-9_-]{0,63}",
          nodeStart(statement),
        );
      }
      this.metaId = id;
    }
    this.metaName = name;
  }

  /** Allowlist pass over the remaining top-level statements. */
  private processStatement(statement: Node, index: number): void {
    if (statement.type === "VariableDeclaration") {
      const declaration = statement as VariableDeclaration;
      if (
        declaration.kind === "const" &&
        declaration.declarations.length === 1 &&
        declaration.declarations[0].id.type === "Identifier" &&
        declaration.declarations[0].init != null &&
        isGlobalCall(declaration.declarations[0].init, "agent")
      ) {
        this.processAgentDeclaration(declaration.declarations[0]);
        return;
      }
      this.rejectStatement(statement);
      return;
    }
    if (statement.type === "ExpressionStatement") {
      const expression = (statement as ExpressionStatement).expression;
      if (expression.type !== "CallExpression") {
        this.rejectStatement(statement);
        return;
      }
      const call = expression as CallExpression;
      if (call.optional === true) {
        this.rejectStatement(statement);
        return;
      }
      if (call.callee.type === "Identifier") {
        if (call.callee.name === "budget") {
          this.processBudget(call);
          return;
        }
        this.rejectStatement(statement);
        return;
      }
      if (call.callee.type !== "MemberExpression") {
        this.rejectStatement(statement);
        return;
      }
      const member = call.callee as MemberExpression;
      if (member.computed || member.optional === true || member.property.type !== "Identifier") {
        this.rejectStatement(statement);
        return;
      }
      if (member.property.name === "to") {
        this.processTo(statement, member, index);
        return;
      }
      if (member.property.name === "otherwise") {
        this.processWhenOtherwise(statement, member, index);
        return;
      }
      this.rejectStatement(statement);
      return;
    }
    this.rejectStatement(statement);
  }

  /** Form (b): `<handle>.to(<handle>)` — an always edge. */
  private processTo(statement: Node, member: MemberExpression, index: number): void {
    if (member.object.type !== "Identifier") {
      this.rejectStatement(statement);
      return;
    }
    const call = (statement as ExpressionStatement).expression as CallExpression;
    if (call.arguments.length !== 1) {
      this.rejectStatement(statement);
      return;
    }
    const source = this.resolveHandle(member.object, index);
    const argument = call.arguments[0];
    if (argument.type !== "Identifier") {
      this.rejectStatement(statement);
      return;
    }
    const target = this.resolveHandle(argument, index);
    this.routes.push({ from: source.nodeId, to: target.nodeId });
  }

  /** Form (c): `<handle>.when(<regex>, <handle>).otherwise(<handle>)` — predicate + fallback edges. */
  private processWhenOtherwise(statement: Node, member: MemberExpression, index: number): void {
    const call = (statement as ExpressionStatement).expression as CallExpression;
    if (call.arguments.length !== 1) {
      this.rejectStatement(statement);
      return;
    }
    const inner = member.object;
    if (inner.type !== "CallExpression") {
      this.rejectStatement(statement);
      return;
    }
    const innerCall = inner as CallExpression;
    if (innerCall.optional === true) {
      this.rejectStatement(statement);
      return;
    }
    if (innerCall.callee.type !== "MemberExpression") {
      this.rejectStatement(statement);
      return;
    }
    const innerMember = innerCall.callee as MemberExpression;
    if (
      innerMember.computed ||
      innerMember.optional === true ||
      innerMember.property.type !== "Identifier" ||
      innerMember.property.name !== "when"
    ) {
      this.rejectStatement(statement);
      return;
    }
    if (innerMember.object.type !== "Identifier") {
      this.rejectStatement(statement);
      return;
    }
    if (innerCall.arguments.length !== 2) {
      this.rejectStatement(statement);
      return;
    }
    const source = this.resolveHandle(innerMember.object, index);
    const regexArgument = innerCall.arguments[0];
    const regexValue = this.evaluateStatic(this.asExpression(regexArgument), { allowRegex: true });
    let pattern: string;
    let flags: string | undefined;
    if (regexValue.kind === "regex") {
      pattern = regexValue.pattern;
      flags = regexValue.flags;
    } else if (typeof regexValue.value === "string") {
      pattern = regexValue.value;
      flags = undefined;
    } else {
      this.rejectNonStatic(regexArgument, "when() pattern must be a static string or RegExp literal");
      return;
    }
    const whenArgument = innerCall.arguments[1];
    if (whenArgument.type !== "Identifier") {
      this.rejectStatement(statement);
      return;
    }
    const whenTarget = this.resolveHandle(whenArgument, index);
    const otherwiseArgument = call.arguments[0];
    if (otherwiseArgument.type !== "Identifier") {
      this.rejectStatement(statement);
      return;
    }
    const otherwiseTarget = this.resolveHandle(otherwiseArgument, index);
    this.routes.push({
      from: source.nodeId,
      to: whenTarget.nodeId,
      when: pattern,
      ...(flags === undefined ? {} : { flags }),
    });
    this.routes.push({ from: source.nodeId, to: otherwiseTarget.nodeId, otherwise: true });
  }

  /** Form (d): `budget({ ... })` — at most one call. */
  private processBudget(call: CallExpression): void {
    if (this.budgetSeen) {
      throw new GraphScriptError("script_duplicate_budget", "budget() may be called at most once", nodeStart(call));
    }
    this.budgetSeen = true;
    if (call.arguments.length !== 1) {
      this.rejectNonStatic(call, "budget() requires exactly one static object argument");
      return;
    }
    const argument = call.arguments[0];
    const value = this.evaluateStatic(this.asExpression(argument), { allowRegex: false });
    if (value.kind !== "json" || !isRecord(value.value)) {
      this.rejectNonStatic(argument, "budget() argument must be a static object");
      return;
    }
    for (const key of Object.keys(value.value)) {
      if (!BUDGET_KEYS.has(key)) {
        throw new GraphScriptError("script_unknown_option", `unknown budget option ${key}`, nodeStart(argument));
      }
    }
    this.budgets = value.value as GraphBudgets;
  }

  /** Form (a): `const <id> = agent(<prompt>, <opts>?)` — declares an agent node. */
  private processAgentDeclaration(declarator: VariableDeclarator): void {
    const idNode = declarator.id as Identifier;
    const call = declarator.init as CallExpression;
    if (call.optional === true) {
      throw new GraphScriptError(
        "script_not_declarative",
        "agent declarations must not use optional calls",
        nodeStart(call),
      );
    }
    if (call.arguments.length < 1 || call.arguments.length > 2) {
      this.rejectNonStatic(call, "agent() requires a static prompt and an optional static options object");
      return;
    }
    const promptArgument = call.arguments[0];
    const promptValue = this.evaluateStatic(this.asExpression(promptArgument), { allowRegex: false });
    if (promptValue.kind !== "json" || typeof promptValue.value !== "string") {
      this.rejectNonStatic(promptArgument, "agent() prompt must be a static string");
      return;
    }
    let opts: Record<string, unknown> | undefined;
    if (call.arguments.length === 2) {
      const optsArgument = call.arguments[1];
      const optsValue = this.evaluateStatic(this.asExpression(optsArgument), { allowRegex: false });
      if (optsValue.kind !== "json" || !isRecord(optsValue.value)) {
        this.rejectNonStatic(optsArgument, "agent() options must be a static object");
        return;
      }
      for (const key of Object.keys(optsValue.value)) {
        if (!AGENT_OPT_KEYS.has(key)) {
          throw new GraphScriptError("script_unknown_option", `unknown agent option ${key}`, nodeStart(optsArgument));
        }
      }
      const model = optsValue.value.model;
      if (isRecord(model)) {
        for (const key of Object.keys(model)) {
          if (!MODEL_KEYS.has(key)) {
            throw new GraphScriptError("script_unknown_option", `unknown model option ${key}`, nodeStart(optsArgument));
          }
        }
      }
      opts = optsValue.value;
    }
    this.handles.set(idNode.name, { nodeId: idNode.name });
    this.nodes.push({
      id: idNode.name,
      prompt: promptValue.value,
      ...(opts?.role !== undefined ? { role: opts.role as string } : {}),
      ...(opts?.model !== undefined ? { model: opts.model as ModelSelector } : {}),
      ...(opts?.thinking !== undefined ? { thinking: opts.thinking as GraphThinkingLevel } : {}),
    });
  }

  /** Resolve a handle identifier used in handle position against program order. */
  private resolveHandle(node: Identifier, index: number): Handle {
    const declaredAt = this.declaredAt.get(node.name);
    if (declaredAt === undefined) {
      throw new GraphScriptError("script_unknown_identifier", `unknown identifier ${node.name}`, nodeStart(node));
    }
    if (declaredAt > index) {
      throw new GraphScriptError(
        "script_use_before_declaration",
        `handle ${node.name} is used before its declaration`,
        nodeStart(node),
      );
    }
    const handle = this.handles.get(node.name);
    if (handle === undefined) {
      throw new GraphScriptError("script_unknown_identifier", `unknown identifier ${node.name}`, nodeStart(node));
    }
    return handle;
  }

  /** Reject a statement that is not one of the allowed declarative forms. */
  private rejectStatement(statement: Node): never {
    if (FORBIDDEN_STATEMENT_KINDS.has(statement.type)) {
      throw new GraphScriptError(
        "script_not_declarative",
        `statement kind ${statement.type} is not allowed`,
        nodeStart(statement),
      );
    }
    const unknown = this.findUnknownIdentifier(statement);
    if (unknown !== undefined) {
      throw new GraphScriptError(
        "script_unknown_identifier",
        `unknown identifier ${unknown.name}`,
        nodeStart(unknown.node),
      );
    }
    throw new GraphScriptError(
      "script_not_declarative",
      "statement is not one of the supported declarative forms",
      nodeStart(statement),
    );
  }

  /** Shallow scan for unknown global identifiers in a rejected expression statement. */
  private findUnknownIdentifier(statement: Node): { name: string; node: Identifier } | undefined {
    if (statement.type !== "ExpressionStatement") return undefined;
    const expression = (statement as ExpressionStatement).expression;
    if (expression.type === "Identifier") {
      return this.unknownOf(expression);
    }
    if (expression.type === "CallExpression") {
      const callee = (expression as CallExpression).callee;
      if (callee.type === "Identifier") return this.unknownOf(callee);
      if (callee.type === "MemberExpression" && !callee.computed) {
        const object = callee.object;
        if (object.type === "Identifier") return this.unknownOf(object);
      }
      return undefined;
    }
    if (expression.type === "MemberExpression" && !expression.computed) {
      const object = expression.object;
      if (object.type === "Identifier") return this.unknownOf(object);
    }
    return undefined;
  }

  private unknownOf(node: Identifier): { name: string; node: Identifier } | undefined {
    if (GLOBAL_NAMES.has(node.name) || this.declaredAt.has(node.name)) return undefined;
    return { name: node.name, node };
  }

  /** Static-argument evaluator: literal data only, nothing is ever evaluated. */
  private evaluateStatic(node: Expression, options: { allowRegex: boolean }): StaticValue {
    switch (node.type) {
      case "Identifier":
        this.rejectNonStatic(node, "identifiers are not static values");
        break;
      case "Literal": {
        const literal = node as RawLiteral;
        if (literal.regex !== undefined) {
          if (!options.allowRegex) {
            this.rejectNonStatic(node, "RegExp literals are only allowed as when() patterns");
          }
          const flags = literal.regex.flags;
          if (flags !== "" && flags !== "i") {
            this.rejectNonStatic(node, `unsupported RegExp flags ${flags}`);
          }
          return { kind: "regex", pattern: literal.regex.pattern, flags: flags === "" ? undefined : "i" };
        }
        if (literal.bigint !== undefined) {
          this.rejectNonStatic(node, "bigint literals are not allowed");
        }
        const value = literal.value;
        if (typeof value === "number") {
          if (!Number.isFinite(value)) this.rejectNonStatic(node, "numbers must be finite");
          return { kind: "json", value };
        }
        if (typeof value === "string") return { kind: "json", value };
        if (typeof value === "boolean") return { kind: "json", value };
        if (value === null) return { kind: "json", value: null };
        this.rejectNonStatic(node, "this literal type is not a static value");
        break;
      }
      case "TemplateLiteral": {
        const template = node as TemplateLiteral;
        if (template.expressions.length > 0) {
          this.rejectNonStatic(node, "template interpolation is not allowed");
        }
        const quasi = template.quasis[0];
        return { kind: "json", value: quasi.value.cooked ?? quasi.value.raw };
      }
      case "ArrayExpression": {
        const array = node as ArrayExpression;
        const elements: JsonValue[] = [];
        for (const element of array.elements) {
          if (element === null || element.type === "SpreadElement") {
            this.rejectNonStatic(element ?? node, "spread elements are not allowed");
          }
          const value = this.evaluateStatic(element, { allowRegex: false });
          if (value.kind === "regex") {
            this.rejectNonStatic(element, "RegExp literals are only allowed as when() patterns");
          }
          elements.push(value.value);
        }
        return { kind: "json", value: elements };
      }
      case "ObjectExpression": {
        const object = node as ObjectExpression;
        const record: Record<string, JsonValue> = {};
        const seen = new Set<string>();
        for (const property of object.properties) {
          if (property.type !== "Property") {
            this.rejectNonStatic(property, "spread elements are not allowed");
          }
          if (property.computed) {
            this.rejectNonStatic(property.key, "computed keys are not allowed");
          }
          if (property.method || property.kind !== "init") {
            this.rejectNonStatic(property, "object methods are not static values");
          }
          const key = this.staticKeyName(property.key);
          if (key === undefined) {
            this.rejectNonStatic(property.key, "object keys must be identifiers or string literals");
          }
          if (seen.has(key)) {
            this.rejectNonStatic(property, `duplicate object key ${key}`);
          }
          seen.add(key);
          const value = this.evaluateStatic(property.value, { allowRegex: false });
          if (value.kind === "regex") {
            this.rejectNonStatic(property.value, "RegExp literals are only allowed as when() patterns");
          }
          record[key] = value.value;
        }
        return { kind: "json", value: record };
      }
      default:
        this.rejectNonStatic(node, `${node.type} is not a static value`);
    }
    throw new GraphScriptError("script_non_static_argument", "unreachable", undefined);
  }

  private asExpression(node: Expression | SpreadElement): Expression {
    if (node.type === "SpreadElement") {
      this.rejectNonStatic(node, "spread elements are not allowed");
    }
    return node;
  }

  private staticKeyName(key: Expression): string | undefined {
    if (key.type === "Identifier") return key.name;
    if (key.type === "Literal") {
      const value = (key as RawLiteral).value;
      if (typeof value === "string") return value;
      if (typeof value === "number") return String(value);
    }
    return undefined;
  }

  private rejectNonStatic(node: Node, message: string): never {
    throw new GraphScriptError("script_non_static_argument", message, nodeStart(node));
  }
}
