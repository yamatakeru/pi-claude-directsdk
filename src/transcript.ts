/**
 * Cache-preserving native representation of mid-conversation tool changes.
 *
 * When the model supports Anthropic's mid-conversation tool changes, the
 * request's tool list is the initial tools plus a deferred placeholder and
 * never changes. Every later system message becomes native content at its
 * assistant boundary: later tools are defined by value in `tool_addition`
 * blocks, which also covers a tool redefined under the same name, and
 * withdrawn by `tool_removal`. Unsupported models keep the collapsed request
 * shape.
 */

import {
  getInitialSystemMessage,
  renderSystemMessageUpdate,
} from "@earendil-works/pi-ai/compat";
import type { Message, SystemMessage } from "@earendil-works/pi-ai/compat";
import { prepareTools, toolPrefixedName } from "./request.js";
import { replayAssistantCount } from "./replay.js";

export const NATIVE_TOOL_CHANGES_BETA = "inline-tools-2026-09-15";

/** Keeps the deferred-tool prompt scaffolding stable from the first request. */
const DEFERRED_TOOL_PLACEHOLDER = {
  name: "__pi_deferred_placeholder__",
  description: "Reserved placeholder. Never available. Never call this.",
  input_schema: { type: "object", properties: {}, required: [] },
  defer_loading: true,
};

export interface NativeSystemInjection {
  /** Insert immediately before this zero-based assistant frame, or at the request tail. */
  beforeAssistant: number | null;
  content: Array<Record<string, unknown>>;
}

export interface NativeTranscriptPlan {
  requestTools: Array<Record<string, unknown>>;
  systemInjections: NativeSystemInjection[];
  /** Assistant frames the CLI is expected to send; injections index into them. */
  assistantFrames: number;
}

function nativeSystemBlocks(message: SystemMessage): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const text = renderSystemMessageUpdate(message);
  if (text) {
    blocks.push({ type: "text", text });
  }
  const added = message.toolsAdded ?? [];
  const redefined = new Set(added.map((tool) => tool.name));
  for (const tool of message.toolsRemoved ?? []) {
    // A definition under the same name replaces the old one.
    if (redefined.has(tool.name)) continue;
    blocks.push({
      type: "tool_removal",
      tool: { type: "tool_reference", name: toolPrefixedName(tool.name) },
    });
  }
  for (const definition of prepareTools(added).nativeTools) {
    blocks.push({ type: "tool_addition", tool: { type: "tool_definition", definition } });
  }
  return blocks;
}

/**
 * Build the native tool declarations and system injections for a transcript.
 * Returns undefined when the model is unsupported or the leading system
 * message declares no tools: Anthropic rejects a tool list where every tool is
 * deferred.
 */
export function prepareNativeTranscript(
  messages: Message[],
  supported: boolean,
): NativeTranscriptPlan | undefined {
  const initial = getInitialSystemMessage(messages);
  const initialTools = initial?.toolsAdded ?? [];
  if (!supported || initialTools.length === 0) {
    return undefined;
  }

  const systemInjections: NativeSystemInjection[] = [];
  let pending: Array<Array<Record<string, unknown>>> = [];
  let assistantOrdinal = 0;
  const flush = (beforeAssistant: number | null): void => {
    for (const content of pending) {
      systemInjections.push({ beforeAssistant, content });
    }
    pending = [];
  };

  for (let index = 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "system") {
      const blocks = nativeSystemBlocks(message);
      if (blocks.length > 0) {
        pending.push(blocks);
      }
    } else if (message.role === "assistant") {
      const count = replayAssistantCount(message);
      if (count > 0) {
        flush(assistantOrdinal);
        assistantOrdinal += count;
      }
    }
  }
  flush(null);

  return {
    // No tool-level cache_control: Claude Code already sends two system
    // breakpoints and a tail breakpoint, and replay adds a history anchor.
    // Anthropic accepts at most four, so a tool breakpoint would reject every
    // turn that has replayed history.
    requestTools: [...prepareTools(initialTools).nativeTools, structuredClone(DEFERRED_TOOL_PLACEHOLDER)],
    systemInjections,
    assistantFrames: assistantOrdinal,
  };
}

interface NativeRequestMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

/**
 * Insert native system messages before their assistant boundaries. With
 * `assistantFrames`, a request whose assistant count differs throws instead
 * of inserting at a shifted boundary.
 */
export function injectNativeSystemMessages(
  messages: NativeRequestMessage[],
  injections: NativeSystemInjection[],
  assistantFrames?: number,
): NativeRequestMessage[] {
  if (injections.length === 0) {
    return messages;
  }
  if (assistantFrames !== undefined) {
    const sent = messages.filter((message) => message.role === "assistant").length;
    if (sent !== assistantFrames) {
      throw new Error("Native request assistant messages do not match the replay");
    }
  }
  const byAssistant = new Map<number, NativeRequestMessage[]>();
  const trailing: NativeRequestMessage[] = [];
  for (const injection of injections) {
    const message: NativeRequestMessage = {
      role: "system",
      content: structuredClone(injection.content),
    };
    if (injection.beforeAssistant === null) {
      trailing.push(message);
    } else {
      const pending = byAssistant.get(injection.beforeAssistant) ?? [];
      pending.push(message);
      byAssistant.set(injection.beforeAssistant, pending);
    }
  }

  const output: NativeRequestMessage[] = [];
  let assistantOrdinal = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      output.push(...(byAssistant.get(assistantOrdinal) ?? []));
      byAssistant.delete(assistantOrdinal);
      assistantOrdinal += 1;
    }
    output.push(message);
  }
  if (byAssistant.size > 0) {
    throw new Error("Native request lost an assistant boundary needed by system history");
  }
  output.push(...trailing);
  return output;
}

/** Apply system injections to a native Messages request body. */
export function rewriteNativeSystemMessages(
  body: Buffer,
  injections: NativeSystemInjection[],
): Buffer {
  const payload = JSON.parse(body.toString("utf8")) as { messages?: unknown };
  if (!Array.isArray(payload.messages)) {
    throw new Error("Native request is missing its messages array");
  }
  payload.messages = injectNativeSystemMessages(
    payload.messages as NativeRequestMessage[],
    injections,
  );
  return Buffer.from(JSON.stringify(payload));
}
