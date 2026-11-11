import assert from "node:assert/strict";
import test from "node:test";
import type { Tool, TranscriptContext } from "@earendil-works/pi-ai/compat";
import { SseCapture } from "../src/admission.ts";
import {
  type NativeResponse,
  doneMessage,
  errorMessage,
  nativeModel,
  resultLine,
  runNative,
  sseResponse,
} from "./support/native.ts";

const usage = { input_tokens: 3, output_tokens: 64 };

/** A reply whose tool call is cut off inside its arguments, after optional text. */
function cutReply(text: string | null, stopReason = "max_tokens"): NativeResponse {
  return {
    blocks: [
      ...(text === null ? [] : [{ type: "text" as const, text }]),
      { type: "tool_use", id: "toolu_cut", name: "mcp__pi__write", input: {}, partialJson: '{"path":"a.txt","content":"hel' },
    ],
    stopReason,
    usage,
  };
}

function sse(text: string | null, stopReason = "max_tokens"): string {
  return sseResponse(cutReply(text, stopReason));
}

test("the capture drops a tool call cut off at max_tokens", () => {
  const capture = new SseCapture();
  capture.feed(Buffer.from(sse("Writing it now.")));
  assert.equal(capture.complete, true);
  assert.deepEqual(capture.unparsed, ["mcp__pi__write"]);
  assert.deepEqual(capture.message?.content, [{ type: "text", text: "Writing it now." }]);
});

test("the capture still rejects unparseable tool input that max_tokens does not explain", () => {
  const capture = new SseCapture();
  assert.throws(() => capture.feed(Buffer.from(sse(null, "tool_use"))), /tool input is not valid JSON \(stop_reason tool_use\)/);
});

// Claude Code keeps the cut call and answers it locally with a parse error,
// which needs a second turn, so `--max-turns 1` ends with error_max_turns.

const write: Tool = {
  name: "write",
  description: "write a file",
  parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
};

async function run(t: test.TestContext, text: string | null) {
  const context = {
    messages: [
      { role: "system", content: "base", toolsAdded: [write], timestamp: 0 },
      { role: "user", content: "write a.txt", timestamp: 1 },
    ],
  } as unknown as TranscriptContext;
  const content: unknown[] = [{ type: "tool_use", id: "toolu_cut", name: "mcp__pi__write", input: {} }];
  if (text !== null) content.unshift({ type: "text", text });
  const { events } = await runNative(t, {
    context,
    model: nativeModel({ id: "claude-haiku-5-5", maxTokens: 64 }),
    upstream: { body: sse(text) },
    stdout: [
      {
        type: "assistant",
        message: { id: "msg_cut", role: "assistant", model: "claude-haiku-5-5", content, stop_reason: "max_tokens", usage },
      },
      resultLine("error_max_turns", { num_turns: 2, usage }),
    ],
    exitCode: 1,
  });
  return events;
}

test("a tool call cut off at max_tokens ends the turn as length with the text before it", async (t) => {
  const events = await run(t, "Writing it now.");
  const done = doneMessage(events);
  assert.equal(done.stopReason, "length");
  assert.deepEqual(
    done.content.map((block) => block.type === "text" ? block.text : block.type),
    ["Writing it now."],
  );
  assert.equal(events.some((event) => event.type === "toolcall_start"), false);
});

test("a cut-off tool call with no text before it fails with the cause", async (t) => {
  const events = await run(t, null);
  assert.match(
    errorMessage(events).errorMessage ?? "",
    /ran out of output tokens while writing the arguments of mcp__pi__write, so the call was not run/,
  );
});
