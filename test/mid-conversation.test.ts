/**
 * Opt-in mid-conversation system messages (#3), including the empty-assistant
 * count from #13.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, Tool } from "@earendil-works/pi-ai/compat";
import {
  midConversationEnabled,
  planMidConversation,
  type MidConversationPlan,
} from "../src/mid-conversation.js";
import { rewriteNativeRequest } from "../src/native-rewrite.js";
import { encodeCarrier, messageProjection, prepareHistory } from "../src/replay.js";
import { buildRequestBody, toolPrefixedName } from "../src/request.js";

const tool = (name: string, description = name): Tool =>
  ({ name, description, parameters: { type: "object", properties: {} } }) as unknown as Tool;
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const assistant = (text: string): Message =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "x",
    provider: "x",
    model: "x",
    usage: {},
    stopReason: "stop",
    timestamp: 0,
  }) as unknown as Message;
const system = (fields: Record<string, unknown>): Message =>
  ({ role: "system", content: "", timestamp: 0, ...fields }) as unknown as Message;

const nativeTools = (tools: Tool[]) =>
  buildRequestBody({ tools }).body["tools"] as Array<{ name: string }>;

function plan(messages: Message[], currentPrompt: string, currentTools: string[]) {
  const history = messages.filter((m) => m.role !== "system");
  return planMidConversation({
    messages,
    currentPrompt,
    currentToolNames: currentTools.map(toolPrefixedName),
    assistantFramesBefore: prepareHistory(history).assistantFramesBefore,
    nativeTools,
    nativeName: toolPrefixedName,
    toolsEnabled: true,
  });
}

/** A session that adds tool `b` and updates a section after the first reply. */
const session: Message[] = [
  system({ content: "base", tools: undefined, toolsAdded: [tool("a")] }),
  user("one"),
  assistant("reply"),
  system({ sections: { s: "new" }, toolsAdded: [tool("b")] }),
  user("two"),
];

const nativeBody = (messages: unknown[], tools = ["a", "b"]) => ({
  system: [{ type: "text", text: "billing" }, { type: "text", text: "COLLAPSED" }],
  tools: tools.map((name) => ({ name: toolPrefixedName(name) })),
  messages,
});

test("#3 the flag accepts 1 and 0 and rejects anything else", () => {
  assert.equal(midConversationEnabled({}), false);
  assert.equal(midConversationEnabled({ PI_DIRECTSDK_MID_CONVERSATION_SYSTEM: "0" }), false);
  assert.equal(midConversationEnabled({ PI_DIRECTSDK_MID_CONVERSATION_SYSTEM: "1" }), true);
  assert.throws(() => midConversationEnabled({ PI_DIRECTSDK_MID_CONVERSATION_SYSTEM: "yes" }));
});

test("#3 later changes become a system message before the next assistant turn", () => {
  const p = plan(session, "COLLAPSED", ["a", "b"]) as MidConversationPlan;
  assert.equal(typeof p, "object");
  const raw = Buffer.from(
    JSON.stringify(
      nativeBody([
        { role: "system", content: "env" },
        { role: "user", content: "one" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "two" },
      ]),
    ),
  );
  const { body, midConversation: report } = rewriteNativeRequest(raw, [], p);
  assert.deepEqual(report, { applied: true, updates: 1, nativeToolChanges: true, skipped: null });
  const sent = JSON.parse(body.toString()) as Record<string, unknown>;
  assert.deepEqual(sent["system"], [
    { type: "text", text: "billing" },
    { type: "text", text: "base" },
  ]);
  assert.deepEqual(
    (sent["tools"] as Array<Record<string, unknown>>).map((t) => [t["name"], t["defer_loading"] ?? false]),
    [
      [toolPrefixedName("a"), false],
      ["__pi_deferred_placeholder__", true],
      [toolPrefixedName("b"), true],
    ],
  );
  // The update for the second user turn lands after the last assistant message.
  assert.deepEqual(sent["messages"], [
    { role: "system", content: "env" },
    { role: "user", content: "one" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "two" },
    {
      role: "system",
      content: [
        { type: "text", text: 'Updated system prompt section "s":\n\nnew' },
        { type: "tool_addition", tool: { type: "tool_reference", name: toolPrefixedName("b") } },
      ],
    },
  ]);
});

test("#3 a redefined tool keeps section updates but sends the current tool list", () => {
  const redefined: Message[] = [
    ...session.slice(0, 3),
    system({ sections: { s: "new" }, toolsAdded: [tool("a", "changed")] }),
    user("two"),
  ];
  const p = plan(redefined, "COLLAPSED", ["a"]) as MidConversationPlan;
  assert.equal(p.wireTools, null);
  assert.deepEqual(p.updates, [
    { beforeAssistant: 1, content: [{ type: "text", text: 'Updated system prompt section "s":\n\nnew' }] },
  ]);
});

test("#3 fallbacks forward the collapsed body unchanged", () => {
  const p = plan(session, "COLLAPSED", ["a", "b"]) as MidConversationPlan;
  const withEnv = [
    { role: "system", content: "env" },
    { role: "user", content: "one" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "two" },
  ];
  const cases: Array<[unknown, string]> = [
    [nativeBody(withEnv.slice(1)), "route has no mid-conversation system messages"],
    [{ ...nativeBody(withEnv), system: [{ type: "text", text: "other" }] }, "leading prompt not uniquely matched"],
    [nativeBody(withEnv, ["a"]), "tool list differs from the current tools"],
    [nativeBody(withEnv.slice(0, 2)), "assistant messages do not match the replay"],
  ];
  for (const [input, skipped] of cases) {
    const raw = Buffer.from(JSON.stringify(input));
    const { body, midConversation: report } = rewriteNativeRequest(raw, [], p);
    assert.equal(body, raw, skipped);
    assert.equal(report?.skipped, skipped);
  }
  assert.equal(plan(session.slice(1), "x", []), "transcript has no leading system message");
});

test("#13 replayed assistant frames holding only empty text are not counted", () => {
  // A native carrier can restore an assistant frame whose only block is empty
  // text; the CLI drops such a frame, so it must not shift insertion points.
  const empty = assistant("") as Message & { diagnostics?: unknown[] };
  empty.diagnostics = [
    encodeCarrier(
      [{ role: "assistant", content: [{ type: "text", text: "" }] }],
      messageProjection(empty as Parameters<typeof messageProjection>[0]),
    ),
  ];
  const { frames, assistantFramesBefore } = prepareHistory([
    user("one"),
    empty,
    user("two"),
    assistant("reply"),
    user("three"),
  ]);
  assert.equal(frames.filter((f) => f.type === "assistant").length, 2);
  assert.deepEqual(assistantFramesBefore, [0, 0, 0, 0, 1, 1]);
});
