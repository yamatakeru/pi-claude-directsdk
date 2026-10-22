/**
 * Replay-stable native request context. The CLI adds per-request context
 * (its session reminder, the split-out date line) and puts its message
 * breakpoint on it; none of it recurs in the next request. This restores the
 * invariant that request N's prefix through its message breakpoint starts
 * request N+1. Exact matches only; otherwise the body forwards as built.
 * Ported from the Hermes reference relay; see docs/architecture.md.
 */

import { isDeepStrictEqual as deepEqual } from "node:util";
import type { NativeContentBlock } from "./types.js";
import { deepClone, isRecord } from "./types.js";

type Block = Record<string, unknown>;
type Message = Record<string, unknown> & { role?: unknown; content?: unknown };

export type NativeContextStep =
  | "toolResultRestored"
  | "dateLineRestored"
  | "reminderDropped"
  | "openingReordered"
  | "breakpointPinned";

export type NativeContextSkip =
  | "body is not a Messages request"
  | "queried frame is empty"
  | "queried tool results not uniquely matched"
  | "rewrite failed";

/** Meta diagnostic outcome; never carries content. */
export interface NativeContextReport {
  applied: NativeContextStep[];
  skipped: NativeContextSkip[];
}

const UNCACHEABLE = new Set(["thinking", "redacted_thinking"]);
// The only CLI text matched by wording; anything looser could move varying text.
const DATE_LINE = /^Today's date is \d{4}-\d{2}-\d{2}\.$/;

function plain(block: unknown): unknown {
  if (!isRecord(block)) return block;
  const { cache_control: _ignored, ...rest } = block;
  return rest;
}

function plainEqual(a: unknown, b: unknown): boolean {
  return deepEqual(plain(a), plain(b));
}

function blockType(block: unknown): unknown {
  return isRecord(block) ? block["type"] : undefined;
}

function isBareText(block: unknown): block is { type: "text"; text: string } {
  return (
    isRecord(block) &&
    Object.keys(block).length === 2 &&
    block["type"] === "text" &&
    typeof block["text"] === "string"
  );
}

function lastAssistant(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return i;
  }
  return -1;
}

function frameStarts(blocks: unknown[], frame: Block[]): number[] {
  const starts: number[] = [];
  for (let k = 0; k + frame.length <= blocks.length; k++) {
    if (frame.every((block, i) => plainEqual(blocks[k + i], block))) starts.push(k);
  }
  return starts;
}

function wellFormed(messages: unknown): messages is Message[] {
  return (
    Array.isArray(messages) &&
    messages.every(
      (message) =>
        isRecord(message) &&
        ["system", "user", "assistant"].includes(message["role"] as string) &&
        (typeof message["content"] === "string" ||
          (Array.isArray(message["content"]) &&
            message["content"].every(
              (block) =>
                isRecord(block) &&
                typeof block["type"] === "string" &&
                (block["type"] !== "text" || typeof block["text"] === "string"),
            ))),
    )
  );
}

/** Result of a restoration step that did not match exactly. */
const MISMATCH = Symbol("mismatch");
type Restored<T> = T | typeof MISMATCH;

function bareTexts(blocks: unknown[]): string {
  return (blocks as Array<{ text: string }>).map((block) => block.text).join("");
}

function joinedText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every(isBareText)) return bareTexts(value);
  return null;
}

// The CLI trims the newest tool result before appending its reminder.
function sentStartsWith(sent: string, host: string, trimmed: boolean): boolean {
  const core = host.trim();
  return sent.startsWith(host) || (trimmed && core !== "" && sent.startsWith(core));
}

/**
 * Match the blocks the CLI sent against the blocks Pi queried and return Pi's
 * blocks with the CLI's markers. Runs of bare text are compared as one string;
 * the final run may carry appended CLI text, and trailing bare text is dropped.
 * `trimmed` allows the final run to match Pi's text without its surrounding
 * whitespace; `newest` is the queried tool result whose content allows it.
 */
function restoreSequence(
  sent: unknown[],
  host: unknown[],
  newest: Block | undefined,
  trimmed = false,
): Restored<unknown[]> {
  const restored: unknown[] = [];
  let i = 0;
  let j = 0;
  while (i < host.length) {
    if (j >= sent.length) return MISMATCH;
    if (isBareText(host[i]) && isBareText(sent[j])) {
      let hostEnd = i + 1;
      let sentEnd = j + 1;
      while (hostEnd < host.length && isBareText(host[hostEnd])) hostEnd++;
      while (sentEnd < sent.length && isBareText(sent[sentEnd])) sentEnd++;
      const original = bareTexts(host.slice(i, hostEnd));
      const actual = bareTexts(sent.slice(j, sentEnd));
      const final = hostEnd === host.length;
      if (!(final ? sentStartsWith(actual, original, trimmed) : actual === original)) return MISMATCH;
      restored.push(...deepClone(host.slice(i, hostEnd)));
      i = hostEnd;
      j = sentEnd;
    } else {
      const block = restoreBlock(sent[j], host[i], newest);
      if (block === MISMATCH) return MISMATCH;
      restored.push(block);
      i++;
      j++;
    }
  }
  if (sent.slice(j).some((block) => !isBareText(block))) return MISMATCH;
  return restored;
}

const TOOL_RESULT_COMPARED_SEPARATELY = new Set(["content", "is_error", "cache_control"]);

/** One non-text block: Pi's block, with the CLI's marker if it placed one. */
function restoreBlock(sent: unknown, host: unknown, newest: Block | undefined): Restored<Block> {
  if (!isRecord(sent) || !isRecord(host)) return MISMATCH;
  const restored = deepClone(host);
  if (host["type"] === "tool_result") {
    const sentError = sent["is_error"] ?? false;
    const hostError = host["is_error"] ?? false;
    if (typeof sentError !== "boolean" || typeof hostError !== "boolean" || sentError !== hostError) {
      return MISMATCH;
    }
    const rest = (block: Block): Block =>
      Object.fromEntries(
        Object.entries(block).filter(([key]) => !TOOL_RESULT_COMPARED_SEPARATELY.has(key)),
      );
    if (!deepEqual(rest(sent), rest(host))) return MISMATCH;
    if (("content" in sent) !== ("content" in host)) return MISMATCH;
    if ("content" in host) {
      const content = restoreContent(sent["content"], host["content"], newest, host === newest);
      if (content === MISMATCH) return MISMATCH;
      restored["content"] = content;
    }
  } else if (!plainEqual(sent, host)) {
    return MISMATCH;
  }
  if ("cache_control" in sent) {
    if ("cache_control" in host && !deepEqual(sent["cache_control"], host["cache_control"])) {
      return MISMATCH;
    }
    restored["cache_control"] = deepClone(sent["cache_control"]);
  }
  return restored;
}

/** Tool-result content, which the CLI may send as a string or as blocks. */
function restoreContent(
  sent: unknown,
  host: unknown,
  newest: Block | undefined,
  trimmed: boolean,
): Restored<unknown> {
  if (typeof host === "string" || typeof sent === "string") {
    const left = joinedText(sent);
    const right = joinedText(host);
    if (left === null || right === null || !sentStartsWith(left, right, trimmed)) return MISMATCH;
    return deepClone(host);
  }
  if (Array.isArray(sent) && Array.isArray(host)) return restoreSequence(sent, host, newest, trimmed);
  return deepEqual(sent, host) ? deepClone(host) : MISMATCH;
}

/**
 * Strip CLI text appended to the queried tool results. Applies only when the
 * ordered tool-use IDs anchor the whole frame.
 */
function restoreQueriedTurn(
  messages: Message[],
  queried: Block[],
): "restored" | "unchanged" | "unmatched" {
  const results = queried.filter((block) => block["type"] === "tool_result");
  if (results.length === 0) return "unchanged";
  const newest = messages[lastAssistant(messages) + 1];
  const native = newest?.role === "user" ? newest.content : undefined;
  if (!Array.isArray(native)) return "unmatched";
  const hostIds = results.map((block) => block["tool_use_id"]);
  if (hostIds.some((id) => typeof id !== "string" || !id) || new Set(hostIds).size !== hostIds.length) {
    return "unmatched";
  }
  const nativeIds = native
    .filter((block) => blockType(block) === "tool_result")
    .map((block) => (block as Block)["tool_use_id"]);
  if (!deepEqual(hostIds, nativeIds)) return "unmatched";
  const restored = restoreSequence(native, queried, results[results.length - 1]);
  if (restored === MISMATCH) return "unmatched";
  if (deepEqual(native, restored)) return "unchanged";
  newest!.content = restored;
  return "restored";
}

function restoreDateLine(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  const env = messages.slice(0, -1).find((message) => message.role === "system");
  if (!last || last.role !== "system" || !env) return false;
  const content = last.content;
  const tail: unknown =
    typeof content === "string"
      ? { type: "text", text: content }
      : Array.isArray(content) && content.length === 1
        ? content[0]
        : undefined;
  if (!isRecord(tail) || tail["type"] !== "text" || !DATE_LINE.test(tail["text"] as string)) {
    return false;
  }
  const line = tail["text"] as string;
  const original = env.content;
  const target: unknown =
    typeof original === "string"
      ? { type: "text", text: original }
      : Array.isArray(original)
        ? original[original.length - 1]
        : undefined;
  if (!isRecord(target) || target["type"] !== "text" || (target["text"] as string).endsWith(line)) {
    return false;
  }
  if (typeof original === "string") {
    env.content = `${original}\n\n${line}`;
  } else {
    target["text"] = `${target["text"] as string}\n\n${line}`;
  }
  const mark = tail["cache_control"] ?? last["cache_control"];
  messages.pop();
  const previous = messages[messages.length - 1]?.content;
  if (mark !== undefined && Array.isArray(previous) && previous.length > 0) {
    const block = previous[previous.length - 1] as Block;
    if (!("cache_control" in block)) block["cache_control"] = mark;
  }
  return true;
}

/** A continuous native session carries this context once; replay would repeat it. */
function dropReminder(messages: Message[], queried: Block[]): boolean {
  if (!queried.some((block) => block["type"] !== "tool_result")) return false;
  if (lastAssistant(messages) < 0) return false;
  const newest = [...messages].reverse().find((message) => message.role === "user");
  const blocks = newest?.content;
  if (!Array.isArray(blocks)) return false;
  const starts = frameStarts(blocks, queried);
  const k = starts.length === 1 ? starts[0]! : 0;
  if (k === 0) return false;
  const prefix = blocks.slice(0, k) as Block[];
  if (!prefix.every((b) => b["type"] === "text" && Object.keys(b).every((key) => ["type", "text", "cache_control"].includes(key)))) {
    return false;
  }
  const mark = prefix.find((b) => "cache_control" in b)?.["cache_control"];
  blocks.splice(0, k);
  const first = blocks[0] as Block;
  if (mark !== undefined && !("cache_control" in first)) first["cache_control"] = mark;
  return true;
}

/** Opening request: move the prepended CLI text behind the queried frame. */
function frameFirst(messages: Message[], queried: Block[]): boolean {
  if (lastAssistant(messages) >= 0) return false;
  const first = messages.find((message) => message.role === "user");
  const content = first?.content;
  if (!Array.isArray(content) || content.length <= queried.length) return false;
  const starts = frameStarts(content, queried);
  if (starts.length !== 1 || starts[0] === 0) return false;
  const k = starts[0]!;
  if (!content.slice(0, k).every((b) => blockType(b) === "text")) return false;
  first!.content = [
    ...content.slice(k, k + queried.length),
    ...content.slice(0, k),
    ...content.slice(k + queried.length),
  ];
  return true;
}

/**
 * Fold later message markers onto the last block that the next request
 * replays. Before a changed tool result the span ends at the assistant
 * message: Hermes measured no hit on the unchanged results before it.
 */
function pinBreakpoint(messages: Message[], queried: Block[]): boolean {
  const positions: Array<{ i: number; j: number; block: Block }> = [];
  messages.forEach((message, i) => {
    if (Array.isArray(message.content)) {
      message.content.forEach((block, j) => positions.push({ i, j, block: block as Block }));
    }
  });
  const marked = positions.filter((p) => "cache_control" in p.block);
  if (marked.length === 0) return false;
  const last = lastAssistant(messages);
  const stable = positions.filter((p) => p.i <= last);
  const newest = messages[last + 1];
  if (newest?.role === "user" && Array.isArray(newest.content)) {
    const prefix: typeof positions = [];
    for (let j = 0; j < Math.min(newest.content.length, queried.length); j++) {
      if (!plainEqual(newest.content[j], queried[j])) break;
      prefix.push({ i: last + 1, j, block: newest.content[j] as Block });
    }
    const rest = newest.content[prefix.length];
    if (blockType(rest) !== "tool_result") stable.push(...prefix);
  }
  const target = [...stable].reverse().find((p) => !UNCACHEABLE.has(p.block["type"] as string));
  if (!target) return false;
  const after = marked.filter((p) => p.i > target.i || (p.i === target.i && p.j > target.j));
  if (after.length === 0) return false;
  const moved = after.map((p) => {
    const mark = p.block["cache_control"];
    delete p.block["cache_control"];
    return mark;
  })[0];
  if (!("cache_control" in target.block)) target.block["cache_control"] = moved;
  return true;
}

/**
 * Stabilize a parsed Messages request in place. Steps that do not match
 * exactly leave the body as the CLI built it; the report lists what applied.
 */
export function stabilizeNativeRequest(
  body: Record<string, unknown>,
  queried: readonly NativeContentBlock[],
): NativeContextReport {
  const report: NativeContextReport = { applied: [], skipped: [] };
  const messages = body["messages"];
  const frame = queried.filter(isRecord) as Block[];
  if (!wellFormed(messages)) {
    report.skipped.push("body is not a Messages request");
    return report;
  }
  if (frame.length === 0 || frame.length !== queried.length) {
    report.skipped.push("queried frame is empty");
    return report;
  }
  const toolResults = restoreQueriedTurn(messages, frame);
  if (toolResults === "restored") report.applied.push("toolResultRestored");
  if (toolResults === "unmatched") report.skipped.push("queried tool results not uniquely matched");
  if (restoreDateLine(messages)) report.applied.push("dateLineRestored");
  if (dropReminder(messages, frame)) report.applied.push("reminderDropped");
  const hasMarks = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => isRecord(b) && "cache_control" in b),
  );
  if (hasMarks && frameFirst(messages, frame)) report.applied.push("openingReordered");
  if (pinBreakpoint(messages, frame)) report.applied.push("breakpointPinned");
  return report;
}
