import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableAssistantError, type TranscriptContext } from "@earendil-works/pi-ai/compat";
import {
  ALLOW_USAGE_CREDITS_ENV,
  RATE_LIMIT_DIAGNOSTIC,
  usageCreditsAllowed,
  usageCreditsRejectionError,
} from "../src/billing.ts";
import {
  assistantLines,
  doneMessage,
  errorMessage,
  nativeModel,
  resultLine,
  runNative,
  streamEventLines,
} from "./support/native.ts";

const usage = { input_tokens: 3, output_tokens: 1 };

const context = {
  messages: [
    { role: "system", content: "system", timestamp: 0 },
    { role: "user", content: "hello", timestamp: 1 },
  ],
} as unknown as TranscriptContext;

function rateLimitEvent(overage: boolean): unknown {
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status: overage ? "allowed_warning" : "allowed",
      rateLimitType: "five_hour",
      resetsAt: 1_800_000_000,
      isUsingOverage: overage,
    },
  };
}

/** The child's output for a reply that Claude Code charged, or did not charge, to usage credits. */
function reply(text: string, overage: boolean): unknown[] {
  const response = { blocks: [{ type: "text" as const, text }], stopReason: "end_turn", usage };
  return [
    ...streamEventLines(response),
    ...assistantLines(response),
    rateLimitEvent(overage),
    resultLine("success", { result: text, usage }),
  ];
}

/** The child's output when Anthropic rejects the request for usage credits. */
const rejection = [
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [],
      error: "API Error: 400 Third-party apps now draw from your extra usage, not your plan limits.",
    },
  },
  { type: "result", subtype: "error_during_execution", is_error: true, usage },
];

test("usage credits are opt-in and rejections are actionable non-retryable billing errors", () => {
  assert.equal(usageCreditsAllowed({}), false);
  assert.equal(usageCreditsAllowed({ [ALLOW_USAGE_CREDITS_ENV]: "0" }), false);
  assert.equal(usageCreditsAllowed({ [ALLOW_USAGE_CREDITS_ENV]: "1" }), true);
  for (const value of ["typo", "disabled", "0 ", "true"]) {
    assert.equal(usageCreditsAllowed({ [ALLOW_USAGE_CREDITS_ENV]: value }), false, value);
  }

  const rejection = usageCreditsRejectionError(
    "API Error: 400 Third-party apps now draw from your extra usage, not your plan limits.",
  );
  assert.ok(rejection);
  assert.match(rejection.message, /^Claude Code billing:/);
  assert.match(rejection.message, /setting PI_CLAUDE_NATIVE_ENTRYPOINT to an empty string/);
  const outOfCredits = usageCreditsRejectionError("You're out of extra usage.");
  assert.ok(outOfCredits);
  assert.doesNotMatch(outOfCredits.message, /PI_CLAUDE_NATIVE_ENTRYPOINT/);
  assert.equal(usageCreditsRejectionError("overloaded"), undefined);
});

test("stops after an overage charge unless usage credits are allowed", async (t) => {
  const run = async (stdout: unknown[], allow: boolean) => (await runNative(t, {
    context,
    model: nativeModel({ id: "claude-haiku-4-5-20251001", reasoning: false, maxTokens: 8_192 }),
    env: {
      DISABLE_PROMPT_CACHING: "0",
      CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
      [ALLOW_USAGE_CREDITS_ENV]: allow ? "1" : "",
    },
    stdout,
  })).events;

  const failure = errorMessage(await run(reply("ok", true), false));
  assert.match(failure.errorMessage ?? "", /^Claude Code billing:/);
  assert.equal(isRetryableAssistantError(failure), false);
  assert.ok(failure.diagnostics?.some((item) => item.type === RATE_LIMIT_DIAGNOSTIC));

  const allowed = doneMessage(await run(reply("ok", true), true));
  assert.equal(allowed.content.some((block) => block.type === "text" && block.text === "ok"), true);
  assert.ok(allowed.diagnostics?.some((item) => item.type === RATE_LIMIT_DIAGNOSTIC));

  const rejected = errorMessage(await run(rejection, false));
  assert.match(rejected.errorMessage ?? "", /^Claude Code billing: .*usage credits/);
  assert.equal(isRetryableAssistantError(rejected), false);

  const quote = "You're out of extra usage, as the docs say.";
  const quoted = doneMessage(await run(reply(quote, false), false));
  assert.equal(quoted.content.some((block) => block.type === "text" && block.text === quote), true);
});
