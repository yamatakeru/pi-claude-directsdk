/**
 * How one call's native output becomes a Pi message or error: the result-line
 * error mapping, the completion gate, reconciliation of the streamed blocks
 * with the final message, and stop-reason mapping. Runs without an upstream
 * use the child's stdout (the non-relay path); runs with one use the relay
 * capture.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessageEvent, TranscriptContext } from "@earendil-works/pi-ai/compat";
import {
  type NativeResponse,
  type NativeRun,
  assistantLines,
  doneMessage,
  errorMessage,
  resultLine,
  runNative,
  sseResponse,
  streamEventLines,
} from "./support/native.ts";

const context = {
  messages: [
    { role: "system", content: "system", timestamp: 0 },
    { role: "user", content: "hello", timestamp: 1 },
  ],
} as unknown as TranscriptContext;

const NO_DETAIL = "(exit 0, stderr: <empty>)";

async function events(t: test.TestContext, run: Omit<NativeRun, "context">): Promise<AssistantMessageEvent[]> {
  return (await runNative(t, { context, ...run })).events;
}

async function failure(t: test.TestContext, run: Omit<NativeRun, "context">): Promise<string> {
  return errorMessage(await events(t, run)).errorMessage ?? "";
}

function reply(text: string, stopReason = "end_turn"): NativeResponse {
  return { blocks: [{ type: "text", text }], stopReason };
}

/** Child output for a response on the non-relay path. */
function streamed(response: NativeResponse, result = resultLine("success")): unknown[] {
  return [...streamEventLines(response), ...assistantLines(response), result];
}

function assistantError(error: unknown): unknown {
  return { type: "assistant", message: { role: "assistant", content: [], error } };
}

test("maps native error text and result errors to typed errors", async (t) => {
  const cases: Array<[string, unknown[], RegExp | string]> = [
    [
      "an authentication failure in an assistant line",
      [assistantError({ message: "Invalid API key", code: "authentication_failed" }), resultLine("success")],
      /^Claude Code is installed but has no usable login .* \(native: authentication_failed: Invalid API key\)$/,
    ],
    [
      "other assistant error text",
      [assistantError("API Error: 500 overloaded"), resultLine("success")],
      "Native request failed: API Error: 500 overloaded",
    ],
    [
      "a logged-out result",
      [resultLine("error_during_execution", { errors: ["Not logged in · Please run /login"] })],
      /^Claude Code is installed but has no usable login .* \(native: Not logged in · Please run \/login\)$/,
    ],
    [
      "a prompt that is too long",
      [resultLine("error_during_execution", { errors: ["prompt is too long: 250000 tokens > 200000 maximum"] })],
      "Native request failed: context_length_exceeded: prompt is too long: 250000 tokens > 200000 maximum. " +
        "Model claude-haiku-4-5 uses native route claude-haiku-4-5 with a configured context window of 200,000 tokens. " +
        "Check this model's contextWindow override in models.json or compact the session.",
    ],
    [
      "another result error, joined with the result text",
      [resultLine("error_during_execution", { result: "stopped", errors: ["tool loop", 3] })],
      `Native request failed: error_during_execution: stopped; tool loop ${NO_DETAIL}`,
    ],
    [
      "a logged-out result text without an assistant message",
      [resultLine("success", { is_error: false, result: "Not logged in" })],
      /^Claude Code is installed but has no usable login .* \(native: Not logged in\)$/,
    ],
  ];
  for (const [name, stdout, expected] of cases) {
    const message = await failure(t, { stdout });
    if (typeof expected === "string") assert.equal(message, expected, name);
    else assert.match(message, expected, name);
  }
});

test("requires exactly one result, an assistant message and message_stop", async (t) => {
  const response = reply("ok");
  assert.equal(
    await failure(t, { stdout: [...streamEventLines(response), ...assistantLines(response)] }),
    `Incomplete native response: Expected exactly one native result, saw 0 ${NO_DETAIL}`,
  );
  assert.equal(
    await failure(t, { stdout: streamed(response).concat(resultLine("success")) }),
    `Incomplete native response: Expected exactly one native result, saw 2 ${NO_DETAIL}`,
  );
  assert.equal(
    await failure(t, { stdout: [resultLine("success")] }),
    `Incomplete native response: assistant, message_stop and one result required ${NO_DETAIL}`,
  );
  assert.equal(
    await failure(t, { stdout: [...assistantLines(response), resultLine("success")] }),
    `Incomplete native response: assistant, message_stop and one result required ${NO_DETAIL}`,
  );
  assert.equal(
    await failure(t, { stdout: streamed(response, resultLine("success", { usage: {} })) }),
    "Incomplete native response: Native result missing complete token usage",
  );
  assert.equal(
    await failure(t, { stdout: streamed(response), exitCode: 2 }),
    "Native request failed: success",
  );
  assert.match(
    await failure(t, { stdout: ["not json"] }),
    /^Invalid native stream-json output: "\\"not json\\""$/,
  );
});

test("reports a failed upstream response before the child's result", async (t) => {
  const rejected = errorMessage(await events(t, {
    upstream: {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Third-party apps now draw from your extra usage, not your plan limits." } }),
    },
    stdout: [resultLine("success")],
  }));
  assert.match(rejected.errorMessage ?? "", /^Claude Code billing: /);
  // The billing text does not name the status, so the meta diagnostic keeps it.
  const meta = rejected.diagnostics?.find((item) => item.type === "pi-claude-native/meta");
  assert.equal((meta?.details as { upstreamStatus?: number | null } | undefined)?.upstreamStatus, 400);

  const overloaded = await failure(t, {
    upstream: { status: 529, contentType: "application/json", body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' },
    stdout: [assistantError("API Error: 529 Overloaded"), resultLine("success")],
  });
  assert.equal(
    overloaded,
    "Incomplete upstream response: first upstream attempt: status 529, capture incomplete, native retries denied: 0, " +
      "upstream said: Overloaded: API Error: 529 Overloaded",
  );
});

test("takes the relay capture as the response and still reports native error text", async (t) => {
  const response = reply("from upstream");
  const done = doneMessage(await events(t, {
    upstream: { body: sseResponse(response) },
    // The child's own lines are not the response when the relay captured one.
    stdout: [...assistantLines(reply("from stdout")), resultLine("success")],
  }));
  assert.deepEqual(done.content, [{ type: "text", text: "from upstream" }]);
  assert.equal(done.responseId, "msg_fake");
  const meta = done.diagnostics?.find((item) => item.type === "pi-claude-native/meta");
  assert.equal((meta?.details as { upstreamRequests?: number } | undefined)?.upstreamRequests, 1);
  assert.equal((meta?.details as { upstreamStatus?: number | null } | undefined)?.upstreamStatus, 200);

  const failed = errorMessage(await events(t, {
    upstream: { body: sseResponse(response) },
    stdout: [assistantError("API Error: something went wrong"), resultLine("success")],
  }));
  assert.equal(failed.errorMessage, "Native request failed: API Error: something went wrong");
  // A failed call keeps the usage the relay captured.
  assert.equal(failed.usage.input, 3);
  assert.equal(failed.usage.output, 5);
  assert.match(
    await failure(t, {
      upstream: { body: sseResponse(response) },
      stdout: [assistantError("Third-party apps now draw from your extra usage, not your plan limits."), resultLine("success")],
    }),
    /^Claude Code billing: /,
  );
});

test("fills the response ID and model from the stream when the final message lacks them", async (t) => {
  const done = doneMessage(await events(t, {
    stdout: [
      ...streamEventLines(reply("ok")),
      { type: "assistant", message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "ok" }] } },
      resultLine("success"),
    ],
  }));
  assert.equal(done.responseId, "msg_fake");
  assert.equal(done.responseModel, "claude-haiku-4-5-20251001");
});

test("reconciles streamed text with the final message", async (t) => {
  const unstreamed = await events(t, { stdout: [...assistantLines(reply("hello")), ...streamEventLines({ blocks: [], stopReason: "end_turn" }), resultLine("success")] });
  assert.deepEqual(doneMessage(unstreamed).content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(
    unstreamed.filter((event) => event.type.startsWith("text_")).map((event) => event.type),
    ["text_start", "text_delta"],
  );

  const partial = await events(t, {
    stdout: [...streamEventLines(reply("hel")), ...assistantLines(reply("hello")), resultLine("success")],
  });
  assert.deepEqual(doneMessage(partial).content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(
    partial.flatMap((event) => event.type === "text_delta" ? [event.delta] : []),
    ["hel", "lo"],
  );

  assert.equal(
    await failure(t, { stdout: [...streamEventLines(reply("abc")), ...assistantLines(reply("xyz")), resultLine("success")] }),
    "Incomplete native response: Native final text differs from incremental stream",
  );
});

test("keeps the final thinking signature and redacts redacted thinking", async (t) => {
  const response: NativeResponse = {
    blocks: [{ type: "thinking", thinking: "plan", signature: "streamed" }, { type: "text", text: "ok" }],
    stopReason: "end_turn",
  };
  const final = assistantLines({
    blocks: [{ type: "thinking", thinking: "plan", signature: "final" }, { type: "text", text: "ok" }],
    stopReason: "end_turn",
  });
  const signed = await events(t, { stdout: [...streamEventLines(response), ...final, resultLine("success")] });
  assert.deepEqual(doneMessage(signed).content, [
    { type: "thinking", thinking: "plan", thinkingSignature: "final" },
    { type: "text", text: "ok" },
  ]);
  assert.deepEqual(
    signed.map((event) => event.type).filter((type) => type !== "thinking_delta" && type !== "text_delta"),
    ["start", "thinking_start", "text_start", "thinking_end", "text_end", "done"],
  );

  const unsigned = doneMessage(await events(t, {
    stdout: [
      ...streamEventLines(response),
      { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "ok" }] } },
      resultLine("success"),
    ],
  }));
  assert.deepEqual(unsigned.content[0], { type: "thinking", thinking: "plan", thinkingSignature: "streamed" });

  const redacted = streamEventLines(reply("ok")).map((line) => {
    const event = (line as { event: Record<string, unknown> }).event;
    return event["type"] === "message_start"
      ? [line, { type: "stream_event", event: { type: "content_block_start", index: 5, content_block: { type: "redacted_thinking", data: "opaque" } } }]
      : [line];
  }).flat();
  const hidden = doneMessage(await events(t, {
    stdout: [...redacted, ...assistantLines(reply("ok")), resultLine("success")],
  }));
  assert.deepEqual(hidden.content[0], {
    type: "thinking",
    thinking: "[Reasoning redacted]",
    thinkingSignature: "opaque",
    redacted: true,
  });
});

test("maps stop reasons", async (t) => {
  const cases: Array<[string, string, string | undefined]> = [
    ["end_turn", "stop", undefined],
    ["stop_sequence", "stop", undefined],
    ["pause_turn", "stop", undefined],
    ["max_tokens", "length", undefined],
  ];
  for (const [stop, stopReason] of cases) {
    const done = doneMessage(await events(t, { stdout: streamed(reply("ok", stop)) }));
    assert.equal(done.stopReason, stopReason, stop);
    assert.equal(done.rawStopReason, stop, stop);
    assert.equal(done.endTurn, stop === "end_turn", stop);
  }

  const refused = errorMessage(await events(t, { stdout: streamed(reply("I can't help with that.", "refusal")) }));
  assert.equal(refused.stopReason, "error");
  assert.equal(refused.errorMessage, "I can't help with that.");
  assert.ok(refused.diagnostics?.some((item) => item.type === "pi-claude-native/native"));

  assert.equal(
    errorMessage(await events(t, { stdout: streamed(reply("ok", "surprise")) })).errorMessage,
    "Unhandled stop reason: surprise",
  );
  assert.equal(
    await failure(t, { stdout: streamed(reply("ok", "tool_use")) }),
    "Incomplete native response: Native stopped for tool use without tool calls",
  );
});

test("publishes tool calls from the child's stdout without a relay capture", async (t) => {
  const response: NativeResponse = {
    blocks: [
      { type: "text", text: "Reading." },
      { type: "tool_use", id: "toolu_1", name: "mcp__pi__read", input: { path: "a.txt" } },
    ],
    stopReason: "tool_use",
  };
  // Stream events without a block index fall back to the order of block starts.
  const unindexed = streamEventLines(response).map((line) => {
    const { index: _index, ...event } = (line as { event: Record<string, unknown> }).event;
    return { type: "stream_event", event };
  });
  const read = { name: "read", description: "Read a file", parameters: { type: "object" as const, properties: {} } };
  const withRead = {
    messages: [{ ...context.messages[0], toolsAdded: [read] }, context.messages[1]],
  } as unknown as TranscriptContext;
  for (const lines of [streamEventLines(response), unindexed]) {
    const { events: published } = await runNative(t, {
      context: withRead,
      stdout: [...lines, ...assistantLines(response), resultLine("error_max_turns", { num_turns: 2 })],
      exitCode: 1,
    });
    const done = doneMessage(published);
    assert.equal(done.stopReason, "toolUse");
    assert.deepEqual(done.content, [
      { type: "text", text: "Reading." },
      { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } },
    ]);
  }
});

test("rejects native content blocks Pi has no type for", async (t) => {
  const lines = streamEventLines(reply("ok")).map((line) => {
    const event = (line as { event: Record<string, unknown> }).event;
    return event["type"] === "message_start"
      ? [line, { type: "stream_event", event: { type: "content_block_start", index: 9, content_block: { type: "server_tool_use" } } }]
      : [line];
  }).flat();
  assert.equal(
    await failure(t, { stdout: [...lines, ...assistantLines(reply("ok")), resultLine("success")] }),
    "Unsupported native content block: server_tool_use",
  );
});

test("maps native usage, with cache writes and reasoning tokens", async (t) => {
  const usage = {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 40,
    cache_creation: { ephemeral_1h_input_tokens: 40 },
    output_tokens_details: { thinking_tokens: 15 },
  };
  const done = doneMessage(await events(t, {
    upstream: { body: sseResponse({ ...reply("ok"), usage }) },
    stdout: [...assistantLines(reply("ok")), resultLine("success")],
  }));
  assert.deepEqual(
    { ...done.usage, cost: undefined },
    { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cacheWrite1h: 40, reasoning: 15, cost: undefined },
  );
});

test("an aborted call ends as aborted without starting the child", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const { events: aborted, childRequest } = await runNative(t, {
    context,
    options: { signal: controller.signal },
    stdout: streamed(reply("ok")),
  });
  const error = errorMessage(aborted);
  assert.equal(error.stopReason, "aborted");
  assert.equal(error.errorMessage, "Claude request cancelled");
  assert.equal(childRequest, null);
});
