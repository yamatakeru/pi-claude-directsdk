import assert from "node:assert/strict";
import test from "node:test";
import type { Tool, TranscriptContext } from "@earendil-works/pi-ai/compat";
import { planRequest } from "../src/request-plan.ts";
import { PROVIDER_ID } from "../src/models.ts";
import { nativeModel } from "./support/native.ts";

const tool = (name: string): Tool => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
});

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A session that called alpha, then removed it and added beta. */
const context = {
  messages: [
    { role: "system", content: "base", toolsAdded: [tool("alpha")], timestamp: 0 },
    { role: "user", content: "first", timestamp: 1 },
    {
      role: "assistant",
      api: "claude-native",
      provider: PROVIDER_ID,
      model: "claude-opus-5",
      content: [{ type: "toolCall", id: "toolu_1", name: "alpha", arguments: {} }],
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    { role: "toolResult", toolCallId: "toolu_1", toolName: "alpha", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 },
    { role: "system", content: "alpha is gone", toolsRemoved: [{ name: "alpha" }], toolsAdded: [tool("beta")], timestamp: 4 },
    { role: "user", content: "second", timestamp: 5 },
  ],
} as unknown as TranscriptContext;

const supported = nativeModel({ id: "claude-opus-5", compat: { supportsMidConvoToolChanges: true } });
const unsupported = nativeModel({ id: "claude-opus-5" });

function assistantContent(plan: ReturnType<typeof planRequest>): unknown {
  return plan.frames.find((frame) => frame.type === "assistant")?.message.content;
}

test("a model with mid-conversation tool changes keeps the initial prompt and replays every declared tool natively", () => {
  const plan = planRequest(supported, context, {}, {}, "claude-opus-5");
  assert.ok(plan.nativeTranscript);
  assert.equal(plan.systemPrompt, "base");
  assert.equal(plan.build.body["tools"], plan.nativeTranscript.requestTools);
  assert.deepEqual(plan.build.toolNames, ["beta"]);
  assert.deepEqual(assistantContent(plan), [{ type: "tool_use", id: "toolu_1", name: "mcp__pi__alpha", input: {} }]);
  assert.deepEqual(plan.replayAdjustments, []);
});

test("other models send the collapsed prompt and replay calls to removed tools as text", () => {
  const plan = planRequest(unsupported, context, {}, {}, "claude-opus-5");
  assert.equal(plan.nativeTranscript, undefined);
  assert.match(plan.systemPrompt, /^base\b[\s\S]*alpha is gone/);
  assert.deepEqual(plan.build.toolNames, ["beta"]);
  assert.deepEqual(assistantContent(plan), [{ type: "text", text: "[Tool call: alpha, id toolu_1] {}" }]);
  assert.deepEqual(plan.replayAdjustments, [{ kind: "toolCallAsText", tool: "alpha" }]);
});

test("toolChoice none drops the native transcript", () => {
  const plan = planRequest(supported, context, { toolChoice: "none" }, {}, "claude-opus-5");
  assert.equal(plan.nativeTranscript, undefined);
  assert.deepEqual(plan.replayAdjustments, [{ kind: "toolCallAsText", tool: "alpha" }]);
});

test("Pi's per-call output limit wins over the model's", () => {
  assert.equal(planRequest(unsupported, context, {}, {}, "claude-opus-5").build.body["max_tokens"], 4_096);
  assert.equal(planRequest(unsupported, context, { maxTokens: 100 }, {}, "claude-opus-5").build.body["max_tokens"], 100);
});
