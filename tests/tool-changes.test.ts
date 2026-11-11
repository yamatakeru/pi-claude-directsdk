import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model, Tool, TranscriptContext } from "@earendil-works/pi-ai/compat";
import { NATIVE_TOOL_CHANGES_BETA } from "../src/transcript.ts";
import { PROVIDER_ID } from "../src/models.ts";
import { doneMessage, nativeModel, resultLine, runNative, sseResponse } from "./support/native.ts";

const alpha: Tool = {
  name: "alpha",
  description: "alpha",
  parameters: { type: "object", properties: {} },
};
const beta: Tool = {
  name: "beta",
  description: "beta",
  parameters: { type: "object", properties: {} },
};

function model(): Model<Api> {
  return nativeModel({
    id: "claude-opus-5",
    name: "Opus",
    maxTokens: 8_192,
    // The catalog sets this from Anthropic's published model list.
    compat: { supportsMidConvoToolChanges: true },
  });
}

test("streams a removed tool without rewriting the initial request prefix", async (t) => {
  const context = {
    messages: [
      { role: "system", content: "base", toolsAdded: [alpha], timestamp: 0 },
      { role: "user", content: "first", timestamp: 1 },
      { role: "system", content: "beta is available", toolsAdded: [beta], timestamp: 2 },
      {
        role: "assistant",
        api: "claude-native",
        provider: PROVIDER_ID,
        model: "claude-opus-5",
        content: [{ type: "text", text: "one" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 3,
      },
      { role: "system", content: "alpha is gone", toolsRemoved: [{ name: "alpha" }], timestamp: 4 },
      { role: "user", content: "second", timestamp: 5 },
    ],
  } as unknown as TranscriptContext;

  const reply = { blocks: [{ type: "text" as const, text: "ok" }], stopReason: "end_turn" };
  const { events, upstreamRequests } = await runNative(t, {
    context,
    model: model(),
    env: {
      DISABLE_PROMPT_CACHING: "0",
      DISABLE_PROMPT_CACHING_OPUS: "0",
      CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
    },
    upstream: { body: sseResponse(reply) },
    // The child's own request: the history so far as Claude Code sends it.
    request: {
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "one" }] },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
      headers: { "anthropic-beta": "existing-beta" },
    },
    stdout: [
      { type: "assistant", message: { id: "msg_test", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } },
      resultLine("success"),
    ],
  });

  doneMessage(events);
  assert.equal(upstreamRequests.length, 1);
  const seenBeta = String(upstreamRequests[0]?.headers["anthropic-beta"] ?? "");
  const seenBody = upstreamRequests[0]?.body;
  assert.match(seenBeta, new RegExp(NATIVE_TOOL_CHANGES_BETA));
  assert.match(seenBeta, /existing-beta/);
  assert.ok(seenBody);

  const tools = seenBody["tools"] as Array<Record<string, unknown>>;
  assert.deepEqual(
    tools.map((tool) => [tool["name"], tool["defer_loading"] ?? false]),
    [
      ["mcp__pi__alpha", false],
      ["__pi_deferred_placeholder__", true],
    ],
  );
  // Claude Code adds its own breakpoints; with the replay anchor, a tool
  // breakpoint would exceed Anthropic's limit of four.
  assert.equal(tools.some((tool) => "cache_control" in tool), false);

  const messages = seenBody["messages"] as Array<{ role: string; content: unknown }>;
  assert.deepEqual(messages.map((message) => message.role), [
    "user",
    "system",
    "assistant",
    "user",
    "system",
  ]);
  assert.deepEqual(messages[1]?.content, [
    { type: "text", text: "beta is available" },
    {
      type: "tool_addition",
      tool: {
        type: "tool_definition",
        definition: { name: "mcp__pi__beta", description: "beta", input_schema: { type: "object", properties: {} } },
      },
    },
  ]);
  assert.deepEqual(messages[4]?.content, [
    { type: "text", text: "alpha is gone" },
    { type: "tool_removal", tool: { type: "tool_reference", name: "mcp__pi__alpha" } },
  ]);
});
