/**
 * Replay-stable native context (#1, #13). Each fixture is the shape the CLI
 * sent on Claude Code 2.1.303 (see docs/transport-measurements.md), reduced
 * to the blocks the relay inspects.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteNativeRequest } from "../src/native-rewrite.js";
import type { NativeContentBlock } from "../src/types.js";

const CC = { type: "ephemeral", ttl: "1h" } as const;
const REMINDER = "<system-reminder>session context</system-reminder>";
const DATE = "Today's date is 2026-10-22.";

function run(body: unknown, queried: NativeContentBlock[]) {
  const raw = Buffer.from(JSON.stringify(body));
  const rewrite = rewriteNativeRequest(raw, queried);
  const result = { body: rewrite.body, report: rewrite.nativeContext };
  return { raw, result, body: JSON.parse(result.body.toString()) as Record<string, unknown> };
}

test("#1 opening request: CLI text moves behind the queried frame", () => {
  const { result, body } = run(
    {
      messages: [
        { role: "system", content: `env\n\n${DATE}` },
        {
          role: "user",
          content: [
            { type: "text", text: REMINDER },
            { type: "text", text: "hello", cache_control: CC },
          ],
        },
      ],
    },
    [{ type: "text", text: "hello" }],
  );
  assert.deepEqual(result.report, { applied: ["openingReordered"], skipped: [] });
  assert.deepEqual(body["messages"], [
    { role: "system", content: `env\n\n${DATE}` },
    {
      role: "user",
      content: [
        { type: "text", text: "hello", cache_control: CC },
        { type: "text", text: REMINDER },
      ],
    },
  ]);
});

test("#1 later user turn: date line returns, reminder is dropped, breakpoint follows", () => {
  const { result, body } = run(
    {
      messages: [
        { role: "system", content: "env" },
        { role: "user", content: [{ type: "text", text: "hello", cache_control: CC }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
        {
          role: "user",
          content: [
            { type: "text", text: REMINDER },
            { type: "text", text: "next" },
          ],
        },
        { role: "system", content: [{ type: "text", text: DATE, cache_control: CC }] },
      ],
    },
    [{ type: "text", text: "next" }],
  );
  assert.deepEqual(result.report, { applied: ["dateLineRestored", "reminderDropped"], skipped: [] });
  assert.deepEqual(body["messages"], [
    { role: "system", content: `env\n\n${DATE}` },
    { role: "user", content: [{ type: "text", text: "hello", cache_control: CC }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "next", cache_control: CC }] },
  ]);
});

const toolTurn = (results: unknown[]) => ({
  messages: [
    { role: "user", content: [{ type: "text", text: "run", cache_control: CC }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "mcp__pi__a", input: {} },
        { type: "tool_use", id: "t2", name: "mcp__pi__b", input: {} },
      ],
    },
    { role: "user", content: results },
  ],
});

test("#1 string tool result: appended CLI text is stripped", () => {
  const { result, body } = run(
    toolTurn([
      { type: "tool_result", tool_use_id: "t1", content: "one" },
      { type: "tool_result", tool_use_id: "t2", content: `two${REMINDER}`, cache_control: CC },
    ]),
    [
      { type: "tool_result", tool_use_id: "t1", content: "one" },
      { type: "tool_result", tool_use_id: "t2", content: "two" },
    ],
  );
  assert.deepEqual(result.report, { applied: ["toolResultRestored"], skipped: [] });
  assert.deepEqual((body["messages"] as unknown[])[2], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "one" },
      { type: "tool_result", tool_use_id: "t2", content: "two", cache_control: CC },
    ],
  });
});

test("#1 parallel results and user text: trailing CLI text is stripped", () => {
  // The CLI's marker sits on the split-out date message, not on the reminder.
  const { result, body } = run(
    {
      messages: [
        { role: "system", content: "env" },
        ...toolTurn([
          { type: "tool_result", tool_use_id: "t1", content: "one" },
          { type: "tool_result", tool_use_id: "t2", content: "two" },
          { type: "text", text: "also" },
          { type: "text", text: REMINDER },
        ]).messages,
        { role: "system", content: [{ type: "text", text: DATE, cache_control: CC }] },
      ],
    },
    [
      { type: "tool_result", tool_use_id: "t1", content: "one" },
      { type: "tool_result", tool_use_id: "t2", content: "two" },
      { type: "text", text: "also" },
    ],
  );
  assert.deepEqual(result.report.applied, ["toolResultRestored", "dateLineRestored"]);
  assert.deepEqual((body["messages"] as Array<{ content: unknown }>)[3]?.content, [
    { type: "tool_result", tool_use_id: "t1", content: "one" },
    { type: "tool_result", tool_use_id: "t2", content: "two" },
    { type: "text", text: "also", cache_control: CC },
  ]);
});

test("#13 newest tool result trimmed by the CLI is restored", () => {
  const { result, body } = run(
    toolTurn([
      { type: "tool_result", tool_use_id: "t1", content: "one" },
      { type: "tool_result", tool_use_id: "t2", content: `two${REMINDER}`, cache_control: CC },
    ]),
    [
      { type: "tool_result", tool_use_id: "t1", content: "one" },
      { type: "tool_result", tool_use_id: "t2", content: "\ntwo\n" },
    ],
  );
  assert.deepEqual(result.report.applied, ["toolResultRestored"]);
  const content = (body["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[2]?.content;
  assert.equal(content?.[1]?.["content"], "\ntwo\n");
});

test("#13 the trimmed match is limited to the newest result and to nonblank text", () => {
  const older = run(
    toolTurn([
      { type: "tool_result", tool_use_id: "t1", content: "one" },
      { type: "tool_result", tool_use_id: "t2", content: `two${REMINDER}` },
    ]),
    [
      { type: "tool_result", tool_use_id: "t1", content: "one\n" },
      { type: "tool_result", tool_use_id: "t2", content: "two" },
    ],
  );
  assert.deepEqual(older.result.report.skipped, ["queried tool results not uniquely matched"]);

  const blank = run(
    toolTurn([
      { type: "tool_result", tool_use_id: "t1", content: "one" },
      { type: "tool_result", tool_use_id: "t2", content: REMINDER },
    ]),
    [
      { type: "tool_result", tool_use_id: "t1", content: "one" },
      { type: "tool_result", tool_use_id: "t2", content: "   " },
    ],
  );
  assert.deepEqual(blank.result.report.skipped, ["queried tool results not uniquely matched"]);
});

test("#1 tool-use IDs that do not anchor the frame skip restoration", () => {
  const { raw, result } = run(
    toolTurn([
      { type: "tool_result", tool_use_id: "t2", content: "two" },
      { type: "tool_result", tool_use_id: "t1", content: `one${REMINDER}` },
    ]),
    [
      { type: "tool_result", tool_use_id: "t1", content: "one" },
      { type: "tool_result", tool_use_id: "t2", content: "two" },
    ],
  );
  assert.deepEqual(result.report, {
    applied: [],
    skipped: ["queried tool results not uniquely matched"],
  });
  assert.equal(result.body, raw);
});

test("#1 a later marker moves onto the last replay-stable block", () => {
  const { result, body } = run(
    {
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "next" },
            { type: "text", text: REMINDER, cache_control: CC },
          ],
        },
      ],
    },
    [{ type: "text", text: "next" }],
  );
  assert.deepEqual(result.report.applied, ["breakpointPinned"]);
  assert.deepEqual((body["messages"] as Array<{ content: unknown }>)[2]?.content, [
    { type: "text", text: "next", cache_control: CC },
    { type: "text", text: REMINDER },
  ]);
});

test("#1 several later markers fold into one on the replay-stable block", () => {
  const other = { type: "ephemeral", ttl: "5m" } as const;
  const { result, body } = run(
    {
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "next" },
            { type: "text", text: REMINDER, cache_control: CC },
            { type: "text", text: "more CLI text", cache_control: other },
          ],
        },
      ],
    },
    [{ type: "text", text: "next" }],
  );
  assert.deepEqual(result.report.applied, ["breakpointPinned"]);
  assert.deepEqual((body["messages"] as Array<{ content: unknown }>)[2]?.content, [
    { type: "text", text: "next", cache_control: CC },
    { type: "text", text: REMINDER },
    { type: "text", text: "more CLI text" },
  ]);
});

test("#1 a non-Messages body is forwarded unchanged", () => {
  const raw = Buffer.from("not json");
  const result = rewriteNativeRequest(raw, [{ type: "text", text: "x" }]);
  assert.equal(result.body, raw);
  assert.deepEqual(result.nativeContext, { applied: [], skipped: ["body is not a Messages request"] });
});

test("#1 an empty queried frame is reported as such", () => {
  const raw = Buffer.from(JSON.stringify({ messages: [] }));
  const result = rewriteNativeRequest(raw, []);
  assert.equal(result.body, raw);
  assert.deepEqual(result.nativeContext, { applied: [], skipped: ["queried frame is empty"] });
});
