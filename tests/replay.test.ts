import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai/compat";
import { buildChildEnv, checkEnvConflicts, TEST_UPSTREAM_ENV } from "../src/request.ts";
import { setupChildEnv } from "../src/setup.ts";
import {
  encodeCarrier,
  messageProjection,
  prepareHistory,
} from "../src/replay.ts";

const usage: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(): AssistantMessage {
  return {
    role: "assistant",
    api: "claude-native",
    provider: "claude-native",
    model: "claude-haiku-4-5-20251001",
    content: [
      { type: "thinking", thinking: "private", thinkingSignature: "signed" },
      { type: "text", text: "visible" },
    ],
    usage,
    stopReason: "stop",
    timestamp: 1,
  };
}

test("restores signed thinking only while the visible projection matches", () => {
  const message = assistant();
  const native = {
    role: "assistant" as const,
    model: "claude-opus-5-5",
    content: [
      { type: "thinking" as const, thinking: "private", signature: "signed" },
      { type: "text" as const, text: "visible" },
    ],
    stop_reason: "end_turn",
  };
  message.diagnostics = [encodeCarrier([native], messageProjection(message))];

  const history = [
    { role: "user" as const, content: "go", timestamp: 0 },
    message,
    { role: "user" as const, content: "again", timestamp: 2 },
  ];
  const restored = prepareHistory(history, new Set(["read"]));
  assert.deepEqual(restored.frames[1]?.message.content[0], native.content[0]);
  assert.equal(restored.frames[1]?.message.model, "claude-opus-5-5");

  message.content[1] = { type: "text", text: "edited" };
  const edited = prepareHistory(history, new Set(["read"]));
  assert.deepEqual(edited.frames[1]?.message.content, [
    { type: "text", text: "private" },
    { type: "text", text: "edited" },
  ]);
});

test("ignores a carrier saved under the pre-rename type", () => {
  const message = assistant();
  const native = {
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking: "private", signature: "signed" },
      { type: "text" as const, text: "visible" },
    ],
    stop_reason: "end_turn",
  };
  message.diagnostics = [{ ...encodeCarrier([native], messageProjection(message)), type: "pi-claude-directsdk/native" }];

  const restored = prepareHistory([
    { role: "user" as const, content: "go", timestamp: 0 },
    message,
    { role: "user" as const, content: "again", timestamp: 2 },
  ], new Set(["read"]));
  const content = restored.frames[1]?.message.content ?? [];
  assert.ok(content.length > 0, "the visible message still replays");
  assert.equal(content.some((block) => block.type === "thinking"), false);
});

function toolTurn(
  calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>,
  provider = "openai-codex",
): AssistantMessage {
  return {
    role: "assistant",
    api: provider,
    provider,
    model: "other",
    content: [
      { type: "text", text: "checking" },
      ...calls.map((call) => ({
        type: "toolCall" as const,
        id: call.id,
        name: call.name,
        arguments: call.arguments ?? {},
      })),
    ],
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  content: ToolResultMessage["content"],
  isError = false,
): ToolResultMessage {
  return { role: "toolResult", toolCallId, toolName, content, isError, timestamp: 2 };
}

test("replays tool calls a request does not declare as text", () => {
  const restored = prepareHistory([
    { role: "user", content: "go", timestamp: 0 },
    toolTurn([{ id: "call_1", name: "read", arguments: { path: "a.ts" } }]),
    toolResult("call_1", "read", [{ type: "text", text: "contents" }]),
    { role: "user", content: "advise", timestamp: 3 },
  ], new Set());

  assert.deepEqual(restored.frames.map((frame) => frame.message.content), [
    [{ type: "text", text: "go" }],
    [
      { type: "text", text: "checking" },
      { type: "text", text: '[Tool call: read, id call_1] {"path":"a.ts"}' },
    ],
    [
      { type: "text", text: "[Tool result: read, id call_1]\ncontents" },
      { type: "text", text: "advise" },
    ],
  ]);
  assert.deepEqual(restored.replayAdjustments, [{ kind: "toolCallAsText", tool: "read" }]);
});

test("keeps declared tool calls structured next to calls replayed as text", () => {
  const restored = prepareHistory([
    { role: "user", content: "go", timestamp: 0 },
    toolTurn([
      { id: "call_1", name: "read" },
      { id: "call_2", name: "gone" },
    ]),
    toolResult("call_2", "gone", [{ type: "text", text: "failed" }], true),
    toolResult("call_1", "read", [{ type: "text", text: "contents" }]),
    { role: "user", content: "continue", timestamp: 3 },
  ], new Set(["read"]));

  // Native tool results must lead their user message, and tool uses end
  // the assistant message, so the text replay moves around them.
  assert.deepEqual(restored.frames[1]?.message.content, [
    { type: "text", text: "checking" },
    { type: "text", text: "[Tool call: gone, id call_2] {}" },
    { type: "tool_use", id: "call_1", name: "mcp__pi__read", input: {} },
  ]);
  assert.deepEqual(restored.frames[2]?.message.content, [
    { type: "tool_result", tool_use_id: "call_1", content: "contents" },
    { type: "text", text: "[Tool error: gone, id call_2]\nfailed" },
    { type: "text", text: "continue" },
  ]);
  assert.deepEqual(restored.replayAdjustments, [{ kind: "toolCallAsText", tool: "gone" }]);
});

test("matches results to the calls of their own turn when an ID is reused", () => {
  const later = toolTurn([{ id: "call_1", name: "read" }]);
  later.timestamp = 5;
  const restored = prepareHistory([
    { role: "user", content: "go", timestamp: 0 },
    toolTurn([{ id: "call_1", name: "gone" }]),
    toolResult("call_1", "gone", [{ type: "text", text: "old" }]),
    later,
    toolResult("call_1", "read", [{ type: "text", text: "new" }]),
  ], new Set(["read"]));

  assert.deepEqual(restored.frames[2]?.message.content, [
    { type: "text", text: "[Tool result: gone, id call_1]\nold" },
  ]);
  assert.deepEqual(restored.frames[4]?.message.content, [
    { type: "tool_result", tool_use_id: "call_1", content: "new" },
  ]);
});

test("names each call replayed as text so same-name results stay apart", () => {
  const restored = prepareHistory([
    { role: "user", content: "go", timestamp: 0 },
    toolTurn([{ id: "call_1", name: "gone" }, { id: "call_2", name: "gone" }]),
    toolResult("call_2", "gone", [{ type: "text", text: "second" }]),
    toolResult("call_1", "gone", [{ type: "text", text: "first" }]),
  ], new Set());

  assert.deepEqual(restored.frames[2]?.message.content, [
    { type: "text", text: "[Tool result: gone, id call_2]\nsecond" },
    { type: "text", text: "[Tool result: gone, id call_1]\nfirst" },
  ]);
});

test("keeps the block order of a turn without calls replayed as text", () => {
  const message = toolTurn([{ id: "call_1", name: "read" }]);
  message.content.push({ type: "text", text: "after" });
  const restored = prepareHistory([
    { role: "user", content: "go", timestamp: 0 },
    message,
    toolResult("call_1", "read", [{ type: "text", text: "contents" }]),
  ], new Set(["read"]));

  assert.deepEqual(restored.frames[1]?.message.content.map((block) => block.type), [
    "text",
    "tool_use",
    "text",
  ]);
});

test("replays an edited native turn without its signature when its calls are undeclared", () => {
  const message = toolTurn([{ id: "call_1", name: "read" }], "claude-native");
  message.content.unshift({ type: "thinking", thinking: "private", thinkingSignature: "signed" });
  const native = {
    role: "assistant" as const,
    model: "claude-opus-5-5",
    content: [
      { type: "thinking" as const, thinking: "private", signature: "signed" },
      { type: "text" as const, text: "checking" },
      { type: "tool_use" as const, id: "call_1", name: "mcp__pi__read", input: {} },
      { type: "tool_use" as const, id: "call_2", name: "mcp__pi__advisor", input: {} },
    ],
    stop_reason: "tool_use",
  };
  // The carrier still lists a call that was removed from the message.
  message.diagnostics = [encodeCarrier([native], {
    ...messageProjection(message),
    toolCalls: [
      ...messageProjection(message).toolCalls,
      { id: "call_2", name: "advisor", input: {} },
    ],
  })];

  const restored = prepareHistory([
    { role: "user", content: "go", timestamp: 0 },
    message,
    toolResult("call_1", "read", [{ type: "text", text: "contents" }]),
  ], new Set());

  assert.deepEqual(restored.frames[1]?.message.content, [
    { type: "text", text: "private" },
    { type: "text", text: "checking" },
    { type: "text", text: "[Tool call: read, id call_1] {}" },
  ]);
  assert.deepEqual(restored.frames[2]?.message.content, [
    { type: "text", text: "[Tool result: read, id call_1]\ncontents" },
  ]);
});

test("keeps images and drops empty text in a tool result replayed as text", () => {
  const restored = prepareHistory([
    { role: "user", content: "go", timestamp: 0 },
    toolTurn([{ id: "call_1", name: "screenshot" }]),
    toolResult("call_1", "screenshot", [
      { type: "text", text: "" },
      { type: "image", data: "aW1n", mimeType: "image/png" },
      { type: "text", text: "done" },
    ]),
  ], new Set(["read"]));

  assert.deepEqual(restored.frames[2]?.message.content, [
    { type: "text", text: "[Tool result: screenshot, id call_1]" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } },
    { type: "text", text: "done" },
  ]);
});

test("rejects backend overrides without the test bypass", () => {
  assert.deepEqual(checkEnvConflicts({ ANTHROPIC_API_KEY: "secret", ANTHROPIC_AUTH_TOKEN: "secret" }), []);
  assert.deepEqual(checkEnvConflicts({ ANTHROPIC_BASE_URL: "https://example.test" }), [
    "ANTHROPIC_BASE_URL",
  ]);
  assert.deepEqual(checkEnvConflicts({ CLAUDE_CODE_USE_BEDROCK: "1" }), [
    "CLAUDE_CODE_USE_BEDROCK",
  ]);
  assert.deepEqual(checkEnvConflicts({ [TEST_UPSTREAM_ENV]: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:1" }), []);
});

test("API credentials never reach Claude Code without the test bypass", () => {
  const credentials = { ANTHROPIC_API_KEY: "a", ANTHROPIC_AUTH_TOKEN: "b", ANTHROPIC_FOUNDRY_API_KEY: "c" };
  const turn = (env: NodeJS.ProcessEnv) => buildChildEnv({ baseEnv: env, relayUrl: "http://127.0.0.1:1", body: {} });
  for (const child of [turn({ ...credentials, KEEP: "1" }), setupChildEnv({ ...credentials, KEEP: "1" })]) {
    assert.deepEqual(Object.keys(credentials).filter((name) => name in child), []);
    assert.equal(child["KEEP"], "1");
  }
  for (const child of [turn({ ...credentials, [TEST_UPSTREAM_ENV]: "1" }), setupChildEnv({ ...credentials, [TEST_UPSTREAM_ENV]: "1" })]) {
    assert.deepEqual(Object.keys(credentials).filter((name) => !(name in child)), []);
  }
});
