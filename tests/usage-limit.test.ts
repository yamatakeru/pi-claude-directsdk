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
  TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { PROVIDER_ID } from "../src/models.ts";
import { defaultDeps, streamClaudeNative, type CallDeps } from "../src/stream.ts";

// At a usage limit, `claude -p` can exit 1 with no result line, no error and
// empty stderr (anthropics/claude-code#103820, #104343). The relay still saw
// the upstream rejection, which is what the user needs to read.
const FAKE_CLAUDE = `#!/usr/bin/env node
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  if (frame.shouldQuery === false) {
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } }));
    continue;
  }
  const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] }),
  });
  await response.text();
  process.exitCode = 1;
  break;
}
`;

test("an upstream rejection is reported when the CLI ends without a result", async (t) => {
  const upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit." },
      }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-native-limit-")));
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
  const model = {
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
  } as Model<Api>;
  const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as unknown as TranscriptContext;
  const events: AssistantMessageEvent[] = [];
  const stream = streamClaudeNative(model, context, {
    timeoutMs: 5_000,
    env: {
      PI_CLAUDE_NATIVE_TEST_UPSTREAM: "1",
      PI_CLAUDE_NATIVE_COMMAND: executable,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    },
  }, deps);
  for await (const event of stream) events.push(event);

  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  const message = error.error.errorMessage ?? "";
  assert.match(message, /status 429/);
  assert.match(message, /upstream said: .*would exceed your account's rate limit/);
  assert.match(message, /native result lines: 0 \(exit 1/);
});
