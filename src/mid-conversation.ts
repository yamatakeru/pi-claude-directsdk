/**
 * Opt-in mid-conversation system messages (`PI_DIRECTSDK_MID_CONVERSATION_SYSTEM=1`).
 * The CLI still receives the collapsed current prompt and tools; the relay
 * rewrites the request into the form Pi's own Anthropic provider sends: the
 * leading prompt and initial tools stay fixed, later prompt and tool changes
 * travel as `role: system` messages with `tool_addition` / `tool_removal`.
 * Any mismatch forwards the collapsed request unchanged.
 */

import {
  getDeclaredTools,
  getInitialSystemMessage,
  getSystemMessageText,
  hasToolRedefinitions,
  renderSystemMessageUpdate,
} from "@earendil-works/pi-ai/compat";
import type { Message, SystemMessage, Tool } from "@earendil-works/pi-ai/compat";
import { isRecord } from "./types.js";

export const MID_CONVERSATION_ENV = "PI_DIRECTSDK_MID_CONVERSATION_SYSTEM";

// Declared from the first request: deferring any tool adds hidden scaffolding,
// so a first late tool would otherwise change the cached prefix (pi-ai measured).
const DEFERRED_PLACEHOLDER = {
  name: "__pi_deferred_placeholder__",
  description: "Reserved placeholder. Never available. Never call this.",
  input_schema: { type: "object", properties: {}, required: [] },
  defer_loading: true,
};

type WireTool = { name: string; [key: string]: unknown };
type Block = Record<string, unknown>;
type WireMessage = { role: string; content: unknown };

export interface MidConversationPlan {
  currentPrompt: string;
  initialPrompt: string;
  /** Current tools as the CLI sends them, in order (native names). */
  currentToolNames: string[];
  /** Replacement tool list, or null when tool changes cannot be expressed. */
  wireTools: WireTool[] | null;
  /** System messages to insert before the assistant message at `beforeAssistant`. */
  updates: Array<{ beforeAssistant: number; content: Block[] }>;
  assistantFrames: number;
}

export type MidConversationSkip =
  | "route has no mid-conversation system messages"
  | "leading prompt not uniquely matched"
  | "tool list differs from the current tools"
  | "assistant messages do not match the replay";

export interface MidConversationReport {
  applied: boolean;
  updates: number;
  nativeToolChanges: boolean;
  skipped: MidConversationSkip | null;
}

export function midConversationEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[MID_CONVERSATION_ENV];
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`${MID_CONVERSATION_ENV} must be 1 or 0; unset it to keep collapsed system prompts`);
}

/**
 * Build the plan from Pi's transcript. `assistantFramesBefore[i]` is the number
 * of replayed assistant frames before non-system history message `i`.
 */
export function planMidConversation(options: {
  messages: readonly Message[];
  currentPrompt: string;
  currentToolNames: string[];
  assistantFramesBefore: number[];
  nativeTools: (tools: Tool[]) => WireTool[];
  nativeName: (name: string) => string;
  toolsEnabled: boolean;
}): MidConversationPlan | null {
  const initial = getInitialSystemMessage(options.messages);
  if (!initial) return null;
  const initialTools = initial.toolsAdded ?? [];
  // Tool changes reference tools by name, so a redefined name cannot be expressed.
  const toolChanges =
    options.toolsEnabled && initialTools.length > 0 && !hasToolRedefinitions(options.messages);

  const updates: MidConversationPlan["updates"] = [];
  let historyIndex = 0;
  options.messages.forEach((message, i) => {
    if (message.role !== "system") {
      historyIndex++;
      return;
    }
    if (i === 0) return;
    const system = message as SystemMessage;
    const content: Block[] = [];
    const text = renderSystemMessageUpdate(system);
    if (text) content.push({ type: "text", text });
    if (toolChanges) {
      for (const tool of system.toolsRemoved ?? []) {
        content.push({ type: "tool_removal", tool: { type: "tool_reference", name: options.nativeName(tool.name) } });
      }
      for (const tool of system.toolsAdded ?? []) {
        content.push({ type: "tool_addition", tool: { type: "tool_reference", name: options.nativeName(tool.name) } });
      }
    }
    const beforeAssistant = options.assistantFramesBefore[historyIndex];
    if (content.length > 0 && beforeAssistant !== undefined) updates.push({ beforeAssistant, content });
  });

  let wireTools: WireTool[] | null = null;
  if (toolChanges) {
    const initialNames = new Set(initialTools.map((tool) => tool.name));
    const later = getDeclaredTools(options.messages).filter((tool) => !initialNames.has(tool.name));
    try {
      wireTools = [
        ...options.nativeTools(initialTools),
        DEFERRED_PLACEHOLDER,
        ...options.nativeTools(later).map((tool) => ({ ...tool, defer_loading: true })),
      ];
    } catch {
      // The updates already reference tools by name; without their declarations, keep collapsed.
      return null;
    }
  }

  return {
    currentPrompt: options.currentPrompt,
    initialPrompt: getSystemMessageText(initial),
    currentToolNames: options.currentToolNames,
    wireTools,
    updates,
    assistantFrames: options.assistantFramesBefore[options.assistantFramesBefore.length - 1] ?? 0,
  };
}

/** Apply the plan to a native request body; returns the original buffer unless applied. */
export function applyMidConversation(
  raw: Buffer,
  plan: MidConversationPlan,
): { body: Buffer; report: MidConversationReport } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf-8"));
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) {
    return { body: raw, report: { applied: false, updates: 0, nativeToolChanges: false, skipped: "leading prompt not uniquely matched" } };
  }
  const report = rewrite(parsed, plan);
  return { body: report.applied ? Buffer.from(JSON.stringify(parsed), "utf-8") : raw, report };
}

function rewrite(body: Record<string, unknown>, plan: MidConversationPlan): MidConversationReport {
  const report = (skipped: MidConversationSkip): MidConversationReport => ({
    applied: false,
    updates: 0,
    nativeToolChanges: false,
    skipped,
  });
  const messages = body["messages"];
  const system = body["system"];
  const tools = body["tools"] ?? [];
  if (!Array.isArray(messages) || !Array.isArray(system) || !Array.isArray(tools)) {
    return report("leading prompt not uniquely matched");
  }
  // Routes without the CLI's own mid-conversation system messages (e.g. Haiku 4.5).
  if (!messages.some((m) => isRecord(m) && m["role"] === "system")) {
    return report("route has no mid-conversation system messages");
  }
  const promptBlocks = system.filter(
    (block) => isRecord(block) && block["type"] === "text" && block["text"] === plan.currentPrompt,
  );
  if (promptBlocks.length !== 1) return report("leading prompt not uniquely matched");
  const names = tools.map((tool) => (isRecord(tool) ? tool["name"] : undefined));
  if (names.length !== plan.currentToolNames.length || names.some((n, i) => n !== plan.currentToolNames[i])) {
    return report("tool list differs from the current tools");
  }
  const assistants: number[] = [];
  messages.forEach((m, i) => {
    if (isRecord(m) && m["role"] === "assistant") assistants.push(i);
  });
  if (assistants.length !== plan.assistantFrames) {
    return report("assistant messages do not match the replay");
  }

  (promptBlocks[0] as Block)["text"] = plan.initialPrompt;
  if (plan.wireTools) body["tools"] = plan.wireTools;
  // Insert from the end so earlier indices stay valid; same-position updates keep order.
  const inserts = plan.updates.map((update) => ({
    at: update.beforeAssistant < assistants.length ? assistants[update.beforeAssistant]! : messages.length,
    message: { role: "system", content: update.content } satisfies WireMessage,
  }));
  for (let k = inserts.length - 1; k >= 0; k--) {
    const insert = inserts[k]!;
    messages.splice(insert.at, 0, insert.message);
  }
  return { applied: true, updates: plan.updates.length, nativeToolChanges: plan.wireTools !== null, skipped: null };
}
