/** Checks a call makes before it starts the child, and the onPayload hook. */
import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai/compat";
import {
  assistantLines,
  doneMessage,
  errorMessage,
  resultLine,
  runNative,
  streamEventLines,
} from "./support/native.ts";

const context = {
  messages: [
    { role: "system", content: "system", timestamp: 0 },
    { role: "user", content: "hello", timestamp: 1 },
  ],
} as unknown as TranscriptContext;

const response = { blocks: [{ type: "text" as const, text: "ok" }], stopReason: "end_turn" };
const stdout = [...streamEventLines(response), ...assistantLines(response), resultLine("success")];

test("rejects a timeout that is not a positive number of milliseconds", async (t) => {
  for (const timeoutMs of [0, -1, Number.NaN]) {
    const { events, childRequest } = await runNative(t, { context, options: { timeoutMs }, stdout });
    assert.equal(errorMessage(events).errorMessage, "timeoutMs must be positive milliseconds", String(timeoutMs));
    assert.equal(childRequest, null);
  }
});

test("refuses backend overrides before starting the child", async (t) => {
  const { events, childRequest } = await runNative(t, {
    context,
    env: { PI_CLAUDE_NATIVE_TEST_UPSTREAM: "", CLAUDE_CODE_USE_BEDROCK: "1" },
    stdout,
  });
  assert.match(errorMessage(events).errorMessage ?? "", /^Subscription mode refuses backend overrides: CLAUDE_CODE_USE_BEDROCK\./);
  assert.equal(childRequest, null);
});

test("sends the body onPayload returns and rejects one that is not an object", async (t) => {
  let seen: Record<string, unknown> | undefined;
  const replaced = await runNative(t, {
    context,
    options: {
      onPayload: (body) => {
        seen = body as Record<string, unknown>;
        return { ...seen, max_tokens: 7 };
      },
    },
    stdout,
  });
  doneMessage(replaced.events);
  assert.equal(typeof seen?.["max_tokens"], "number");
  assert.equal(replaced.childRequest?.body["max_tokens"], 7);

  const kept = await runNative(t, { context, options: { onPayload: () => undefined }, stdout });
  assert.equal(kept.childRequest?.body["max_tokens"], seen?.["max_tokens"]);

  const invalid = await runNative(t, { context, options: { onPayload: () => 5 }, stdout });
  assert.equal(errorMessage(invalid.events).errorMessage, "onPayload replacement must be an object");
  assert.equal(invalid.childRequest, null);
});
