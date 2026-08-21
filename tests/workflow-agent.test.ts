import assert from "node:assert/strict";
import test from "node:test";
import { extractLastAssistantText } from "../src/agent.js";

function assistant(...text: string[]) {
  return { role: "assistant", content: text.map((value) => ({ type: "text", text: value })) };
}

test("extractLastAssistantText returns the last usable assistant text", () => {
  assert.equal(
    extractLastAssistantText([assistant("first"), assistant("  "), assistant("final", " answer")]),
    "final answer",
  );
});

test("extractLastAssistantText rejects a blank final assistant after intermediate text", () => {
  assert.throws(
    () => extractLastAssistantText([assistant("intermediate"), assistant("  ")]),
    /no usable final response/,
  );
});

test("extractLastAssistantText rejects a tool-only final assistant after intermediate text", () => {
  assert.throws(
    () => extractLastAssistantText([assistant("intermediate"), { role: "assistant", content: [{ type: "toolCall" }] }]),
    /no usable final response/,
  );
});

test("extractLastAssistantText rejects runs without an assistant message", () => {
  assert.throws(() => extractLastAssistantText([{ role: "user", content: [] }]), /no usable final response/);
});
