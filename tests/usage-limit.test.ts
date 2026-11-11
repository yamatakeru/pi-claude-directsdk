import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai/compat";
import { errorMessage, nativeModel, runNative } from "./support/native.ts";

// At a usage limit, `claude -p` can exit 1 with no result line, no error and
// empty stderr (anthropics/claude-code#103820, #104343). The relay still saw
// the upstream rejection, which is what the user needs to read.
test("an upstream rejection is reported when the CLI ends without a result", async (t) => {
  const { events } = await runNative(t, {
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as unknown as TranscriptContext,
    model: nativeModel({ id: "claude-haiku-5-5", maxTokens: 64 }),
    upstream: {
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit." },
      }),
    },
    stdout: [],
    exitCode: 1,
  });

  const message = errorMessage(events).errorMessage ?? "";
  assert.match(message, /status 429/);
  assert.match(message, /upstream said: .*would exceed your account's rate limit/);
  assert.match(message, /native result lines: 0 \(exit 1/);
});
