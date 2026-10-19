/**
 * Replay-stable native request context.
 *
 * Every Pi model call replays history through a fresh native child, and the
 * CLI adds per-request context to each request: its session-context reminder
 * on the final user/tool-result frame, and today's date split out of its
 * environment message into a trailing system message. Its message cache
 * breakpoint then lands on that context. None of it recurs in the next request,
 * so the prefix cached at that breakpoint is never read again.
 *
 * The invariant restored here: everything in request N up to its message
 * breakpoint appears unchanged at the start of request N+1. Pi-owned content is
 * identified structurally, as the final frame Pi queried (`prepareHistory`),
 * never by the CLI's wording. The date line is the one exception, and only an
 * exact match moves.
 *
 * Every step acts only on an exact, unique match and otherwise leaves the
 * request untouched, so the worst case is the native request as built. Pi
 * content is never edited. Message cache markers only move earlier and are
 * never added. System, tools, and assistant blocks are never touched.
 *
 * Ported from the Hermes reference relay (`admission.py`:
 * `restore_queried_turn`, `stable_request_context`, `pin_message_breakpoint`,
 * `_frame_first`), see docs/transport-measurements.md.
 */

import type { NativeContentBlock } from "./types.js";
import { deepClone, isRecord } from "./types.js";

type Block = Record<string, unknown>;
type Message = Record<string, unknown> & { role?: unknown; content?: unknown };

/** Steps that changed the request. */
export type NativeContextStep =
  /** The CLI's text appended to the queried tool results was removed. */
  | "toolResultRestored"
  /** The trailing date message was returned to the environment message. */
  | "dateLineRestored"
  /** CLI text placed before the queried frame on a later user turn was removed. */
  | "reminderDropped"
  /** Opening request: CLI text placed before the queried frame was moved after it. */
  | "openingReordered"
  /** Message breakpoints after the replay-stable span were folded onto its last block. */
  | "breakpointPinned";

/** Why the request, or part of it, was forwarded as the CLI built it. */
export type NativeContextSkip =
  | "body is not a Messages request"
  | "queried tool results not uniquely matched";

/** Per-request outcome for the meta diagnostic. It never carries content. */
export interface NativeContextReport {
  applied: NativeContextStep[];
  skipped: NativeContextSkip[];
}

const UNCACHEABLE = new Set(["thinking", "redacted_thinking"]);
// The only trailing system text that moves: the CLI's date line, exactly as its
// opening request ends the environment message.
const DATE_LINE = /^Today's date is \d{4}-\d{2}-\d{2}\.$/;

class QueriedTurnMismatch extends Error {}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, i) => deepEqual(value, b[i]))
    );
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
  );
}

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

/** Start indices where `frame` occurs in `blocks`, ignoring cache markers. */
function frameStarts(blocks: unknown[], frame: Block[]): number[] {
  const starts: number[] = [];
  for (let k = 0; k + frame.length <= blocks.length; k++) {
    if (frame.every((block, i) => plainEqual(blocks[k + i], block))) starts.push(k);
  }
  return starts;
}

/** Shape check; anything unexpected forwards unchanged. */
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

/**
 * Restore the queried tool-result frame: the CLI appends its reminder to the
 * newest tool result (or as trailing text after it). Only trailing bare text is
 * removable, and only when the ordered tool-use IDs anchor the whole frame.
 * Restoration is hygiene, not a gate: a mismatch throws and the caller
 * forwards this part unchanged.
 */
function restoreQueriedTurn(messages: Message[], queried: Block[]): boolean {
  if (!queried.some((block) => block["type"] === "tool_result")) return false;
  const unmatched = (): never => {
    throw new QueriedTurnMismatch();
  };
  const joinedText = (value: unknown): string | null => {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every(isBareText)) {
      return value.map((block) => block.text).join("");
    }
    return null;
  };
  const restoreContent = (sent: unknown, host: unknown): unknown => {
    // Scalar/list equivalence is allowed only for text with no metadata or markers.
    if (typeof host === "string" || typeof sent === "string") {
      const left = joinedText(sent);
      const right = joinedText(host);
      if (left === null || right === null || !left.startsWith(right)) return unmatched();
      return deepClone(host);
    }
    if (Array.isArray(sent) && Array.isArray(host)) return restoreSequence(sent, host);
    return deepEqual(sent, host) ? deepClone(host) : unmatched();
  };
  const restoreBlock = (sent: unknown, host: unknown): Block => {
    if (!isRecord(sent) || !isRecord(host)) return unmatched();
    const restored = deepClone(host);
    if (host["type"] === "tool_result") {
      const sentError = sent["is_error"] ?? false;
      const hostError = host["is_error"] ?? false;
      if (typeof sentError !== "boolean" || typeof hostError !== "boolean" || sentError !== hostError) {
        return unmatched();
      }
      const ignored = new Set(["content", "is_error", "cache_control"]);
      const rest = (block: Block): Block =>
        Object.fromEntries(Object.entries(block).filter(([key]) => !ignored.has(key)));
      if (!deepEqual(rest(sent), rest(host))) return unmatched();
      if (("content" in sent) !== ("content" in host)) return unmatched();
      if ("content" in host) restored["content"] = restoreContent(sent["content"], host["content"]);
    } else if (!plainEqual(sent, host)) {
      return unmatched();
    }
    if ("cache_control" in sent) {
      if ("cache_control" in host && !deepEqual(sent["cache_control"], host["cache_control"])) {
        return unmatched();
      }
      restored["cache_control"] = deepClone(sent["cache_control"]);
    }
    return restored;
  };
  const restoreSequence = (sent: unknown[], host: unknown[]): unknown[] => {
    const restored: unknown[] = [];
    let i = 0;
    let j = 0;
    while (i < host.length) {
      if (j >= sent.length) return unmatched();
      if (isBareText(host[i]) && isBareText(sent[j])) {
        let hostEnd = i + 1;
        let sentEnd = j + 1;
        while (hostEnd < host.length && isBareText(host[hostEnd])) hostEnd++;
        while (sentEnd < sent.length && isBareText(sent[sentEnd])) sentEnd++;
        const original = (host.slice(i, hostEnd) as Array<{ text: string }>).map((b) => b.text).join("");
        const actual = (sent.slice(j, sentEnd) as Array<{ text: string }>).map((b) => b.text).join("");
        // Text before a protected host block must match exactly; only the end may grow.
        if (!(hostEnd === host.length ? actual.startsWith(original) : actual === original)) {
          return unmatched();
        }
        restored.push(...deepClone(host.slice(i, hostEnd)));
        i = hostEnd;
        j = sentEnd;
      } else {
        restored.push(restoreBlock(sent[j], host[i]));
        i++;
        j++;
      }
    }
    if (sent.slice(j).some((block) => !isBareText(block))) return unmatched();
    return restored;
  };

  const newest = messages[lastAssistant(messages) + 1];
  const native = newest?.role === "user" ? newest.content : undefined;
  if (!Array.isArray(native)) return unmatched();
  const hostIds = queried.filter((b) => b["type"] === "tool_result").map((b) => b["tool_use_id"]);
  if (
    hostIds.some((id) => typeof id !== "string" || !id) ||
    new Set(hostIds).size !== hostIds.length
  ) {
    return unmatched();
  }
  const nativeIds = native
    .filter((b) => blockType(b) === "tool_result")
    .map((b) => (b as Block)["tool_use_id"]);
  // Unique ordered result IDs anchor the complete frame; no reminder-pattern search.
  if (!deepEqual(hostIds, nativeIds)) return unmatched();
  const restored = restoreSequence(native, queried);
  if (deepEqual(native, restored)) return false;
  newest!.content = restored;
  return true;
}

/** Return the trailing date message to the end of the environment message. */
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

/**
 * On a later user turn, drop plain text the CLI placed before the queried
 * frame. A continuous native session carries this context once; per-call
 * replay would otherwise repeat it on every call and replay it nowhere.
 */
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

/**
 * Opening request: move the CLI text prepended to the first user turn behind
 * the queried frame, the order the CLI already uses on later turns. No block
 * is added, dropped, or edited.
 */
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
 * Fold message breakpoints placed after the replay-stable span onto its last
 * cacheable block. The span is everything through the last assistant message
 * plus the leading blocks of the newest user message that equal the queried
 * frame. When the first changed block is a tool result, the span ends at the
 * assistant message (Hermes measured no hit on the unchanged results before
 * it). Markers never move later and are never added.
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
 * Stabilize one native Messages request body against the frame Pi queried.
 * Pure: no I/O, never throws. Returns the original buffer when nothing changed.
 */
export function stabilizeNativeRequest(
  body: Buffer,
  queried: readonly NativeContentBlock[],
): { body: Buffer; report: NativeContextReport } {
  const report: NativeContextReport = { applied: [], skipped: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    parsed = undefined;
  }
  const messages = isRecord(parsed) ? parsed["messages"] : undefined;
  const frame = queried.filter(isRecord) as Block[];
  if (!wellFormed(messages) || frame.length === 0 || frame.length !== queried.length) {
    report.skipped.push("body is not a Messages request");
    return { body, report };
  }
  try {
    try {
      if (restoreQueriedTurn(messages, frame)) report.applied.push("toolResultRestored");
    } catch (error) {
      if (!(error instanceof QueriedTurnMismatch)) throw error;
      report.skipped.push("queried tool results not uniquely matched");
    }
    if (restoreDateLine(messages)) report.applied.push("dateLineRestored");
    if (dropReminder(messages, frame)) report.applied.push("reminderDropped");
    // Reordering only serves caching; without any marker the request stays as built.
    const hasMarks = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => isRecord(b) && "cache_control" in b),
    );
    if (hasMarks && frameFirst(messages, frame)) report.applied.push("openingReordered");
    if (pinBreakpoint(messages, frame)) report.applied.push("breakpointPinned");
  } catch {
    return { body, report: { applied: [], skipped: ["body is not a Messages request"] } };
  }
  if (report.applied.length === 0) return { body, report };
  return { body: Buffer.from(JSON.stringify(parsed), "utf-8"), report };
}
