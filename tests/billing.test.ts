import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isRetryableAssistantError,
  type Api,
  type AssistantMessageEvent,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import {
  ALLOW_USAGE_CREDITS_ENV,
  RATE_LIMIT_DIAGNOSTIC,
  usageCreditsAllowed,
  usageCreditsRejectionError,
} from "../src/billing.ts";
import { PROVIDER_ID } from "../src/models.ts";
import {
  streamClaudeDirectSdk,
  defaultDeps,
  type CallDeps,
} from "../src/stream.ts";

const FAKE_CLAUDE = `#!/usr/bin/env node
import readline from "node:readline";

const usage = { input_tokens: 3, output_tokens: 1 };
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  if (frame.shouldQuery === false) {
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, usage }));
    continue;
  }
  if (process.env.FAKE_REJECTION === "1") {
    console.log(JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [],
        error: "API Error: 400 Third-party apps now draw from your extra usage, not your plan limits.",
      },
    }));
    console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, usage }));
    continue;
  }
  const text = process.env.FAKE_TEXT || "ok";
  const events = [
    { type: "message_start", message: { id: "msg_test", role: "assistant", content: [], usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
    { type: "message_stop" },
  ];
  for (const event of events) console.log(JSON.stringify({ type: "stream_event", event }));
  console.log(JSON.stringify({
    type: "assistant",
    message: { id: "msg_test", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage },
  }));
  console.log(JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status: process.env.FAKE_OVERAGE === "1" ? "allowed_warning" : "allowed",
      rateLimitType: "five_hour",
      resetsAt: 1_800_000_000,
      isUsingOverage: process.env.FAKE_OVERAGE === "1",
    },
  }));
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: text,
    usage,
    total_cost_usd: 0,
  }));
}
`;

function model(): Model<Api> {
  return {
    id: "claude-haiku-4-5-20251001",
    name: "Haiku",
    api: "claude-directsdk" as Api,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-directsdk",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

test("usage credits are opt-in and rejections are actionable non-retryable billing errors", () => {
  assert.equal(usageCreditsAllowed({}), false);
  assert.equal(usageCreditsAllowed({ [ALLOW_USAGE_CREDITS_ENV]: "0" }), false);
  assert.equal(usageCreditsAllowed({ [ALLOW_USAGE_CREDITS_ENV]: "1" }), true);

  const rejection = usageCreditsRejectionError(
    "API Error: 400 Third-party apps now draw from your extra usage, not your plan limits.",
  );
  assert.ok(rejection);
  assert.match(rejection.message, /^Claude Code billing:/);
  assert.equal(usageCreditsRejectionError("overloaded"), undefined);
});

test("stops after an overage charge unless usage credits are allowed", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-directsdk-billing-")));
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
      { role: "system", content: "system", timestamp: 0 },
      { role: "user", content: "hello", timestamp: 1 },
    ],
  } as unknown as TranscriptContext;

  const run = async (
    overage: boolean,
    allow: boolean,
    rejection = false,
    text = "",
  ): Promise<AssistantMessageEvent[]> => {
    const events: AssistantMessageEvent[] = [];
    const stream = streamClaudeDirectSdk(model(), context, {
      timeoutMs: 5_000,
      env: {
        PI_DIRECTSDK_TEST_UPSTREAM: "1",
        CLAUDE_DIRECTSDK_COMMAND: executable,
        DISABLE_PROMPT_CACHING: "0",
        CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
        FAKE_OVERAGE: overage ? "1" : "0",
        FAKE_REJECTION: rejection ? "1" : "0",
        FAKE_TEXT: text,
        [ALLOW_USAGE_CREDITS_ENV]: allow ? "1" : "",
      },
    }, deps);
    for await (const event of stream) events.push(event);
    return events;
  };

  const stopped = await run(true, false);
  const failure = stopped.find((event) => event.type === "error");
  assert.ok(failure && failure.type === "error");
  assert.match(failure.error.errorMessage ?? "", /^Claude Code billing:/);
  assert.equal(isRetryableAssistantError(failure.error), false);
  assert.ok(failure.error.diagnostics?.some((item) => item.type === RATE_LIMIT_DIAGNOSTIC));

  const allowed = await run(true, true);
  const done = allowed.find((event) => event.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.message.content.some((block) => block.type === "text" && block.text === "ok"), true);
  assert.ok(done.message.diagnostics?.some((item) => item.type === RATE_LIMIT_DIAGNOSTIC));

  const rejected = await run(false, false, true);
  const rejection = rejected.find((event) => event.type === "error");
  assert.ok(rejection && rejection.type === "error");
  assert.match(rejection.error.errorMessage ?? "", /^Claude Code billing: .*usage credits/);
  assert.equal(isRetryableAssistantError(rejection.error), false);

  // #20: a successful reply that quotes a rejection phrase is the model's text, not a rejection.
  const quote = "You're out of extra usage, as the docs say.";
  const quoted = await run(false, false, false, quote);
  const reply = quoted.find((event) => event.type === "done");
  assert.ok(reply && reply.type === "done", JSON.stringify(quoted.find((event) => event.type === "error")));
  assert.equal(reply.message.content.some((block) => block.type === "text" && block.text === quote), true);
});
