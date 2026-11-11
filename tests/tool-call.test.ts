import assert from "node:assert/strict";
import test from "node:test";
import type { Tool, TranscriptContext } from "@earendil-works/pi-ai/compat";
import {
  type NativeResponse,
  assistantLines,
  doneMessage,
  errorMessage,
  resultLine,
  runNative,
  sseResponse,
} from "./support/native.ts";

const read: Tool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

const context = {
  messages: [
    { role: "system", content: "base", toolsAdded: [read], timestamp: 0 },
    { role: "user", content: "read a.txt and b.txt", timestamp: 1 },
  ],
} as unknown as TranscriptContext;

/** A tool-use turn as Claude Code 2.1.322 ends it under the provider: max turns, exit code 1. */
async function toolTurn(t: test.TestContext, blocks: NativeResponse["blocks"]) {
  const response = { blocks, stopReason: "tool_use" };
  const { events } = await runNative(t, {
    context,
    upstream: { body: sseResponse(response) },
    stdout: [...assistantLines(response), resultLine("error_max_turns", { num_turns: 2 })],
    exitCode: 1,
  });
  return events;
}

test("emits calls to active tools in order and ends the turn as tool use", async (t) => {
  const events = await toolTurn(t, [
    { type: "text", text: "Reading both." },
    { type: "tool_use", id: "toolu_a", name: "mcp__pi__read", input: { path: "a.txt" } },
    { type: "tool_use", id: "toolu_b", name: "mcp__pi__read", input: { path: "b.txt" } },
  ]);

  const done = doneMessage(events);
  assert.equal(done.stopReason, "toolUse");
  assert.deepEqual(done.content, [
    { type: "text", text: "Reading both." },
    { type: "toolCall", id: "toolu_a", name: "read", arguments: { path: "a.txt" } },
    { type: "toolCall", id: "toolu_b", name: "read", arguments: { path: "b.txt" } },
  ]);
  const ended = events.flatMap((event) => event.type === "toolcall_end" ? [event.toolCall] : []);
  assert.deepEqual(ended.map((call) => [call.id, call.name, call.arguments]), [
    ["toolu_a", "read", { path: "a.txt" }],
    ["toolu_b", "read", { path: "b.txt" }],
  ]);
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("toolcall_")).map((event) => event.type),
    ["toolcall_start", "toolcall_delta", "toolcall_end", "toolcall_start", "toolcall_delta", "toolcall_end"],
  );
});

test("rejects a call to a tool outside the active tools", async (t) => {
  const events = await toolTurn(t, [
    { type: "tool_use", id: "toolu_gone", name: "mcp__pi__gone", input: {} },
  ]);

  assert.equal(events.some((event) => event.type === "done"), false);
  assert.equal(events.some((event) => event.type === "toolcall_start"), false);
  assert.match(errorMessage(events).errorMessage ?? "", /Native returned a tool outside the active tools/);
});
