/**
 * Offline harness for end-to-end provider tests: a fake `claude` child and a
 * loopback upstream that answers the child's one Messages request.
 *
 * The fake follows what Claude Code 2.1.322 does under the provider. It
 * acknowledges each historical frame with a zero-turn result. For the final
 * frame it sends one upstream request, then prints the stdout lines the test
 * gives it and exits with the given code. A tool-use turn, for example, ends
 * with `result` subtype `error_max_turns` and exit code 1.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type test from "node:test";
import type {
  Api,
  AssistantMessageEvent,
  Model,
  TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { PROVIDER_ID } from "../../src/models.ts";
import { defaultDeps, streamClaudeNative, type CallDeps } from "../../src/stream.ts";

const FAKE_CLAUDE = `#!/usr/bin/env node
import readline from "node:readline";

const usage = { input_tokens: 3, output_tokens: 5 };
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
    body: JSON.stringify({ model: "fake", messages: [{ role: "user", content: "fake" }] }),
  });
  await response.text();
  for (const record of JSON.parse(process.env.FAKE_STDOUT)) console.log(JSON.stringify(record));
  process.exitCode = Number(process.env.FAKE_EXIT_CODE);
  break;
}
`;

/** A content block of a native assistant response. */
export type NativeBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

const USAGE = { input_tokens: 3, output_tokens: 5 };

/** The upstream SSE body for one assistant response. */
export function sseResponse(blocks: NativeBlock[], stopReason: string): string {
  const events: unknown[] = [
    { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", content: [], usage: USAGE } },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push(
        { type: "content_block_start", index, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
      );
    } else {
      events.push(
        { type: "content_block_start", index, content_block: { ...block, input: {} } },
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
      );
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: USAGE },
    { type: "message_stop" },
  );
  return events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** The stdout Claude Code prints for one assistant response: one line per block, then the result. */
export function stdoutRecords(blocks: NativeBlock[], resultSubtype: string): unknown[] {
  return [
    ...blocks.map((block) => ({
      type: "assistant",
      message: { id: "msg_fake", type: "message", role: "assistant", content: [block], usage: USAGE },
    })),
    {
      type: "result",
      subtype: resultSubtype,
      is_error: resultSubtype !== "success",
      num_turns: resultSubtype === "success" ? 1 : 2,
      usage: USAGE,
      total_cost_usd: 0,
    },
  ];
}

export function nativeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "claude-haiku-4-5",
    name: "Haiku",
    api: "claude-native" as Api,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-native",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
    ...overrides,
  };
}

export interface NativeRun {
  context: TranscriptContext;
  /** Upstream SSE body. */
  sse: string;
  /** Records the fake child prints after the upstream response. */
  stdout: unknown[];
  exitCode: number;
  model?: Model<Api>;
}

/** Stream one provider call through the fake child and loopback upstream. */
export async function runNative(t: test.TestContext, run: NativeRun): Promise<AssistantMessageEvent[]> {
  const upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(run.sse);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-native-harness-")));
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
  const events: AssistantMessageEvent[] = [];
  const stream = streamClaudeNative(run.model ?? nativeModel(), run.context, {
    timeoutMs: 5_000,
    env: {
      PI_CLAUDE_NATIVE_TEST_UPSTREAM: "1",
      PI_CLAUDE_NATIVE_COMMAND: executable,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      FAKE_STDOUT: JSON.stringify(run.stdout),
      FAKE_EXIT_CODE: String(run.exitCode),
    },
  }, deps);
  for await (const event of stream) events.push(event);
  return events;
}
