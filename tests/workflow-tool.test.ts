import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWorkflowTool } from "../src/workflow-tool.js";

function context(sendMessage: () => void): ExtensionContext {
  return {
    cwd: process.cwd(),
    model: { provider: "test", id: "parent" },
    modelRegistry: { find: () => undefined },
    ui: { setWidget() {}, setStatus() {}, notify() {} },
    hasUI: true,
    signal: undefined,
    sendMessage,
    sendUserMessage() {},
  } as unknown as ExtensionContext;
}

const script = `export const meta = { name: 'tool_boundary', description: 'Tool boundary' }
const answer = await agent('answer', { label: 'answer' })
return args`;
const resultScript = `export const meta = { name: 'tool_boundary_result', description: 'Tool boundary result' }
const answer = await agent('answer', { label: 'answer' })
return { answer }`;

test("createWorkflowTool describes phases as optional and dynamic", () => {
  const tool = createWorkflowTool();

  assert.match(tool.promptSnippet ?? "", /export const meta = \{ name: 'short_snake_case', description:/);
  assert.doesNotMatch(tool.promptSnippet ?? "", /phases: \[/);
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("meta.phases is optional metadata")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Phase names may be conditional or built in a loop")));
});

test("legacy tool exposes bounded final results in content, updates, and renderer without follow-up", async () => {
  let sentMessages = 0;
  const updates: any[] = [];
  const tool = createWorkflowTool({
    agent: {
      async run() {
        return "agent answer";
      },
    } as any,
  });
  const finalValue = `final-${"x".repeat(8_000)}`;
  const completed = await tool.execute(
    "call-1",
    { script, args: finalValue },
    undefined,
    (update) => updates.push(update),
    context(() => {
      sentMessages++;
    }),
  );

  const content = completed.content[0]?.type === "text" ? completed.content[0].text : "";
  assert.match(content, /Final result:/);
  assert.match(content, /… \[truncated\]/);
  assert.ok(content.length < 5_000);
  assert.ok(updates.length >= 2);
  assert.ok(updates.slice(0, -1).every((update) => !update.content[0]?.text.includes("Final result:")));
  assert.match(updates.at(-1)?.content[0]?.text ?? "", /Final result:/);

  const rendered = tool.renderResult?.(
    completed,
    { isPartial: false, expanded: false },
    {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    } as any,
    undefined as any,
  );
  assert.ok(rendered);
  assert.match(rendered.render(10_000).join("\n"), /Final result:/);
  assert.equal(sentMessages, 0);
});

test("legacy tool marks blank injected agent output as null/error, not done", async () => {
  const updates: any[] = [];
  const tool = createWorkflowTool({
    agent: {
      async run() {
        return " \n ";
      },
    } as any,
  });
  const completed = await tool.execute(
    "call-blank",
    { script: resultScript, args: "unused" },
    undefined,
    (update) => updates.push(update),
    context(() => {}),
  );
  const snapshot = completed.details as {
    agents: Array<{ status: string }>;
    result: { answer: null };
    errorCount: number;
    doneCount: number;
  };

  assert.equal(snapshot.result.answer, null);
  assert.equal(snapshot.errorCount, 1);
  assert.equal(snapshot.doneCount, 0);
  assert.equal(snapshot.agents[0]?.status, "error");
  assert.match(updates.at(-1)?.content[0]?.text ?? "", /1 errors/);
});
