/**
 * What one Pi model call sends: the system prompt, the request body, the
 * native transcript plan for mid-conversation tool changes, and the replay
 * frames. Pure: no files, processes, or network.
 */

import {
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
  getDeclaredTools,
  getInitialSystemMessage,
  getSystemMessageText,
} from "@earendil-works/pi-ai/compat";
import type { Api, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai/compat";
import { replaceDocsSections } from "./docs-section.js";
import { supportsNativeToolChanges } from "./model-compat.js";
import { prepareHistory, type ReplayAdjustment } from "./replay.js";
import { buildRequestBody, type RequestBuild } from "./request.js";
import { replayCacheControl } from "./prompt-cache.js";
import { prepareNativeTranscript, type NativeTranscriptPlan } from "./transcript.js";
import { recordedTurnEfforts } from "./turn-effort.js";
import type { NativeFrame } from "./types.js";

export interface RequestPlan {
  systemPrompt: string;
  /** The request body and inert MCP manifest; the body carries the native transcript's tools when there is one. */
  build: RequestBuild;
  /** Present when later system messages travel as native content. */
  nativeTranscript: NativeTranscriptPlan | undefined;
  /** Replay frames; the last one is the queried frame. */
  frames: NativeFrame[];
  /** The recorded effort of each replayed assistant frame; undefined where unknown. */
  turnEfforts: Array<string | undefined>;
  replayAdjustments: ReplayAdjustment[];
}

export function planRequest(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions,
  env: NodeJS.ProcessEnv,
  nativeModelId: string,
): RequestPlan {
  const cacheControl = replayCacheControl(env, nativeModelId);
  const messages = replaceDocsSections(context.messages);
  const nativeTranscript = options.toolChoice === "none"
    ? undefined
    : prepareNativeTranscript(messages, supportsNativeToolChanges(model.compat));
  const collapsed = collapseSystemMessages({ ...context, messages });
  const initialSystem = getInitialSystemMessage(messages);
  const systemPrompt = nativeTranscript && initialSystem
    ? getSystemMessageText(initialSystem)
    : getCurrentSystemPrompt(collapsed.messages);
  const history = (nativeTranscript ? messages : collapsed.messages)
    .filter((m) => m.role !== "system");
  // Pi's per-call override wins; otherwise the model's catalog limit must
  // reach the child. Claude Code replaces the request's max_tokens with its
  // own default (32,000 for models missing from its table), so a model limit
  // that never leaves Pi caps the turn far below the catalog value.
  const maxTokens =
    typeof options["maxTokens"] === "number" ? options["maxTokens"] : model.maxTokens;
  const build = buildRequestBody({
    tools: getCurrentTools(messages),
    toolChoice: options.toolChoice,
    reasoning: options.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    maxTokens,
  });
  if (nativeTranscript) {
    build.body["tools"] = nativeTranscript.requestTools;
  }
  // A historical call to a tool outside these is replayed as text.
  const allowedToolNames = nativeTranscript
    ? new Set(getDeclaredTools(messages).map((tool) => tool.name))
    : new Set(build.toolNames);
  const { frames, replayAdjustments } = prepareHistory(history, allowedToolNames, cacheControl);
  const turnEfforts = recordedTurnEfforts(history, model.thinkingLevelMap);
  return { systemPrompt, build, nativeTranscript, frames, turnEfforts, replayAdjustments };
}
