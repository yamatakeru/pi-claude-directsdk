/**
 * Conformance with the replay input contract (docs/adr/0001-replay-input-contract.md):
 * every history pi-ai's Anthropic provider can send is replayed, each
 * adjustment is recorded, and only the listed histories are rejected.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai/compat";
import { prepareHistory, replayAssistantCount } from "../src/replay.ts";
import type { NativeContentBlock } from "../src/types.ts";

const usage: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (content: string): Message => ({ role: "user", content, timestamp: 0 });

function turn(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-codex",
    provider: "openai-codex",
    model: "other",
    content,
    usage,
    stopReason,
    timestamp: 1,
  };
}

const call = (id: string, name = "read") => ({
  type: "toolCall" as const,
  id,
  name,
  arguments: {},
});

function result(
  toolCallId: string,
  content: ToolResultMessage["content"],
  isError = false,
  toolName = "read",
): ToolResultMessage {
  return { role: "toolResult", toolCallId, toolName, content, isError, timestamp: 2 };
}

/** Block types per frame, with the tool-use ID for tool results. */
function shape(frames: ReturnType<typeof prepareHistory>["frames"]): string[][] {
  return frames.map((frame) =>
    frame.message.content.map((block: NativeContentBlock) =>
      block.type === "tool_result"
        ? `tool_result:${block.tool_use_id}${block.is_error ? ":error" : ""}`
        : block.type === "text"
          ? `text:${block.text}`
          : block.type,
    ),
  );
}

const declared = new Set(["read"]);

test("omits an edited turn left with only empty signed thinking", () => {
  const replayed = prepareHistory([
    user("go"),
    turn([{ type: "thinking", thinking: "", thinkingSignature: "signed" }]),
    user("again"),
  ], declared);

  assert.deepEqual(shape(replayed.frames), [["text:go", "text:again"]]);
  assert.deepEqual(replayed.replayAdjustments, [{ kind: "turnOmitted" }]);
});

test("never sends whitespace-only text, and omits a turn left empty by it", () => {
  const replayed = prepareHistory([
    user("go"),
    turn([{ type: "text", text: "  " }, { type: "text", text: "kept" }], "stop"),
    user("next"),
    turn([{ type: "text", text: " \n" }], "stop"),
    user("again"),
  ], declared);

  assert.deepEqual(shape(replayed.frames), [
    ["text:go"],
    ["text:kept"],
    ["text:next", "text:again"],
  ]);
  assert.deepEqual(replayed.replayAdjustments, [{ kind: "turnOmitted" }]);
});

test("adds a result for a call left without one before the next user message", () => {
  for (const stopReason of ["toolUse", "error", "aborted"] as const) {
    const replayed = prepareHistory([
      user("go"),
      turn([call("c1")], stopReason),
      user("next"),
    ], declared);

    assert.deepEqual(shape(replayed.frames), [
      ["text:go"],
      ["tool_use"],
      ["tool_result:c1:error", "text:next"],
    ], stopReason);
    assert.deepEqual(replayed.frames[2]?.message.content[0], {
      type: "tool_result",
      tool_use_id: "c1",
      content: "No result provided",
      is_error: true,
    });
    assert.deepEqual(replayed.replayAdjustments, [{ kind: "toolResultAdded", tool: "read" }]);
  }
});

test("adds results for calls left open at the end instead of rejecting the history", () => {
  const replayed = prepareHistory([
    user("go"),
    turn([call("c1"), call("c2")]),
  ], declared);

  assert.deepEqual(shape(replayed.frames), [
    ["text:go"],
    ["tool_use", "tool_use"],
    ["tool_result:c1:error", "tool_result:c2:error"],
  ]);
});

test("adds a result between two assistant turns", () => {
  const replayed = prepareHistory([
    user("go"),
    turn([call("c1")], "error"),
    turn([{ type: "text", text: "retry" }], "stop"),
    user("next"),
  ], declared);

  assert.deepEqual(shape(replayed.frames), [
    ["text:go"],
    ["tool_use"],
    ["tool_result:c1:error"],
    ["text:retry"],
    ["text:next"],
  ]);
});

test("closes open calls at a user message and keeps a later result as text (#75)", () => {
  const replayed = prepareHistory([
    user("go"),
    turn([call("c1"), call("c2")]),
    result("c1", [{ type: "text", text: "one" }]),
    user("steer"),
    result("c2", [{ type: "text", text: "two" }]),
  ], declared);

  assert.deepEqual(shape(replayed.frames), [
    ["text:go"],
    ["tool_use", "tool_use"],
    [
      "tool_result:c1",
      "tool_result:c2:error",
      "text:steer",
      "text:[Tool result: read, id c2]\ntwo",
    ],
  ]);
  assert.deepEqual(replayed.replayAdjustments, [
    { kind: "toolResultAdded", tool: "read" },
    { kind: "toolResultAsText", tool: "read" },
  ]);
});

test("replays a result without an open call as text", () => {
  const replayed = prepareHistory([
    user("go"),
    turn([{ type: "text", text: "done" }], "stop"),
    result("c9", [{ type: "text", text: "late" }], true),
  ], declared);

  assert.deepEqual(shape(replayed.frames), [
    ["text:go"],
    ["text:done"],
    ["text:[Tool error: read, id c9]\nlate"],
  ]);
  assert.deepEqual(replayed.replayAdjustments, [{ kind: "toolResultAsText", tool: "read" }]);
});

test("adds a text result for a call replayed as text and left without one", () => {
  const replayed = prepareHistory([
    user("go"),
    turn([call("c1", "gone")]),
    user("next"),
  ], declared);

  assert.deepEqual(shape(replayed.frames), [
    ["text:go"],
    ["text:[Tool call: gone, id c1] {}"],
    ["text:[Tool error: gone, id c1]\nNo result provided", "text:next"],
  ]);
  assert.deepEqual(replayed.replayAdjustments, [
    { kind: "toolCallAsText", tool: "gone" },
    { kind: "toolResultAdded", tool: "gone" },
  ]);
});

test("accepts a tool-less request over a history ending in tool calls", () => {
  const replayed = prepareHistory([
    user("go"),
    turn([{ type: "text", text: "checking" }, call("c1"), call("c2", "gone")]),
  ], new Set());

  assert.deepEqual(shape(replayed.frames), [
    ["text:go"],
    ["text:checking", "text:[Tool call: read, id c1] {}", "text:[Tool call: gone, id c2] {}"],
    [
      "text:[Tool error: read, id c1]\nNo result provided",
      "text:[Tool error: gone, id c2]\nNo result provided",
    ],
  ]);
});

test("moves images from an error result after the turn's tool results", () => {
  const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
  const replayed = prepareHistory([
    user("go"),
    turn([call("c1"), call("c2")]),
    result("c1", [{ type: "text", text: "failed" }, image], true),
    result("c2", [{ type: "text", text: "ok" }]),
  ], declared);

  assert.deepEqual(shape(replayed.frames)[2], [
    "tool_result:c1:error",
    "tool_result:c2",
    "text:Images from the error result of tool call c1 (read):",
    "image",
  ]);
  assert.deepEqual(replayed.frames[2]?.message.content[0], {
    type: "tool_result",
    tool_use_id: "c1",
    content: [
      { type: "text", text: "failed" },
      { type: "text", text: "(image attached after the tool results)" },
    ],
    is_error: true,
  });
  assert.deepEqual(replayed.replayAdjustments, [{ kind: "errorImagesMoved", tool: "read" }]);
});

test("replaces an image without data with a text hint", () => {
  const replayed = prepareHistory([
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", data: "", mimeType: "image/png" },
      ],
      timestamp: 0,
    },
  ], declared);

  assert.deepEqual(shape(replayed.frames), [["text:look", "text:[Image omitted: no data]"]]);
  assert.deepEqual(replayed.replayAdjustments, [{ kind: "imageOmitted" }]);
});

test("still rejects assistant prefill, empty tool-call IDs, and unknown content", () => {
  assert.throws(
    () => prepareHistory([user("go"), turn([{ type: "text", text: "hi" }], "stop")], declared),
    /assistant prefill is unsupported/,
  );
  assert.throws(
    () => prepareHistory([user("go"), turn([call("")]), result("", [{ type: "text", text: "x" }])], declared),
    /Tool-call IDs must be nonempty/,
  );
  assert.throws(
    () => prepareHistory([
      user("go"),
      turn([{ type: "document" } as unknown as AssistantMessage["content"][number]], "stop"),
      user("next"),
    ], declared),
    /Unsupported assistant content block/,
  );
});

test("counts the assistant frames replay sends", () => {
  const history: Message[] = [
    user("go"),
    turn([{ type: "thinking", thinking: "", thinkingSignature: "signed" }]),
    user("a"),
    turn([{ type: "text", text: "  " }], "stop"),
    user("b"),
    turn([{ type: "thinking", thinking: " \n" }, call("c1")]),
    result("c1", [{ type: "text", text: "ok" }]),
    turn([{ type: "text", text: "done" }], "stop"),
    user("c"),
  ];
  const sent = prepareHistory(history, declared).frames.filter((f) => f.type === "assistant").length;
  const counted = history.reduce(
    (sum, message) => sum + (message.role === "assistant" ? replayAssistantCount(message) : 0),
    0,
  );
  assert.equal(sent, 2);
  assert.equal(counted, sent);
});
