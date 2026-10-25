/**
 * Cache-preserving native representation of mid-conversation tool changes.
 *
 * When the model supports Anthropic's mid-conversation tool-change beta, the
 * leading system message supplies the initial tools, later additions are
 * deferred declarations, and every later system message becomes native
 * `tool_addition`/`tool_removal` content at its assistant boundary. Unsupported
 * models keep the collapsed request shape.
 */

import {
  getDeclaredTools,
  getInitialSystemMessage,
  hasToolRedefinitions,
  renderSystemMessageUpdate,
} from "@earendil-works/pi-ai/compat";
import type { Message, SystemMessage } from "@earendil-works/pi-ai/compat";
import { TOOL_NAME_PREFIX, prepareTools, toolPrefixedName } from "./request.js";
import { replayAssistantCount } from "./replay.js";

export const NATIVE_TOOL_CHANGES_BETA = "mid-conversation-tool-changes-2026-07-01";

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
}

function nativeSystemBlocks(message: SystemMessage): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const text = renderSystemMessageUpdate(message);
  if (text) {
    blocks.push({ type: "text", text });
  }
  for (const tool of message.toolsRemoved ?? []) {
    blocks.push({
      type: "tool_removal",
      tool: { type: "tool_reference", name: toolPrefixedName(tool.name) },
    });
  }
  for (const tool of message.toolsAdded ?? []) {
    blocks.push({
      type: "tool_addition",
      tool: { type: "tool_reference", name: toolPrefixedName(tool.name) },
    });
  }
  return blocks;
}

/**
 * Build the native tool declarations and system injections for a transcript.
 * Returns undefined when the model is unsupported, the leading system message
 * declares no tools, or a tool is redefined with different content.
 */
export function prepareNativeTranscript(
  messages: Message[],
  supported: boolean,
): NativeTranscriptPlan | undefined {
  const initial = getInitialSystemMessage(messages);
  const initialTools = initial?.toolsAdded ?? [];
  if (!supported || initialTools.length === 0 || hasToolRedefinitions(messages)) {
    return undefined;
  }

  const declared = getDeclaredTools(messages);
  const prepared = prepareTools(declared);
  const nativeByName = new Map(
    prepared.nativeTools.map((tool) => [String(tool.name).slice(TOOL_NAME_PREFIX.length), tool]),
  );
  const initialNames = new Set(initialTools.map((tool) => tool.name));
  const initialNative = initialTools.map((tool) => {
    const native = nativeByName.get(tool.name);
    if (!native) {
      throw new Error(`Declared tool is missing from the native tool set: ${tool.name}`);
    }
    return structuredClone(native);
  });
  // No tool-level cache_control: Claude Code already sends two system
  // breakpoints and a tail breakpoint, and replay adds a history anchor.
  // Anthropic accepts at most four, so a tool breakpoint would reject every
  // turn that has replayed history.
  const laterNative = declared
    .filter((tool) => !initialNames.has(tool.name))
    .map((tool) => {
      const native = nativeByName.get(tool.name);
      if (!native) {
        throw new Error(`Declared tool is missing from the native tool set: ${tool.name}`);
      }
      return { ...structuredClone(native), defer_loading: true };
    });

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
    requestTools: [
      ...initialNative,
      structuredClone(DEFERRED_TOOL_PLACEHOLDER),
      ...laterNative,
    ],
    systemInjections,
  };
}

interface NativeRequestMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

/** Insert native system messages before their assistant boundaries. */
export function injectNativeSystemMessages(
  messages: NativeRequestMessage[],
  injections: NativeSystemInjection[],
): NativeRequestMessage[] {
  if (injections.length === 0) {
    return messages;
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
