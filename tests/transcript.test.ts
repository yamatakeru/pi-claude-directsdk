import assert from "node:assert/strict";
import test from "node:test";
import { getDeclaredTools } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Message, Tool, Usage } from "@earendil-works/pi-ai/compat";
import { supportsNativeToolChanges } from "../src/model-compat.ts";
import { encodeCarrier, messageProjection, prepareHistory } from "../src/replay.ts";
import { injectNativeSystemMessages, prepareNativeTranscript } from "../src/transcript.ts";

const usage: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

function conversation(): Message[] {
  return [
    { role: "system", content: "base", toolsAdded: [alpha], timestamp: 0 },
    { role: "user", content: "first", timestamp: 1 },
    { role: "system", content: "beta is available", toolsAdded: [beta], timestamp: 2 },
    {
      role: "assistant",
      api: "claude-directsdk",
      provider: "claude-directsdk",
      model: "claude-opus-5",
      content: [{ type: "text", text: "one" }],
      usage,
      stopReason: "stop",
      timestamp: 3,
    },
    { role: "system", content: "alpha is gone", toolsRemoved: [{ name: "alpha" }], timestamp: 4 },
    { role: "user", content: "second", timestamp: 5 },
  ];
}

test("gates the native tool-change plan on model metadata and tool redefinitions", () => {
  assert.equal(supportsNativeToolChanges({ supportsMidConvoToolChanges: true }), true);
  assert.equal(supportsNativeToolChanges({ supportsMidConvoToolChanges: false }), false);
  assert.equal(supportsNativeToolChanges(undefined), false);
  assert.equal(prepareNativeTranscript(conversation(), false), undefined);
  assert.equal(
    prepareNativeTranscript(
      [
        { role: "system", content: "base", timestamp: 0 },
        { role: "system", content: "late", toolsAdded: [alpha], timestamp: 1 },
        { role: "user", content: "go", timestamp: 2 },
      ],
      true,
    ),
    undefined,
  );
  assert.equal(
    prepareNativeTranscript(
      [
        ...conversation(),
        {
          role: "system",
          content: "",
          toolsAdded: [{ ...alpha, description: "changed" }],
          timestamp: 6,
        },
      ],
      true,
    ),
    undefined,
  );
});

test("accepts historical calls to tools declared earlier in the transcript", () => {
  const history: Message[] = [
    { role: "user", content: "use alpha", timestamp: 0 },
    {
      role: "assistant",
      api: "claude-directsdk",
      provider: "claude-directsdk",
      model: "claude-opus-5",
      content: [{ type: "toolCall", id: "t1", name: "alpha", arguments: {} }],
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "alpha",
      content: [{ type: "text", text: "done" }],
      isError: false,
      timestamp: 2,
    },
    { role: "user", content: "continue", timestamp: 3 },
  ];
  assert.throws(
    () => prepareHistory(history, new Set(["beta"])),
    /Tool call outside the current inventory/,
  );
  const declared = new Set(getDeclaredTools(conversation()).map((tool) => tool.name));
  assert.deepEqual([...declared], ["alpha", "beta"]);
  assert.doesNotThrow(() => prepareHistory(history, declared));
});

function directAssistant(text: string): Message {
  return {
    role: "assistant",
    api: "claude-directsdk",
    provider: "claude-directsdk",
    model: "claude-opus-5",
    content: [{ type: "text", text }],
    usage,
    stopReason: "stop",
    timestamp: 0,
  };
}

test("#13 a carried assistant frame holding only empty text does not shift injections", () => {
  // The CLI drops an assistant frame whose only block is empty text, so the
  // request has one fewer assistant message than the carrier holds.
  const empty = directAssistant("") as Message & { diagnostics?: unknown[] };
  empty.diagnostics = [
    encodeCarrier(
      [{ role: "assistant", content: [{ type: "text", text: "" }] }],
      messageProjection(empty as AssistantMessage),
    ),
  ];
  const messages: Message[] = [
    { role: "system", content: "base", toolsAdded: [alpha], timestamp: 0 },
    { role: "user", content: "one", timestamp: 1 },
    empty,
    { role: "user", content: "two", timestamp: 2 },
    { role: "system", content: "beta is available", toolsAdded: [beta], timestamp: 3 },
    directAssistant("reply"),
    { role: "user", content: "three", timestamp: 4 },
  ];
  const plan = prepareNativeTranscript(messages, true);
  assert.ok(plan);
  assert.equal(plan.assistantFrames, 1);
  assert.deepEqual(plan.systemInjections.map((injection) => injection.beforeAssistant), [0]);

  // What the CLI sends: the empty frame is gone.
  const sent = [
    { role: "user", content: "one" },
    { role: "user", content: "two" },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "user", content: "three" },
  ];
  const injected = injectNativeSystemMessages(sent, plan.systemInjections, plan.assistantFrames);
  assert.deepEqual(injected.map((message) => message.role), ["user", "user", "system", "assistant", "user"]);
});

test("injection fails instead of inserting at a shifted assistant boundary", () => {
  const plan = prepareNativeTranscript(conversation(), true);
  assert.ok(plan);
  assert.equal(plan.assistantFrames, 1);
  const twoAssistants = [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "text", text: "extra" }] },
    { role: "user", content: "again" },
    { role: "assistant", content: [{ type: "text", text: "one" }] },
    { role: "user", content: "second" },
  ];
  assert.throws(
    () => injectNativeSystemMessages(twoAssistants, plan.systemInjections, plan.assistantFrames),
    /assistant messages do not match the replay/,
  );
});
