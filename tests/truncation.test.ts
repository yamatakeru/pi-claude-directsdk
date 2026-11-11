import assert from "node:assert/strict";
import test from "node:test";
import type { SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai/compat";
import {
  type NativeResponse,
  assistantLines,
  doneMessage,
  errorMessage,
  nativeModel,
  resultLine,
  runNative,
  streamEventLines,
} from "./support/native.ts";

// A high-thinking turn can spend the whole output budget before writing
// anything. The native transport reports that as stop_reason max_tokens with
// thinking only, which used to publish an empty message.

const usage = {
  input_tokens: 2,
  output_tokens: 32000,
  cache_creation_input_tokens: 19648,
  cache_read_input_tokens: 0,
  output_tokens_details: { thinking_tokens: 32000 },
};

const context = {
  messages: [
    { role: "system", content: "system", timestamp: 0 },
    { role: "user", content: "continue", timestamp: 1 },
  ],
} as unknown as TranscriptContext;

/** A turn cut off at max_tokens after empty thinking, with or without partial text. */
function truncated(withText: boolean): unknown[] {
  const response: NativeResponse = {
    blocks: [
      { type: "thinking", thinking: "", signature: "sig" },
      ...(withText ? [{ type: "text" as const, text: "partial answer" }] : []),
    ],
    stopReason: "max_tokens",
    usage,
  };
  return [...streamEventLines(response), ...assistantLines(response), resultLine("success", { usage })];
}

function run(t: test.TestContext, withText: boolean, options: Partial<SimpleStreamOptions> = {}) {
  return runNative(t, {
    context,
    model: nativeModel({ id: "claude-haiku-5-5", contextWindow: 1_000_000, maxTokens: 128_000 }),
    options,
    stdout: truncated(withText),
  });
}

test("a truncated thinking-only turn fails with the cause instead of an empty message", async (t) => {
  const failure = errorMessage((await run(t, false)).events);
  assert.match(
    failure.errorMessage ?? "",
    /^Native request failed: claude-haiku-5-5 spent its whole output budget on thinking and returned no answer\. Lower the thinking level or switch models, then retry\.$/,
  );
  // The budget was billed, so the failed turn must not report zero output.
  assert.equal(failure.usage.output, 32000);

  const partial = await run(t, true);
  assert.equal(partial.events.some((event) => event.type === "error"), false);
  const done = doneMessage(partial.events);
  assert.equal(done.stopReason, "length");
  assert.equal(
    done.content.some((block) => block.type === "text" && block.text === "partial answer"),
    true,
  );
});

test("forwards the model output limit so the native default cannot cap the turn", async (t) => {
  const catalog = (await run(t, true)).childRequest;
  assert.equal(catalog?.body["max_tokens"], 128_000);
  assert.equal(catalog?.maxOutputTokens, "128000");

  // Pi's per-call override still wins over the catalog limit.
  const override = (await run(t, true, { maxTokens: 2_048 })).childRequest;
  assert.equal(override?.body["max_tokens"], 2_048);
  assert.equal(override?.maxOutputTokens, "2048");
});
