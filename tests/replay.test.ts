import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import { checkEnvConflicts, TEST_UPSTREAM_ENV } from "../src/request.ts";
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
    api: "claude-directsdk",
    provider: "claude-directsdk",
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

  message.content[1] = { type: "text", text: "edited" };
  const edited = prepareHistory(history, new Set(["read"]));
  assert.deepEqual(edited.frames[1]?.message.content, [
    { type: "text", text: "private" },
    { type: "text", text: "edited" },
  ]);
});

test("rejects conflicting auth and backend overrides without the test bypass", () => {
  assert.deepEqual(checkEnvConflicts({ ANTHROPIC_API_KEY: "secret" }), ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(checkEnvConflicts({ ANTHROPIC_BASE_URL: "https://example.test" }), [
    "ANTHROPIC_BASE_URL",
  ]);
  assert.deepEqual(checkEnvConflicts({ CLAUDE_CODE_USE_BEDROCK: "1" }), [
    "CLAUDE_CODE_USE_BEDROCK",
  ]);
  assert.deepEqual(checkEnvConflicts({ [TEST_UPSTREAM_ENV]: "1", ANTHROPIC_API_KEY: "secret" }), []);
});
