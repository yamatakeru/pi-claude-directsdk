/** Per-turn effort placement keeps the cached prefix across a level change (#5). */

import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Message, TranscriptContext } from "@earendil-works/pi-ai/compat";
import { PROVIDER_ID } from "../src/models.ts";
import { rewriteNativeRequest } from "../src/native-rewrite.ts";
import { encodeCarrier, messageProjection } from "../src/replay.ts";
import { prepareNativeTranscript } from "../src/transcript.ts";
import { placeTurnEfforts, planTurnEfforts, recordedTurnEfforts } from "../src/turn-effort.ts";
import { doneMessage, nativeModel, resultLine, runNative, sseResponse } from "./support/native.ts";

type Wire = Record<string, unknown>;

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const MAP = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" };

function assistant(text: string, fields: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", api: "claude-native", provider: PROVIDER_ID, model: "claude-opus-5-5",
    content: [{ type: "text", text }], usage, stopReason: "stop", timestamp: 0, ...fields,
  } as AssistantMessage;
}

const user = (text: string): Wire => ({ role: "user", content: [{ type: "text", text }] });
const reply = (text: string): Wire => ({ role: "assistant", content: [{ type: "text", text }] });
const environment = (effort: string): Wire => ({ role: "system", content: "# Environment", output_config: { effort } });
const statement = (effort: string): Wire => ({ role: "system", content: [], output_config: { effort } });

/** The request the CLI builds from replayed history: one statement, the current level, on its environment message. */
function cliRequest(turns: number, current: string): Wire {
  const messages: Wire[] = [user("u0"), environment(current)];
  for (let i = 0; i < turns; i += 1) messages.push(reply(`A${i}`), user(`u${i + 1}`));
  return { messages, output_config: { effort: current } };
}

function place(frames: string[], current: string): Wire {
  const body = cliRequest(frames.length, current);
  assert.equal(placeTurnEfforts(body, { frames, current }), "turnEffortsPlaced");
  return body;
}

test("recorded efforts prefer the effort this provider sent, then Pi's mapped level", () => {
  const twoFrames = assistant("two frames");
  const native = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }] });
  twoFrames.diagnostics = [encodeCarrier([native("two"), native("frames")], messageProjection(twoFrames))];
  twoFrames.thinkingLevel = "medium";
  const history: Message[] = [
    { role: "user", content: "u0", timestamp: 0 },
    assistant("sent", { providerThinkingLevel: "xhigh", thinkingLevel: "high" }),
    assistant("mapped", { thinkingLevel: "minimal" }),
    assistant("other provider", { provider: "anthropic", providerThinkingLevel: "max", thinkingLevel: "medium" }),
    // A level the current model lacks, sent on another model, is not restated.
    assistant("other model", { model: "claude-opus-5-5", providerThinkingLevel: "max", thinkingLevel: "high" }),
    assistant("unknown"),
    assistant("", { content: [] }),
    twoFrames,
  ];
  // The empty turn is not replayed, so it has no frame; a carrier replays one frame per native message.
  assert.deepEqual(recordedTurnEfforts(history, MAP), ["xhigh", "low", "medium", "high", undefined, "medium", "medium"]);
});

test("a turn without a known effort takes the next known one, the last ones the current", () => {
  assert.deepEqual(planTurnEfforts(["high", undefined, "medium", undefined], "low"), {
    frames: ["high", "medium", "medium", "low"],
    current: "low",
  });
  assert.equal(planTurnEfforts(["high"], undefined), undefined);
});

test("a level change states the old level on the environment message and the new one after the last user message", () => {
  const body = place(["high", "high"], "medium");
  assert.deepEqual(body["messages"], [
    user("u0"), environment("high"), reply("A0"), user("u1"), reply("A1"), user("u2"), statement("medium"),
  ]);
  // The top-level effort follows the last statement, as in the CLI's own requests.
  assert.deepEqual(body["output_config"], { effort: "medium" });
});

test("an earlier change is stated before the reply it governed", () => {
  const body = place(["high", "medium"], "medium");
  assert.deepEqual(body["messages"], [
    user("u0"), environment("high"), reply("A0"), user("u1"), statement("medium"), reply("A1"), user("u2"),
  ]);
});

test("each request starts with the previous one, so the cached prefix survives the change", () => {
  const levels = ["high", "high", "medium", "medium", "high"];
  let previous: Wire[] | undefined;
  for (let turns = 1; turns < levels.length; turns += 1) {
    const frames = levels.slice(0, turns);
    const current = levels[turns]!;
    const body = cliRequest(turns, current);
    placeTurnEfforts(body, { frames, current });
    const messages = body["messages"] as Wire[];
    if (previous) {
      // Through the last user message: a trailing statement is the next turn's own.
      const through = previous.findLastIndex((message) => message["role"] === "user");
      assert.deepEqual(messages.slice(0, through + 1), previous.slice(0, through + 1), `request ${turns}`);
      if (previous[through + 1] !== undefined) {
        assert.deepEqual(messages[through + 1], previous[through + 1], `request ${turns} keeps the statement`);
      }
    }
    previous = messages;
  }
});

test("a statement rides on a system message already at its position, keeping its other settings", () => {
  const body: Wire = {
    messages: [
      user("u0"), environment("medium"), reply("A0"), user("u1"),
      { role: "system", content: [{ type: "tool_addition" }], output_config: { timing: { type: "now" } } },
      reply("A1"), user("u2"),
    ],
    output_config: { effort: "medium" },
  };
  assert.equal(placeTurnEfforts(body, { frames: ["high", "medium"], current: "medium" }), "turnEffortsPlaced");
  assert.deepEqual((body["messages"] as Wire[])[4], {
    role: "system", content: [{ type: "tool_addition" }], output_config: { timing: { type: "now" }, effort: "medium" },
  });
  assert.deepEqual((body["messages"] as Wire[])[1], environment("high"));
});

test("a change after a tool-result turn is stated after it, and consecutive user messages share one statement", () => {
  const toolResult: Wire = { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "r" }] };
  const body: Wire = {
    messages: [user("u0"), environment("medium"), reply("A0"), toolResult, user("u1")],
    output_config: { effort: "medium" },
  };
  assert.equal(placeTurnEfforts(body, { frames: ["high"], current: "medium" }), "turnEffortsPlaced");
  assert.deepEqual(body["messages"], [user("u0"), environment("high"), reply("A0"), toolResult, user("u1"), statement("medium")]);
});

test("a statement merges into an injected tool-change message, at a boundary and at the tail", () => {
  const tool = { name: "alpha", description: "alpha", parameters: { type: "object", properties: {} } };
  const later = { name: "beta", description: "beta", parameters: { type: "object", properties: {} } };
  const transcript = prepareNativeTranscript([
    { role: "system", content: "base", toolsAdded: [tool], timestamp: 0 },
    { role: "user", content: "u0", timestamp: 1 },
    assistant("A0"),
    { role: "system", content: "beta", toolsAdded: [later], timestamp: 2 },
    { role: "user", content: "u1", timestamp: 3 },
    assistant("A1"),
    { role: "user", content: "u2", timestamp: 4 },
    { role: "system", content: "gamma", timestamp: 5 },
  ] as Message[], true)!;
  const raw = Buffer.from(JSON.stringify(cliRequest(2, "low")));
  const { body } = rewriteNativeRequest(raw, [], transcript, { frames: ["high", "medium"], current: "low" });
  const messages = JSON.parse(body.toString()).messages as Wire[];
  assert.deepEqual(messages.map((message) => [message["role"], (message["output_config"] as Wire | undefined)?.["effort"]]), [
    ["user", undefined], ["system", "high"], ["assistant", undefined], ["user", undefined],
    ["system", "medium"], ["assistant", undefined], ["user", undefined], ["system", "low"],
  ]);
  // Both statements after the first rode on the injected messages.
  assert.ok(Array.isArray(messages[4]?.["content"]) && (messages[4]["content"] as unknown[]).length > 0);
  assert.ok(Array.isArray(messages[7]?.["content"]) && (messages[7]["content"] as unknown[]).length > 0);
});

test("a request already at every recorded level is left alone", () => {
  const body = cliRequest(2, "high");
  const before = structuredClone(body);
  assert.equal(placeTurnEfforts(body, { frames: ["high", "high"], current: "high" }), null);
  assert.deepEqual(body, before);
});

test("an unexpected request shape is forwarded as built", () => {
  const cases: Array<[Wire, string]> = [
    // The CLI does not use per-turn effort for this model.
    [{ messages: [user("u0"), reply("A0"), user("u1")], output_config: { effort: "medium" } }, "turn efforts: no per-turn statement from the CLI"],
    // The CLI already states more than one level.
    [{ messages: [user("u0"), environment("medium"), reply("A0"), user("u1"), statement("medium")] }, "turn efforts: no per-turn statement from the CLI"],
    // The statement is not the level this call asked for.
    [{ messages: [user("u0"), environment("low"), reply("A0"), user("u1")] }, "turn efforts: no per-turn statement from the CLI"],
    [{ messages: [user("u0"), environment("medium"), user("u1")] }, "turn efforts: assistant messages do not match the replay"],
    // The statement is not where the first one goes.
    [{ messages: [user("u0"), { role: "system", content: "x" }, environment("medium"), reply("A0"), user("u1")] }, "turn efforts: no per-turn statement from the CLI"],
    [{ messages: [user("u0"), environment("medium"), null, reply("A0"), user("u1")] }, "turn efforts: no per-turn statement from the CLI"],
  ];
  for (const [body, skip] of cases) {
    const before = structuredClone(body);
    assert.equal(placeTurnEfforts(body, { frames: ["high"], current: "medium" }), skip);
    assert.deepEqual(body, before);
  }
});

test("the rewrite reports the placement, and forwards the original bytes when nothing applies", () => {
  const placed = rewriteNativeRequest(Buffer.from(JSON.stringify(cliRequest(1, "medium"))), [], undefined, {
    frames: ["high"], current: "medium",
  });
  assert.ok(placed.nativeContext.applied.includes("turnEffortsPlaced"));
  assert.deepEqual(JSON.parse(placed.body.toString()).messages.at(-1), statement("medium"));

  const raw = Buffer.from(JSON.stringify(cliRequest(1, "high")));
  const untouched = rewriteNativeRequest(raw, [], undefined, { frames: ["high"], current: "high" });
  assert.equal(untouched.body, raw);
});

test("a call records the effort it sent and states earlier levels upstream", async (t) => {
  const context = {
    messages: [
      { role: "system", content: "base", timestamp: 0 },
      { role: "user", content: "u0", timestamp: 1 },
      assistant("A0", { thinkingLevel: "high" }),
      { role: "user", content: "u1", timestamp: 3 },
    ],
  } as unknown as TranscriptContext;
  const { events, upstreamRequests } = await runNative(t, {
    context,
    model: nativeModel({ thinkingLevelMap: MAP }),
    options: { reasoning: "medium" },
    upstream: { body: sseResponse({ blocks: [{ type: "text", text: "ok" }], stopReason: "end_turn" }) },
    request: { messages: [user("u0"), environment("medium"), reply("A0"), user("u1")] },
    stdout: [
      { type: "assistant", message: { id: "msg_test", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } },
      resultLine("success"),
    ],
  });
  const message = doneMessage(events);
  assert.equal(message.providerThinkingLevel, "medium");
  const body = upstreamRequests[0]?.body as Wire;
  assert.deepEqual(body["messages"], [user("u0"), environment("high"), reply("A0"), user("u1"), statement("medium")]);
  const meta = message.diagnostics?.find((diagnostic) => diagnostic.type === "pi-claude-native/meta");
  assert.ok((meta?.details as { nativeContext: { applied: string[] } }).nativeContext.applied.includes("turnEffortsPlaced"));
});
