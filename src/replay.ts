/**
 * Pi transcript to native `stream-json` history replay.
 *
 * Pi owns the transcript. Each model call replays prior assistant, user, and
 * tool-result frames in native form through a fresh request-scoped child.
 * Historical user frames use `shouldQuery: false` with zero-turn
 * acknowledgments; only the final frame may generate.
 *
 * Replay follows the input contract in docs/adr/0001-replay-input-contract.md:
 * every history pi-ai's Anthropic provider can send is accepted. Parts the
 * native form cannot represent are adjusted without losing content, and each
 * adjustment is returned for the request's diagnostics. Signed native
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

/** A change replay made to the history under the input contract. */
export type ReplayAdjustment =
  | { kind: "turnOmitted" }
  | { kind: "toolCallAsText"; tool: string }
  | { kind: "toolResultAdded"; tool: string }
  | { kind: "toolResultAsText"; tool: string }
  | { kind: "errorImagesMoved"; tool: string }
  | { kind: "imageOmitted" };

export interface ReplayOutput {
  /** Frames in order; the last one is a nonempty user frame. */
  frames: NativeFrame[];
  /** Adjustments in history order. */
  replayAdjustments: ReplayAdjustment[];
}

/** Result text pi-ai uses for a tool call left without a result. */
const MISSING_RESULT_TEXT = "No result provided";
/** Placeholder pi-ai leaves in an error result whose images move after the results. */
const MOVED_IMAGE_TEXT = "(image attached after the tool results)";
const OMITTED_IMAGE_TEXT = "[Image omitted: no data]";

/** Whether text is worth sending: the API rejects whitespace-only text blocks. */
function hasText(text: string): boolean {
  return text.trim() !== "";
}

/**
 * Whether a block of an assistant message without a matching carrier is
 * sent. Replay and the native assistant count must agree on this.
 */
function sendsBlock(block: AssistantMessage["content"][number]): boolean {
  return block.type === "toolCall" ||
    (block.type === "text" && hasText(block.text)) ||
    (block.type === "thinking" && hasText(block.thinking));
}

/**
 * A tool result replayed as user text: the heading, then the result with each
 * run of text joined into the block before it. Empty text is dropped, since
 * the API rejects an empty top-level text block.
 */
function asTextResult(heading: string, blocks: NativeContentBlock[]): NativeContentBlock[] {
  const result: NativeContentBlock[] = [{ type: "text", text: heading }];
  for (const block of blocks) {
    if (block.type === "text" && !hasText(block.text)) continue;
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

/** The message's carrier, when its visible projection still matches. */
function matchingCarrier(message: AssistantMessage): ReturnType<typeof readCarrier> {
  const carrier = readCarrier(message);
  return carrier && projectionsEqual(carrier.projection, messageProjection(message))
    ? carrier
    : null;
}

/**
 * Number of native assistant frames this Pi message replays as. Carrier
 * messages can contain more than one native assistant message. The CLI drops
 * an assistant frame that holds only empty text, so such frames do not count.
 */
export function replayAssistantCount(message: AssistantMessage): number {
  const carrier = matchingCarrier(message);
  if (carrier) {
    return carrier.messages.filter((native) =>
      native.content.some((block) => block.type !== "text" || block.text !== ""),
    ).length;
  }
  return message.content.some(sendsBlock) ? 1 : 0;
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
 *   calls unchecked. Fresh calls are validated separately against the active
 *   tools.
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
  const replayAdjustments: ReplayAdjustment[] = [];
  const image = (data: string, mimeType: string): NativeContentBlock => {
    if (data && mimeType) return toNativeImage(data, mimeType);
    replayAdjustments.push({ kind: "imageOmitted" });
    return { type: "text", text: OMITTED_IMAGE_TEXT };
  };
  // The user frame after an assistant turn: native tool results must lead it,
  // so they wait in `toolResults` while everything else waits in `rest`.
  let toolResults: NativeContentBlock[] = [];
  let rest: NativeContentBlock[] = [];
  // Calls of the latest assistant turn still waiting for a result, by Pi ID.
  const openCalls = new Map<string, { name: string; asText: boolean }>();
  const closeCalls = (): void => {
    for (const [id, { name, asText }] of openCalls) {
      if (asText) {
        rest.push({ type: "text", text: `[Tool error: ${name}, id ${id}]\n${MISSING_RESULT_TEXT}` });
      } else {
        toolResults.push({
          type: "tool_result",
          tool_use_id: nativeToolId(id),
          content: MISSING_RESULT_TEXT,
          is_error: true,
        });
      }
      replayAdjustments.push({ kind: "toolResultAdded", tool: name });
    }
    openCalls.clear();
  };
  const flushUser = (): void => {
    closeCalls();
    pushUserBlocks([...toolResults, ...rest]);
    toolResults = [];
    rest = [];
  };
  // Calls of the latest assistant turn replayed as text, Pi ID to tool name.
  const textToolNames = new Map<string, string>();

  for (const message of messages) {
    switch (message.role) {
      case "system":
        // Callers remove system messages first; this guards the invariant.
        throw replayError("System messages must precede conversation history");
      case "user": {
        closeCalls();
        if (typeof message.content === "string") {
          if (hasText(message.content)) {
            rest.push({ type: "text", text: message.content });
          }
        } else {
          for (const block of message.content) {
            if (block.type === "text") {
              if (hasText(block.text)) {
                rest.push({ type: "text", text: block.text });
              }
            } else if (block.type === "image") {
              rest.push(image(block.data, block.mimeType));
            } else {
              throw replayError(
                `Unsupported user content block: ${(block as { type: string }).type}`,
              );
            }
          }
        }
        break;
      }
      case "assistant": {
        flushUser();
        // Results answer the calls of the turn just before them, so a reused
        // ID in a later turn never inherits an earlier text replay.
        textToolNames.clear();
        const carrier = matchingCarrier(message);
        if (carrier) {
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
          for (const block of message.content) {
            if (block.type === "toolCall") openCalls.set(block.id, { name: block.name, asText: false });
          }
          break;
        }
        // Without a matching carrier, preserve thinking as ordinary text.
        // Foreign or stale signatures must never become native thinking.
        const blocks: NativeContentBlock[] = [];
        for (const block of message.content) {
          if (block.type !== "text" && block.type !== "thinking" && block.type !== "toolCall") {
            throw replayError(
              `Unsupported assistant content block: ${(block as { type: string }).type}`,
            );
          }
          if (!sendsBlock(block)) continue;
          if (block.type === "text") {
            blocks.push({ type: "text", text: block.text });
          } else if (block.type === "thinking") {
            blocks.push({ type: "text", text: block.thinking });
          } else if (allowedToolNames && !allowedToolNames.has(block.name)) {
            textToolNames.set(block.id, block.name);
            openCalls.set(block.id, { name: block.name, asText: true });
            replayAdjustments.push({ kind: "toolCallAsText", tool: block.name });
            blocks.push({
              type: "text",
              text: `[Tool call: ${block.name}, id ${block.id}] ${JSON.stringify(block.arguments ?? {})}`,
            });
          } else {
            blocks.push({
              type: "tool_use",
              id: nativeToolId(block.id),
              name: toolPrefixedName(block.name),
              input: deepClone(block.arguments),
            });
            openCalls.set(block.id, { name: block.name, asText: false });
          }
        }
        if (blocks.length === 0) {
          // Failed and aborted responses leave empty placeholders, and edits
          // can leave a turn with nothing visible, such as empty thinking.
          replayAdjustments.push({ kind: "turnOmitted" });
          break;
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
            blocks.push(image(block.data, block.mimeType));
          } else {
            throw replayError(
              `Unsupported tool-result content block: ${(block as { type: string }).type}`,
            );
          }
        }
        const label = message.isError ? "Tool error" : "Tool result";
        const open = openCalls.get(message.toolCallId);
        openCalls.delete(message.toolCallId);
        if (!open || open.asText) {
          // A call replayed as text gets its result as text. So does a result
          // without an open call: closed by a user message, edited away, or
          // already answered.
          const textToolName = textToolNames.get(message.toolCallId);
          rest.push(...asTextResult(
            `[${label}: ${textToolName ?? message.toolName}, id ${message.toolCallId}]`,
            blocks,
          ));
          if (textToolName === undefined) {
            replayAdjustments.push({ kind: "toolResultAsText", tool: message.toolName });
          }
          break;
        }
        let content = blocks;
        if (message.isError && blocks.some((block) => block.type === "image")) {
          // The API rejects an error result with anything but text.
          // Adjacent images share one placeholder, as in pi-ai.
          content = [];
          let moved = false;
          for (const block of blocks) {
            if (block.type === "image") {
              if (!moved) content.push({ type: "text", text: MOVED_IMAGE_TEXT });
              moved = true;
            } else {
              content.push(block);
              moved = false;
            }
          }
          rest.push(
            { type: "text", text: `Images from the error result of tool call ${message.toolCallId} (${message.toolName}):` },
            ...blocks.filter((block) => block.type === "image"),
          );
          replayAdjustments.push({ kind: "errorImagesMoved", tool: message.toolName });
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: nativeToolId(message.toolCallId),
          content:
            content.length === 1 && content[0]?.type === "text"
              ? (content[0] as { text: string }).text
              : content,
          ...(message.isError ? { is_error: true } : {}),
        });
        break;
      }
      default:
        throw replayError(
          `Unsupported message role: ${(message as { role: string }).role}`,
        );
    }
  }
  flushUser();

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
        if (!block || (block.type === "text" && !hasText(block.text))) continue;
        frame.message.content[j] = { ...block, cache_control: { ...cacheControl } };
        break anchor;
      }
    }
  }
  return { frames, replayAdjustments };
}
