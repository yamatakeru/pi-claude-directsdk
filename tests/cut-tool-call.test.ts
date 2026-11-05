import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  Api,
  AssistantMessageEvent,
  Model,
  Tool,
  TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { SseCapture } from "../src/admission.ts";
import { PROVIDER_ID } from "../src/models.ts";
import { defaultDeps, streamClaudeNative, type CallDeps } from "../src/stream.ts";

// Anthropic does not validate streamed tool input, so a reply cut off at
// max_tokens can end inside a tool call's arguments.
const usage = { input_tokens: 3, output_tokens: 64 };

function sse(text: string | null, stopReason = "max_tokens"): string {
  const blocks = text === null ? [] : [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
  ];
  const tool = blocks.length / 3;
  const events = [
    { type: "message_start", message: { id: "msg_cut", role: "assistant", model: "claude-haiku-5-5", content: [], usage } },
    ...blocks,
    { type: "content_block_start", index: tool, content_block: { type: "tool_use", id: "toolu_cut", name: "mcp__pi__write", input: {} } },
    { type: "content_block_delta", index: tool, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt","content":"hel' } },
    { type: "content_block_stop", index: tool },
    { type: "message_delta", delta: { stop_reason: stopReason }, usage },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
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
const FAKE_CLAUDE = `#!/usr/bin/env node
import readline from "node:readline";

const usage = ${JSON.stringify(usage)};
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  if (frame.shouldQuery === false) {
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, usage }));
    continue;
  }
  const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "write a.txt" }] }),
  });
  await response.text();
  const content = [{ type: "tool_use", id: "toolu_cut", name: "mcp__pi__write", input: {} }];
  if (process.env.FAKE_TEXT) content.unshift({ type: "text", text: process.env.FAKE_TEXT });
  console.log(JSON.stringify({
    type: "assistant",
    message: { id: "msg_cut", role: "assistant", model: "claude-haiku-5-5", content, stop_reason: "max_tokens", usage },
  }));
  console.log(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 2, usage, total_cost_usd: 0 }));
  process.exit(1);
}
`;

const write: Tool = {
  name: "write",
  description: "write a file",
  parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
};

function model(): Model<Api> {
  return {
    id: "claude-haiku-5-5",
    name: "Haiku",
    api: "claude-native" as Api,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-native",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64,
  };
}

async function run(t: test.TestContext, text: string | null) {
  const upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse(text));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-native-cut-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "fake-claude.mjs");
  await writeFile(executable, FAKE_CLAUDE, "utf8");
  await chmod(executable, 0o755);
  const deps: CallDeps = {
    ...defaultDeps,
    checkCli: () => true,
    makeRequestDir: () => mkdtempSync(join(root, "request-")),
    childCwd: () => root,
  };
  const context = {
    messages: [
      { role: "system", content: "base", toolsAdded: [write], timestamp: 0 },
      { role: "user", content: "write a.txt", timestamp: 1 },
    ],
  } as unknown as TranscriptContext;
  const events: AssistantMessageEvent[] = [];
  const stream = streamClaudeNative(model(), context, {
    timeoutMs: 5_000,
    env: {
      PI_CLAUDE_NATIVE_TEST_UPSTREAM: "1",
      PI_CLAUDE_NATIVE_COMMAND: executable,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ...(text === null ? {} : { FAKE_TEXT: text }),
    },
  }, deps);
  for await (const event of stream) events.push(event);
  return events;
}

test("a tool call cut off at max_tokens ends the turn as length with the text before it", async (t) => {
  const events = await run(t, "Writing it now.");
  const done = events.find((event) => event.type === "done");
  assert.ok(done && done.type === "done", JSON.stringify(events.find((event) => event.type === "error")));
  assert.equal(done.message.stopReason, "length");
  assert.deepEqual(
    done.message.content.map((block) => block.type === "text" ? block.text : block.type),
    ["Writing it now."],
  );
  assert.equal(events.some((event) => event.type === "toolcall_start"), false);
});

test("a cut-off tool call with no text before it fails with the cause", async (t) => {
  const events = await run(t, null);
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.match(
    error.error.errorMessage ?? "",
    /ran out of output tokens while writing the arguments of mcp__pi__write, so the call was not run/,
  );
});
