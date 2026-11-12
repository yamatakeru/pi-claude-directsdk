/**
 * Offline harness for end-to-end provider tests: a fake `claude` child and an
 * optional loopback upstream for the child's one Messages request.
 *
 * The fake follows what Claude Code 2.1.322 does under the provider. It
 * acknowledges each historical frame with a zero-turn result. For the final
 * frame it sends one upstream request when the run has an upstream, then
 * prints the stdout records the test gives it and exits with the given code.
 * Without an upstream the provider falls back to the child's stdout, which
 * covers the non-relay path.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type test from "node:test";
import type {
  Api,
  AssistantMessageEvent,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { PROVIDER_ID } from "../../src/models.ts";
import { defaultDeps, streamClaudeNative, type CallDeps } from "../../src/stream.ts";

const USAGE = { input_tokens: 3, output_tokens: 5 };

const FAKE_CLAUDE = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const plan = JSON.parse(readFileSync(process.env.FAKE_PLAN, "utf8"));
const settingsPath = process.argv[process.argv.indexOf("--settings") + 1];
const extraBody = JSON.parse(JSON.parse(readFileSync(settingsPath, "utf8")).env.CLAUDE_CODE_EXTRA_BODY);
writeFileSync(plan.childRequestPath, JSON.stringify({
  body: extraBody,
  maxOutputTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null,
}));

const usage = ${JSON.stringify(USAGE)};
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  if (frame.shouldQuery === false) {
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, usage }));
    continue;
  }
  for (let attempt = 0; plan.request && attempt < (plan.request.attempts ?? 1); attempt++) {
    const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...plan.request.headers },
      body: JSON.stringify({ ...extraBody, messages: plan.request.messages }),
    });
    await response.text();
  }
  for (const record of plan.stdout) console.log(JSON.stringify(record));
  process.exitCode = plan.exitCode;
  break;
}
`;

/** A content block of a native assistant response. */
type NativeBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      /** Streamed input when it differs from `input`, such as a call cut off at max_tokens. */
      partialJson?: string;
    };

/** One native assistant response. */
export interface NativeResponse {
  blocks: NativeBlock[];
  stopReason: string;
  usage?: Record<string, unknown>;
}

/** The Messages stream events of a response, from message_start to message_stop. */
function nativeEvents(response: NativeResponse): unknown[] {
  const usage = response.usage ?? USAGE;
  const events: unknown[] = [
    { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", content: [], usage } },
  ];
  response.blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push(
        { type: "content_block_start", index, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
      );
    } else if (block.type === "thinking") {
      events.push(
        { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
        ...(block.thinking ? [{ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }] : []),
        { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } },
      );
    } else {
      const { partialJson, ...start } = block;
      events.push(
        { type: "content_block_start", index, content_block: { ...start, input: {} } },
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partialJson ?? JSON.stringify(block.input) } },
      );
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    { type: "message_delta", delta: { stop_reason: response.stopReason }, usage },
    { type: "message_stop" },
  );
  return events;
}

/** The upstream SSE body of a response. */
export function sseResponse(response: NativeResponse): string {
  return nativeEvents(response)
    .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

/** The child's `stream_event` lines for a response. */
export function streamEventLines(response: NativeResponse): unknown[] {
  return nativeEvents(response).map((event) => ({ type: "stream_event", event }));
}

/** The child's assistant lines for a response: one line per block, without a stop reason. */
export function assistantLines(response: NativeResponse): unknown[] {
  return response.blocks.map((block) => {
    const content = block.type === "tool_use"
      ? { type: "tool_use", id: block.id, name: block.name, input: block.input }
      : block;
    return {
      type: "assistant",
      message: { id: "msg_fake", type: "message", role: "assistant", content: [content], usage: response.usage ?? USAGE },
    };
  });
}

/** The child's result line. */
export function resultLine(subtype: string, fields: Record<string, unknown> = {}): unknown {
  return {
    type: "result",
    subtype,
    is_error: subtype !== "success",
    num_turns: 1,
    usage: USAGE,
    total_cost_usd: 0,
    ...fields,
  };
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
  model?: Model<Api>;
  /** Added to the provider's environment. */
  env?: Record<string, string>;
  /** Call options; the harness owns `env`. */
  options?: Omit<Partial<SimpleStreamOptions>, "env">;
  /** The upstream's answer to the child's request. Without it the child sends none. */
  upstream?: { status?: number; contentType?: string; body: string };
  /** Messages and headers of the child's request. Its body also carries `CLAUDE_CODE_EXTRA_BODY`. */
  request?: { messages?: unknown[]; headers?: Record<string, string>; attempts?: number };
  /** Records the child prints for the final frame. */
  stdout: unknown[];
  exitCode?: number;
}

interface NativeOutcome {
  events: AssistantMessageEvent[];
  /** Requests the upstream received, after the relay. */
  upstreamRequests: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown> }>;
  /** What the provider gave the child: `CLAUDE_CODE_EXTRA_BODY` and the output-token limit. */
  childRequest: { body: Record<string, unknown>; maxOutputTokens: string | null } | null;
}

/** Stream one provider call through the fake child. */
export async function runNative(t: test.TestContext, run: NativeRun): Promise<NativeOutcome> {
  const upstreamRequests: NativeOutcome["upstreamRequests"] = [];
  let upstreamUrl: string | undefined;
  if (run.upstream) {
    const answer = run.upstream;
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        upstreamRequests.push({
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        });
        response.writeHead(answer.status ?? 200, { "content-type": answer.contentType ?? "text/event-stream" });
        response.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    upstreamUrl = `http://127.0.0.1:${address.port}`;
  }

  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-native-harness-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "fake-claude.mjs");
  await writeFile(executable, FAKE_CLAUDE, "utf8");
  await chmod(executable, 0o755);
  const childRequestPath = join(root, "child-request.json");
  const planPath = join(root, "plan.json");
  await writeFile(planPath, JSON.stringify({
    childRequestPath,
    request: run.upstream
      ? {
          messages: run.request?.messages ?? [{ role: "user", content: [{ type: "text", text: "fake" }] }],
          headers: run.request?.headers ?? {},
          attempts: run.request?.attempts,
        }
      : null,
    stdout: run.stdout,
    exitCode: run.exitCode ?? 0,
  }), "utf8");
  const deps: CallDeps = {
    ...defaultDeps,
    checkCli: () => true,
    makeRequestDir: () => mkdtempSync(join(root, "request-")),
    childCwd: () => root,
  };
  const events: AssistantMessageEvent[] = [];
  const stream = streamClaudeNative(run.model ?? nativeModel(), run.context, {
    timeoutMs: 5_000,
    ...run.options,
    env: {
      PI_CLAUDE_NATIVE_TEST_UPSTREAM: "1",
      PI_CLAUDE_NATIVE_COMMAND: executable,
      FAKE_PLAN: planPath,
      // Empty unless the run has an upstream, so a value in the shell cannot leak in.
      ANTHROPIC_BASE_URL: upstreamUrl ?? "",
      ...run.env,
    },
  }, deps);
  for await (const event of stream) events.push(event);
  const childRequest = existsSync(childRequestPath)
    ? JSON.parse(readFileSync(childRequestPath, "utf8")) as NativeOutcome["childRequest"]
    : null;
  return { events, upstreamRequests, childRequest };
}

/** The terminal event of a run, asserted to be `done`. */
export function doneMessage(events: AssistantMessageEvent[]) {
  const done = events.find((event) => event.type === "done");
  assert.ok(done && done.type === "done", JSON.stringify(events.find((event) => event.type === "error")));
  return done.message;
}

/** The terminal event of a run, asserted to be `error`. */
export function errorMessage(events: AssistantMessageEvent[]) {
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error", "expected an error event");
  return error.error;
}
