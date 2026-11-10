/**
 * Pi transcript to native `stream-json` history replay.
 *
 * Pi owns the transcript. Each model call replays prior assistant, user, and
 * tool-result frames in native form through a fresh request-scoped child.
 * Historical user frames use `shouldQuery: false` with zero-turn
 * acknowledgments; only the final frame may generate.
 *
 * Thinking without a valid carrier is replayed as text, and so is a tool call
 * the request does not declare, with its result. Both come from switching
 * providers or editing history. Other unsupported history is rejected, never
 * flattened into prose. Signed native
 * thinking survives only inside a durable carrier attached to the Pi
 * assistant message, and only while the visible projection is unchanged.
 */

import { createHash } from "node:crypto";
import type {
  AssistantMessage,
  AssistantMessageDiagnostic,
  JsonObject,
  Message,
} from "@earendil-works/pi-ai/compat";
import { replayError } from "./errors.js";
import { toolPrefixedName } from "./request.js";
import { deepClone, isRecord } from "./types.js";
import type {
  NativeAssistantMessage,
  NativeCacheControl,
  NativeContentBlock,
  NativeFrame,
} from "./types.js";

/** Diagnostics type carrying preserved native assistant blocks. */
export const CARRIER_TYPE = "pi-claude-native/native";
const CARRIER_VERSION = 1;

export interface CarrierProjection {
  text: string;
  thinking: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
}

export interface ReplayOutput {
  /** Frames in order; the last one is a nonempty user frame. */
  frames: NativeFrame[];
  /** Tool name of each historical call replayed as text, in order. */
  toolCallsAsText: string[];
}

/**
 * A tool result replayed as user text: the heading, then the result with each
 * run of text joined into the block before it. Empty text is dropped, since
 * the API rejects an empty top-level text block.
 */
function asTextResult(heading: string, blocks: NativeContentBlock[]): NativeContentBlock[] {
  const result: NativeContentBlock[] = [{ type: "text", text: heading }];
  for (const block of blocks) {
    if (block.type === "text" && !block.text) continue;
    const last = result[result.length - 1];
    if (block.type === "text" && last?.type === "text") {
      result[result.length - 1] = { ...last, text: `${last.text}\n${block.text}` };
    } else {
      result.push(block);
    }
  }
  return result;
}

/**
 * Move tool uses to the end of an assistant message, keeping the order within
 * each group, so a call replayed as text never follows a native tool use.
 */
function toolUsesLast(blocks: NativeContentBlock[]): NativeContentBlock[] {
  return [
    ...blocks.filter((block) => block.type !== "tool_use"),
    ...blocks.filter((block) => block.type === "tool_use"),
  ];
}

/**
 * Visible projection of a Pi assistant message. The carrier is restored only
 * when this projection still matches: any edit drops the native blocks so a
 * stale signature is never attached to rewritten content.
 */
export function messageProjection(message: AssistantMessage): CarrierProjection {
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: CarrierProjection["toolCalls"] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      text.push(block.text);
    } else if (block.type === "thinking") {
      thinking.push(block.thinking);
    } else if (block.type === "toolCall") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: deepClone(block.arguments),
      });
    }
  }
  return {
    text: text.join("").trim(),
    thinking: thinking.join(""),
    toolCalls,
  };
}

function projectionsEqual(a: CarrierProjection, b: CarrierProjection): boolean {
  if (a.text !== b.text || a.thinking !== b.thinking) {
    return false;
  }
  if (a.toolCalls.length !== b.toolCalls.length) {
    return false;
  }
  return a.toolCalls.every((call, i) => {
    const other = b.toolCalls[i];
    return (
      other !== undefined &&
      call.id === other.id &&
      call.name === other.name &&
      JSON.stringify(call.input) === JSON.stringify(other.input)
    );
  });
}

function readCarrier(message: AssistantMessage): {
  messages: NativeAssistantMessage[];
  projection: CarrierProjection;
} | null {
  const carriers = (message.diagnostics ?? []).filter(
    (d): d is AssistantMessageDiagnostic =>
      isRecord(d) && d["type"] === CARRIER_TYPE,
  );
  if (carriers.length !== 1) {
    return null;
  }
  const details = carriers[0]?.details as Record<string, unknown> | undefined;
  if (!isRecord(details) || details["version"] !== CARRIER_VERSION) {
    return null;
  }
  if (!Array.isArray(details["messages"]) || !isRecord(details["projection"])) {
    return null;
  }
  return {
    messages: deepClone(details["messages"] as unknown as NativeAssistantMessage[]),
    projection: deepClone(details["projection"] as unknown as CarrierProjection),
  };
}

/**
 * Number of native assistant frames this Pi message replays as. Carrier
 * messages can contain more than one native assistant message. The CLI drops
 * an assistant frame that holds only empty text, so such frames do not count.
 */
export function replayAssistantCount(message: AssistantMessage): number {
  const carrier = readCarrier(message);
  if (carrier && projectionsEqual(carrier.projection, messageProjection(message))) {
    return carrier.messages.filter((native) =>
      native.content.some((block) => block.type !== "text" || block.text !== ""),
    ).length;
  }
  for (const block of message.content) {
    if (
      (block.type === "text" && block.text !== "") ||
      (block.type === "thinking" && block.thinking !== "") ||
      block.type === "toolCall"
    ) {
      return 1;
    }
  }
  return 0;
}

/**
 * Build the durable carrier for a fresh native response. `text` and
 * `toolCalls` describe the visible Pi message; `thinking` covers visible
 * thinking blocks. The carrier restores only while all three still match.
 */
export function encodeCarrier(
  natives: NativeAssistantMessage[],
  projection: CarrierProjection,
): AssistantMessageDiagnostic {
  // A JSON round-trip keeps the diagnostic within pi-ai's JsonValue type.
  const details = JSON.parse(
    JSON.stringify({
      version: CARRIER_VERSION,
      messages: natives,
      projection,
    }),
  ) as JsonObject;
  return { type: CARRIER_TYPE, timestamp: Date.now(), details };
}

function toNativeImage(data: string, mimeType: string): NativeContentBlock {
  if (!data || !mimeType) {
    throw replayError("Image blocks need base64 data and a media type");
  }
  return {
    type: "image",
    source: { type: "base64", media_type: mimeType, data },
  };
}

/**
 * Replay Pi messages (system messages already removed) into native frames.
 *
 * @param allowedToolNames tools the request declares. In a turn without a
 *   matching carrier, a call to any other tool is replayed as text together
 *   with its result instead of as a `tool_use`. A matching carrier replays its
 *   calls unchecked. Fresh calls are validated separately against the current
 *   inventory.
 */
export function prepareHistory(
  messages: Message[],
  allowedToolNames?: Set<string>,
  cacheControl?: NativeCacheControl,
): ReplayOutput {
  const frames: NativeFrame[] = [];
  const nativeIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
  const usedIds = new Set(messages.flatMap(message =>
    message.role === "assistant"
      ? message.content.filter(block => block.type === "toolCall").map(block => block.id)
      : message.role === "toolResult" ? [message.toolCallId] : [],
  ).filter(id => nativeIdPattern.test(id)));
  const remappedIds = new Map<string, string>();
  const nativeToolId = (id: string): string => {
    if (!id) throw replayError("Tool-call IDs must be nonempty");
    if (nativeIdPattern.test(id)) return id;
    const existing = remappedIds.get(id);
    if (existing) return existing;
    const base = `toolu_pi_${createHash("sha256").update(id).digest("hex").slice(0, 48)}`;
    let candidate = base;
    let suffix = 0;
    while (usedIds.has(candidate)) candidate = `${base}_${++suffix}`;
    usedIds.add(candidate);
    remappedIds.set(id, candidate);
    return candidate;
  };
  const pushUserBlocks = (blocks: NativeContentBlock[]): void => {
    if (blocks.length === 0) {
      return;
    }
    const last = frames[frames.length - 1];
    if (last?.type === "user") {
      last.message.content.push(...blocks);
    } else {
      frames.push({ type: "user", message: { role: "user", content: blocks } });
    }
  };
  // Pi tool-call ID to tool name, for calls replayed as text.
  const textToolNames = new Map<string, string>();
  const toolCallsAsText: string[] = [];
  // Results replayed as text wait until the native results of the same turn
  // are in, because native tool results must lead the user message.
  let textResults: NativeContentBlock[] = [];
  const flushTextResults = (): void => {
    pushUserBlocks(textResults);
    textResults = [];
  };

  for (const message of messages) {
    if (message.role !== "toolResult") {
      flushTextResults();
    }
    switch (message.role) {
      case "system":
        throw replayError("System messages must precede conversation history");
      case "user": {
        const blocks: NativeContentBlock[] = [];
        if (typeof message.content === "string") {
          if (message.content) {
            blocks.push({ type: "text", text: message.content });
          }
        } else {
          for (const block of message.content) {
            if (block.type === "text") {
              if (block.text) {
                blocks.push({ type: "text", text: block.text });
              }
            } else if (block.type === "image") {
              blocks.push(toNativeImage(block.data, block.mimeType));
            } else {
              throw replayError(
                `Unsupported user content block: ${(block as { type: string }).type}`,
              );
            }
          }
        }
        pushUserBlocks(blocks);
        break;
      }
      case "assistant": {
        // Results answer the calls of the turn just before them, so a reused
        // ID in a later turn never inherits an earlier text replay.
        textToolNames.clear();
        const carrier = readCarrier(message);
        if (carrier && projectionsEqual(carrier.projection, messageProjection(message))) {
          for (const native of carrier.messages) {
            frames.push({
              type: "assistant",
              message: {
                // The CLI strips thinking from an assistant message without
                // the model that wrote it, as from a different model.
                ...(typeof native.model === "string" ? { model: native.model } : {}),
                role: "assistant",
                content: deepClone(native.content).map(block =>
                  block.type === "tool_use" ? { ...block, id: nativeToolId(block.id) } : block,
                ),
              },
            });
          }
          break;
        }
        // Without a matching carrier, preserve thinking as ordinary text.
        // Foreign or stale signatures must never become native thinking.
        const blocks: NativeContentBlock[] = [];
        for (const block of message.content) {
          if (block.type === "text") {
            if (block.text) {
              blocks.push({ type: "text", text: block.text });
            }
          } else if (block.type === "thinking") {
            if (block.thinking) {
              blocks.push({ type: "text", text: block.thinking });
            }
          } else if (block.type === "toolCall") {
            if (allowedToolNames && !allowedToolNames.has(block.name)) {
              textToolNames.set(block.id, block.name);
              toolCallsAsText.push(block.name);
              blocks.push({
                type: "text",
                text: `[Tool call: ${block.name}, id ${block.id}] ${JSON.stringify(block.arguments ?? {})}`,
              });
              continue;
            }
            blocks.push({
              type: "tool_use",
              id: nativeToolId(block.id),
              name: toolPrefixedName(block.name),
              input: deepClone(block.arguments),
            });
          } else {
            throw replayError(
              `Unsupported assistant content block: ${(block as { type: string }).type}`,
            );
          }
        }
        if (blocks.length === 0) {
          // Interrupted responses can contain empty text or thinking placeholders.
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            break;
          }
          throw replayError("Empty assistant message cannot be replayed");
        }
        frames.push({
          type: "assistant",
          message: {
            role: "assistant",
            content: textToolNames.size > 0 ? toolUsesLast(blocks) : blocks,
          },
        });
        break;
      }
      case "toolResult": {
        const blocks: NativeContentBlock[] = [];
        for (const block of message.content) {
          if (block.type === "text") {
            blocks.push({ type: "text", text: block.text });
          } else if (block.type === "image") {
            blocks.push(toNativeImage(block.data, block.mimeType));
          } else {
            throw replayError(
              `Unsupported tool-result content block: ${(block as { type: string }).type}`,
            );
          }
        }
        const textToolName = textToolNames.get(message.toolCallId);
        if (textToolName !== undefined) {
          const label = message.isError ? "Tool error" : "Tool result";
          textResults.push(...asTextResult(`[${label}: ${textToolName}, id ${message.toolCallId}]`, blocks));
          break;
        }
        pushUserBlocks([
          {
            type: "tool_result",
            tool_use_id: nativeToolId(message.toolCallId),
            content:
              blocks.length === 1 && blocks[0]?.type === "text"
                ? (blocks[0] as { text: string }).text
                : blocks,
            ...(message.isError ? { is_error: true } : {}),
          },
        ]);
        break;
      }
      default:
        throw replayError(
          `Unsupported message role: ${(message as { role: string }).role}`,
        );
    }
  }
  flushTextResults();

  const last = frames[frames.length - 1];
  if (
    !last ||
    last.type !== "user" ||
    last.message.content.length === 0
  ) {
    throw replayError(
      "History must end in a nonempty user/tool-result message; assistant prefill is unsupported",
    );
  }
  // Every historical user frame must not query: only the final frame may
  // generate, and it keeps the native default. Without this flag the child
  // runs a turn per historical frame and replay acknowledgment fails.
  for (let i = 0; i < frames.length - 1; i++) {
    const frame = frames[i];
    if (frame?.type === "user") {
      frame.shouldQuery = false;
    }
  }
  if (cacheControl) {
    // Cache historical Pi content, not the final user frame: the CLI inserts
    // transient reminders inside that final frame. On the next turn this
    // historical user/tool-result content is replayed unchanged, so the
    // API can find this prefix while searching back from the new breakpoint.
    // One extra marker leaves room for the CLI's two system markers and tail
    // marker. Never stamp signed thinking or change the transcript itself.
    anchor: for (let i = frames.length - 2; i >= 0; i--) {
      const frame = frames[i];
      if (frame?.type !== "user") continue;
      for (let j = frame.message.content.length - 1; j >= 0; j--) {
        const block = frame.message.content[j];
        if (!block || (block.type === "text" && block.text.trim() === "")) continue;
        frame.message.content[j] = { ...block, cache_control: { ...cacheControl } };
        break anchor;
      }
    }
  }
  return { frames, toolCallsAsText };
}
