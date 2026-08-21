import assert from "node:assert/strict";
import test from "node:test";
import type { TSchema } from "typebox";
import type { AgentRunOptions, AgentRunResult } from "../src/agent.js";
import { runWorkflow } from "../src/workflow.js";

const fakeAgent = {
  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    _options?: AgentRunOptions<TSchemaDef>,
  ): Promise<AgentRunResult<TSchemaDef>> {
    return `result:${prompt}` as AgentRunResult<TSchemaDef>;
  },
};

test("runWorkflow marks blank unstructured agent output as a failed null branch", async () => {
  const ended: unknown[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'blank_agent', description: 'Reject blank output' }
const answer = await agent('answer', { label: 'answer' })
return { answer }`,
    {
      agent: {
        async run() {
          return "   ";
        },
      } as any,
      onAgentEnd(event) {
        ended.push(event.result);
      },
    },
  );

  assert.equal((result.result as { answer: null }).answer, null);
  assert.deepEqual(ended, [null]);
  assert.match(result.logs[0] ?? "", /no usable final response/);
});

test("runWorkflow preserves blank structured output values", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'blank_structured', description: 'Preserve structured output' }
const answer = await agent('answer', { label: 'answer', schema: { type: 'string' } })
return { answer }`,
    {
      agent: {
        async run() {
          return "   ";
        },
      } as any,
    },
  );

  assert.equal((result.result as { answer: string }).answer, "   ");
});

test("runWorkflow accepts metadata without phases and records runtime phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'dynamic_demo',
  description: 'Use runtime phases'
}

phase('Scan')
const scan = await agent('scan', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.deepEqual(result.phases, ["Scan"]);
  assert.equal(result.agentCount, 1);
  assert.equal((result.result as { scan: string }).scan, "result:scan");
});

test("runWorkflow records loop-created phases without skipped conditional phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'loop_demo',
  description: 'Create phases from work items',
  phases: [{ title: 'Review' }]
}

if (args.needsReview) {
  phase('Review')
  await agent('review', { label: 'review' })
}

for (const area of args.areas) {
  phase('Inspect ' + area)
  await agent('inspect ' + area, { label: 'inspect ' + area })
}

return { ok: true }
`,
    {
      args: { needsReview: false, areas: ["API", "UI"] },
      agent: fakeAgent,
    },
  );

  assert.deepEqual(result.phases, ["Inspect API", "Inspect UI"]);
  assert.equal(result.agentCount, 2);
});

test("runWorkflow rejects unawaited nested agent promises before returning details", async () => {
  let ended = 0;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'promise_leak',
  description: 'Return an unawaited agent promise'
}

phase('Leak promise')
const scan = agent('scan', { label: 'scan' })
return { scan }
`,
        {
          agent: fakeAgent,
          onAgentEnd() {
            ended++;
          },
        },
      ),
    /workflow result must be structured-cloneable; did you forget to await agent\(\), parallel\(\), or pipeline\(\)\?.*Promise.*cloned/,
  );

  assert.equal(ended, 1);
});

test("runWorkflow rejects non-string runtime phase titles", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bad_phase',
  description: 'Use a non-string phase title'
}

phase(Promise.resolve('Scan'))
return { ok: true }
`,
        { agent: fakeAgent },
      ),
    /phase title must be a string/,
  );
});

test("runWorkflow allows prompts that mention nondeterministic API names", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'prompt_mentions',
  description: 'Ask about Date.now(), Math.random(), and new Date() usage'
}

phase('Catalog mentions')
const scan = await agent('Catalog Date.now(), Math.random(), and new Date() usage', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.equal(
    (result.result as { scan: string }).scan,
    "result:Catalog Date.now(), Math.random(), and new Date() usage",
  );
});
