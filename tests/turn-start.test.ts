/**
 * After a long tool loop the next turn must still read the conversation
 * before it. Once a user message carries more than tool results, the cache
 * entries written after the finished turn's first thinking block stop
 * matching; the next turn reads only the newest entry written before that
 * block. Anthropic's lookup walks back at most 20 positions from a breakpoint
 * (a run of tool_use or tool_result blocks counts once), so after a longer
 * loop the recurring breakpoint cannot reach that entry. Ported from the
 * Hermes reference relay's tests; the native layouts are Claude Code
 * 2.1.285 (two system marks, the message mark on the trailing date message)
 * and 2.1.287+ (also the last assistant block).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";
import { stabilizeNativeRequest } from "../src/native-context.ts";
import type { NativeContentBlock } from "../src/types.ts";

type Block = Record<string, unknown>;
type Message = { role: string; content: string | Block[] };
type Body = { tools: Block[]; system: Block[]; messages: Message[]; cache_control?: unknown };

const MARKER = { type: "ephemeral", ttl: "1h" };
const OPENING: Block = { type: "text", text: "Run the echo steps one at a time." + " source pack".repeat(200) };
const FOLLOW_UP: Block = { type: "text", text: "One more echo." };
const STEER: Block = { type: "text", text: "Also print the date." };
const LAYOUTS = {
  "2.1.285": {
    tools: [{ name: "mcp__pi__bash", input_schema: { type: "object" } }],
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc" },
      { type: "text", text: "You are Claude Code.", cache_control: MARKER },
      { type: "text", text: "Pi system prompt.", cache_control: MARKER },
    ],
    assistantMark: false,
  },
  "2.1.287": {
    tools: [{ name: "mcp__pi__bash", input_schema: { type: "object" }, cache_control: MARKER }],
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc" },
      { type: "text", text: "You are Claude Code. Pi system prompt.", cache_control: MARKER },
    ],
    assistantMark: true,
  },
} as const;
type Layout = keyof typeof LAYOUTS;

const clone = <T>(value: T): T => structuredClone(value);

function assistant(n: number, think: boolean, calls: number): Message {
  return {
    role: "assistant",
    content: [
      ...(think ? [{ type: "thinking", thinking: `plan ${n}`, signature: `sig${n}` }] : []),
      ...Array.from({ length: calls }, (_, k) => ({
        type: "tool_use", id: `t${n}c${k}`, name: "mcp__pi__bash", input: { command: `echo ${n}.${k}` },
      })),
    ],
  };
}

/** One turn: its opening, `rounds` tool rounds and the answer; a steer row rides in round `steer`'s results. */
function turn(
  opening: Block,
  rounds: number,
  think: (n: number) => boolean,
  { calls = 1, steer, start = 0 }: { calls?: number; steer?: number; start?: number } = {},
): Message[] {
  const messages: Message[] = [{ role: "user", content: [opening] }];
  for (let n = start; n < start + rounds; n++) {
    messages.push(assistant(n, think(n), calls), {
      role: "user",
      content: [
        ...Array.from({ length: calls }, (_, k) => ({ type: "tool_result", tool_use_id: `t${n}c${k}`, content: `${n}.${k}` })),
        ...(n === steer ? [STEER] : []),
      ],
    });
  }
  const n = start + rounds;
  messages.push({
    role: "assistant",
    content: [
      ...(think(n) ? [{ type: "thinking", thinking: `plan ${n}`, signature: `sig${n}` }] : []),
      { type: "text", text: `done ${n}` },
    ],
  });
  return messages;
}

/**
 * The CLI's request: its environment message after the first turn and a
 * trailing per-request system message carrying the message mark. Not the
 * date line, which the relay would move; that step has its own tests.
 */
function native(messages: Message[], layout: Layout): Body {
  const { tools, system, assistantMark } = LAYOUTS[layout];
  const sent = clone(messages);
  sent.splice(1, 0, { role: "system", content: "Primary working directory: /tmp/child" });
  if (assistantMark && sent.length > 3) {
    const content = sent[sent.length - 2]!.content as Block[];
    content[content.length - 1]!["cache_control"] = MARKER;
  }
  sent.push({ role: "system", content: [{ type: "text", text: "<system-reminder>per request</system-reminder>", cache_control: MARKER }] });
  return { tools: clone(tools) as Block[], system: clone(system) as Block[], messages: sent };
}

function stabilized(raw: Body, queried: Block[]): Body {
  const body = clone(raw);
  stabilizeNativeRequest(body as unknown as Record<string, unknown>, queried as unknown as NativeContentBlock[]);
  return body;
}

const pinned = (messages: Message[], layout: Layout) =>
  stabilized(native(messages, layout), messages[messages.length - 1]!.content as Block[]);

function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "cache_control").map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

function markCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, v) => sum + markCount(v), 0);
  if (value && typeof value === "object") {
    return Object.entries(value).reduce((sum, [k, v]) => sum + (k === "cache_control" ? 1 : markCount(v)), 0);
  }
  return 0;
}

function messageMarks(body: Body): Array<[number, number]> {
  const marks: Array<[number, number]> = [];
  body.messages.forEach((m, i) => {
    if (Array.isArray(m.content)) m.content.forEach((b, j) => { if ("cache_control" in b) marks.push([i, j]); });
  });
  return marks;
}

type Read = [number, number] | "tools" | "system" | null;

/**
 * Anthropic's documented lookup: each breakpoint checks up to 20 positions
 * back, itself included, a run of tool_use or tool_result blocks counting
 * once; entries are written only at breakpoints. A thinking block renders
 * closed once a later user message carries more than tool results.
 */
class Cache {
  private entries = new Set<string>();

  send(body: Body): Read {
    const messages = body.messages;
    const opens = messages.map((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b["type"] !== "tool_result"));
    const flat: Array<[Read, Block]> = [
      ...body.tools.map((t): [Read, Block] => ["tools", t]),
      ...body.system.map((b): [Read, Block] => ["system", b]),
    ];
    messages.forEach((m, i) => {
      const content = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
      content.forEach((b, j) => {
        flat.push([[i, j], b["type"] === "thinking" ? { ...b, closed: opens.slice(i + 1).some(Boolean) } : b]);
      });
    });
    const hash = createHash("sha256");
    const keys = flat.map(([where, b]) => {
      hash.update(JSON.stringify([Array.isArray(where) ? where[0] : where, plain(b)]));
      return hash.copy().digest("hex");
    });
    const marks = flat.flatMap(([, b], k) => ("cache_control" in b ? [k] : []));
    let read = -1;
    for (const mark of marks) {
      let k = mark;
      let seen = 1;
      while (k >= 0 && seen <= 20) {
        if (this.entries.has(keys[k]!)) {
          read = Math.max(read, k);
          break;
        }
        const kind = flat[k]![1]["type"];
        k -= 1;
        if (!((kind === "tool_use" || kind === "tool_result") && k >= 0 && flat[k]![1]["type"] === kind)) seen += 1;
      }
    }
    for (const k of marks) this.entries.add(keys[k]!);
    return read < 0 ? null : flat[read]![0];
  }
}

/** Send every request of the conversation in order; only markers change, never past four or more than one over the CLI's count. */
function replay(messages: Message[], layout: Layout): Array<[Body, Read]> {
  const cache = new Cache();
  const out: Array<[Body, Read]> = [];
  messages.forEach((m, i) => {
    if (m.role !== "user") return;
    const history = messages.slice(0, i + 1);
    const raw = native(history, layout);
    const body = pinned(history, layout);
    assert.deepEqual(plain(body), plain(raw));
    assert.deepEqual(body.tools, raw.tools);
    assert.deepEqual(body.system, raw.system);
    assert.ok(markCount(body) <= Math.min(4, markCount(raw) + 1));
    out.push([body, cache.send(body)]);
  });
  return out;
}

const nativeIndex = (i: number) => (i ? i + 1 : 0); // The CLI's environment message sits at messages[1].
const hasMark = (body: Body, at: [number, number]) => messageMarks(body).some((m) => isDeepStrictEqual(m, at));
const withFollowUp = (messages: Message[]) => [...messages, { role: "user", content: [FOLLOW_UP] }];

for (const layout of Object.keys(LAYOUTS) as Layout[]) {
  for (const first of [0, 6]) {
    test(`${layout}: the next turn after a long loop reads up to the finished turn's first thinking (first thinking in round ${first})`, () => {
      const messages = withFollowUp(turn(OPENING, 14, (n) => [first, 9, 14].includes(n)));
      const sent = replay(messages, layout);
      const anchor: [number, number] = [nativeIndex(2 * first), 0];
      const [body, read] = sent[sent.length - 1]!;
      assert.ok(hasMark(body, anchor));
      assert.deepEqual(read, anchor);
      // Within the loop each request still reads the previous one's recurring breakpoint.
      for (let k = 1; k < sent.length - 1; k++) {
        assert.deepEqual(sent[k]![1], messageMarks(sent[k - 1]![0]).at(-1));
      }
    });
  }

  test(`${layout}: a short loop keeps only the recurring mark`, () => {
    const sent = replay(withFollowUp(turn(OPENING, 4, () => true)), layout);
    for (const [body] of sent) {
      const assistantMark = LAYOUTS[layout].assistantMark && body.messages.length > 4;
      assert.equal(messageMarks(body).length, 1 + Number(assistantMark));
    }
    assert.deepEqual(sent[sent.length - 1]![1], [0, 0]);
  });

  test(`${layout}: a steer row after a long loop reads up to the turn's first thinking`, () => {
    const sent = replay(turn(OPENING, 14, () => true, { steer: 11 }), layout);
    const steer = sent.findIndex(([body]) => isDeepStrictEqual(plain((body.messages.at(-2)!.content as Block[]).at(-1)), STEER));
    const [body, read] = sent[steer]!;
    assert.deepEqual(read, [0, 0]);
    assert.ok(hasMark(body, [0, 0]));
    assert.deepEqual(sent[steer + 1]![1], messageMarks(body).at(-1));
  });

  test(`${layout}: parallel rounds then a new turn read up to the first thinking`, () => {
    const sent = replay(withFollowUp(turn(OPENING, 6, () => true, { calls: 4 })), layout);
    assert.deepEqual(sent[sent.length - 1]![1], [0, 0]);
  });

  test(`${layout}: a nested marker takes a slot, so the request stays at four`, () => {
    const messages = withFollowUp(turn(OPENING, 14, () => true));
    const raw = native(messages, layout);
    delete raw.tools[0]!["cache_control"];
    (raw.messages[5]!.content as Block[])[0]!["content"] = [{ type: "text", text: "1.0", cache_control: MARKER }];
    const body = stabilized(raw, [FOLLOW_UP]);
    assert.equal(markCount(raw), 4);
    assert.equal(markCount(body), 4);
    assert.deepEqual(body.messages[5], raw.messages[5]);
    assert.deepEqual(messageMarks(body), layout === "2.1.285" ? [[31, 0]] : [[0, 0], [31, 0]]);
    assert.deepEqual(plain(body), plain(raw));
  });
}

test("a later turn keeps everything before the finished turn", () => {
  const first = turn(OPENING, 1, () => true);
  const second = turn(FOLLOW_UP, 14, () => true, { start: 1 });
  const messages = [...first, ...second, { role: "user", content: [{ type: "text", text: "And again." }] }];
  const [body, read] = replay(messages, "2.1.285").at(-1)!;
  assert.deepEqual(read, [nativeIndex(first.length), 0]);
  assert.equal(markCount(body), 4);
});

test("a loop without thinking is left to the recurring mark", () => {
  const sent = replay(withFollowUp(turn(OPENING, 14, () => false)), "2.1.285");
  for (const [body] of sent) assert.equal(messageMarks(body).length, 1);
  assert.deepEqual(sent.at(-1)![1], messageMarks(sent.at(-2)![0]).at(-1));
});

test("at the limit a CLI mark moves instead of a fifth", () => {
  const messages = withFollowUp(turn(OPENING, 14, () => true));
  const raw = native(messages, "2.1.287");
  const body = pinned(messages, "2.1.287");
  assert.equal(markCount(raw), 4);
  assert.equal(markCount(body), 4);
  assert.deepEqual(messageMarks(raw), [[30, 1], [32, 0]]);
  assert.deepEqual(messageMarks(body), [[0, 0], [31, 0]]);
});

test("with no spare slot and no CLI mark to move, only the fold applies", () => {
  const messages = withFollowUp(turn(OPENING, 14, () => true));
  const raw = native(messages, "2.1.285");
  raw.tools[0]!["cache_control"] = MARKER;
  raw.cache_control = { type: "ephemeral" };
  const report = stabilizeNativeRequest(raw as unknown as Record<string, unknown>, [FOLLOW_UP] as unknown as NativeContentBlock[]);
  assert.deepEqual(messageMarks(raw), [[31, 0]]);
  assert.ok(!report.applied.includes("turnStartMarked"));
});

test("the turn mark takes the TTL of the mark after it and is reported", () => {
  const messages = withFollowUp(turn(OPENING, 14, () => true));
  const raw = native(messages, "2.1.285");
  (raw.messages.at(-1)!.content as Block[])[0]!["cache_control"] = { type: "ephemeral" };
  const report = stabilizeNativeRequest(raw as unknown as Record<string, unknown>, [FOLLOW_UP] as unknown as NativeContentBlock[]);
  assert.deepEqual((raw.messages[0]!.content as Block[])[0]!["cache_control"], { type: "ephemeral" });
  assert.deepEqual((raw.messages[31]!.content as Block[])[0]!["cache_control"], { type: "ephemeral" });
  assert.deepEqual(report.applied, ["breakpointPinned", "turnStartMarked"]);
});
