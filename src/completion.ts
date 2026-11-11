/**
 * The completion gate and final publication of one call.
 *
 * The gate decides which native message is the response, from the relay
 * capture or the child's stdout, and turns every failure the child or the
 * upstream reported into a typed error. Publication then settles usage,
 * reconciles the streamed text and thinking with that message, closes them,
 * and publishes tool calls, which Pi may run only once the response is
 * complete and the child has exited.
 */

import { calculateCost } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  JsonObject,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai/compat";
import { formatRelayFailure, type AdmissionRelay } from "./admission.js";
import { enforceUsageCredits, usageCreditsRejectionError } from "./billing.js";
import {
  ClaudeNativeError,
  incompleteError,
  loggedOutError,
  nativeError,
  upstreamError,
} from "./errors.js";
import type { NativeOutput } from "./native-output.js";
import { toolBareName } from "./request.js";
import { deepClone, isRecord, toNumber } from "./types.js";
import type {
  NativeAssistantMessage,
  NativeContentBlock,
  NativeResultLine,
  NativeUsage,
} from "./types.js";

/** What the gate reads from the relay. */
export type RelayOutcome = Pick<
  AdmissionRelay,
  "used" | "status" | "capture" | "failure" | "denied" | "errorText"
>;

/** The response the gate accepted. */
export interface GatedResponse {
  /** The response: the relay capture, or the child's assistant lines merged. */
  authoritative: NativeAssistantMessage;
  result: NativeResultLine;
}

/** Pi usage from authoritative native usage. Returns null when incomplete. */
export function mapUsage(usage: NativeUsage | undefined): AssistantMessage["usage"] | null {
  const input = toNumber(usage?.input_tokens);
  const output = toNumber(usage?.output_tokens);
  if (input === null || output === null) {
    return null;
  }
  const cacheRead = toNumber(usage?.cache_read_input_tokens) ?? 0;
  const cacheWrite = toNumber(usage?.cache_creation_input_tokens) ?? 0;
  const cacheWrite1h =
    toNumber(usage?.cache_creation?.ephemeral_1h_input_tokens) ?? undefined;
  const reasoning =
    toNumber(usage?.output_tokens_details?.thinking_tokens) ?? undefined;
  const mapped: AssistantMessage["usage"] = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (cacheWrite1h !== undefined) {
    mapped.cacheWrite1h = cacheWrite1h;
  }
  if (reasoning !== undefined) {
    mapped.reasoning = reasoning;
  }
  return mapped;
}

/**
 * Accept the call's response or throw why there is none. `childDetail` names
 * the child's exit status and stderr for errors about its result.
 */
export function gateResponse(options: {
  relay: RelayOutcome;
  native: NativeOutput;
  exitCode: number | null;
  childDetail: string;
  model: Model<Api>;
  nativeModelId: string;
}): GatedResponse {
  const { relay, native, exitCode, childDetail, model, nativeModelId } = options;
  const { results, assistants, nativeErrorText } = native;
  const used = relay.used;
  // A failed upstream response explains the turn even when the CLI then ends
  // without a result line, as it can at a usage limit, so report it first.
  if (used && (relay.status !== 200 || !relay.capture.complete || !relay.capture.message)) {
    const rejection = usageCreditsRejectionError(
      [relay.errorText(), nativeErrorText].filter(Boolean).join("\n"),
    );
    if (rejection) throw rejection;
    throw upstreamError(
      `first upstream attempt: status ${relay.status ?? "unknown"}, ` +
        `capture ${relay.capture.complete ? "complete" : "incomplete"}` +
        (relay.failure ? `, relay failure ${formatRelayFailure(relay.failure)}` : "") +
        `, native retries denied: ${relay.denied}` +
        (relay.errorText() ? `, upstream said: ${relay.errorText().slice(0, 500)}` : "") +
        (nativeErrorText ? `: ${nativeErrorText}` : "") +
        (results.length !== 1 ? `; native result lines: ${results.length}${childDetail}` : ""),
    );
  }
  const result = results[0];
  if (results.length !== 1 || !result) {
    throw incompleteError(
      `Expected exactly one native result, saw ${results.length}${childDetail}`,
    );
  }
  const resultErrors = [
    ...(typeof result["result"] === "string" && result["result"] ? [result["result"]] : []),
    ...(Array.isArray(result["errors"]) ? result["errors"].filter((value): value is string => typeof value === "string") : []),
  ].join("; ");
  let authoritative: NativeAssistantMessage;
  if (used && relay.capture.message) {
    authoritative = relay.capture.message;
  } else {
    if (nativeErrorText && /authentication_failed|not logged in/i.test(nativeErrorText)) {
      throw loggedOutError(nativeErrorText);
    }
    if (nativeErrorText) {
      const rejection = usageCreditsRejectionError(nativeErrorText);
      if (rejection) throw rejection;
      throw nativeError(nativeErrorText);
    }
    if (result.is_error && resultErrors) {
      const rejection = usageCreditsRejectionError(resultErrors);
      if (rejection) throw rejection;
      if (/not logged in|authentication_failed/i.test(resultErrors)) {
        throw loggedOutError(resultErrors);
      }
      if (/prompt is too long|context_length_exceeded/i.test(resultErrors)) {
        throw nativeError(
          `context_length_exceeded: ${resultErrors}. Model ${model.id} uses native route ${nativeModelId} ` +
          `with a configured context window of ${model.contextWindow.toLocaleString("en-US")} tokens. ` +
          "Check this model's contextWindow override in models.json or compact the session.",
        );
      }
      throw nativeError(`${result.subtype ?? "native failure"}: ${resultErrors}${childDetail}`);
    }
    if (assistants.length === 0 || !native.stopped) {
      const resultText =
        typeof result["result"] === "string" ? result["result"] : undefined;
      if (resultText && /not logged in/i.test(resultText)) {
        throw loggedOutError(resultText);
      }
      throw incompleteError(`assistant, message_stop and one result required${childDetail}`);
    }
    authoritative = mergeAssistants(assistants, result);
  }

  const denialHandled = relay.denied > 0 || authoritative.stop_reason === "refusal";
  const requestRejection = usageCreditsRejectionError(
    [relay.errorText(), nativeErrorText, result.is_error ? resultErrors : undefined].filter(Boolean).join("\n"),
  );
  if (requestRejection) {
    throw requestRejection;
  }
  if (nativeErrorText && !denialHandled) {
    throw nativeError(nativeErrorText);
  }
  // Claude Code answers a tool call locally, which needs a second turn, so
  // `--max-turns 1` ends a tool-use turn with error_max_turns and exit code 1.
  // A call cut off at max_tokens is dropped from the capture but still
  // answered by Claude Code.
  const calls = blocksOf(authoritative, "tool_use");
  const boundary =
    (calls.length > 0 || relay.capture.unparsed.length > 0) &&
    result.subtype === "error_max_turns" &&
    exitCode === 1;
  if (
    !boundary &&
    !denialHandled &&
    (exitCode !== 0 || result.is_error || result.subtype !== "success")
  ) {
    const detail = resultErrors ? `: ${resultErrors}` : "";
    throw nativeError(`${result.subtype ?? "unknown exit"}${detail}`);
  }
  return { authoritative, result };
}

/**
 * Settle the accepted response into `output` and publish what was not
 * streamed: the rest of the text, the end of each block, and tool calls.
 * Returns the stop reason it set. Throws when the response cannot become a
 * Pi message.
 */
export function publishResponse(options: {
  output: AssistantMessage;
  stream: AssistantMessageEventStream;
  model: Model<Api>;
  native: NativeOutput;
  gated: GatedResponse;
  /** Bare names of the active tools. */
  toolNames: string[];
  /** Tools whose calls the capture dropped because they were cut off at max_tokens. */
  cutCalls: string[];
  env: NodeJS.ProcessEnv;
}): PublishedStop {
  const { output, model, native, gated: { authoritative, result }, env } = options;
  native.observedUsage = authoritative.usage ?? native.streamUsage ?? result.usage;
  const usage = mapUsage(native.observedUsage);
  if (!usage) {
    throw incompleteError("Native result missing complete token usage");
  }
  output.usage = usage;
  calculateCost(model, output.usage);
  enforceUsageCredits(native.latestRateLimit, env);
  if (typeof authoritative.id === "string" && authoritative.id) {
    output.responseId = authoritative.id;
  } else if (native.streamId) {
    output.responseId = native.streamId;
  }
  const responseModel = authoritative.model ?? native.streamModel;
  if (responseModel && responseModel !== model.id) {
    output.responseModel = responseModel;
  }
  output.rawStopReason = authoritative.stop_reason ?? native.streamStop ?? result.subtype ?? "unknown";
  output.endTurn = (authoritative.stop_reason ?? native.streamStop) === "end_turn";

  closeStreamedBlocks(options);
  const toolCalls = publishToolCalls(options);
  return settleStop(options, toolCalls.length);
}

type PublishedStop = "stop" | "length" | "toolUse" | "error";

/** Add text the stream did not deliver, then end every streamed block. */
function closeStreamedBlocks(options: {
  output: AssistantMessage;
  stream: AssistantMessageEventStream;
  native: NativeOutput;
  gated: GatedResponse;
}): void {
  const { output, stream, native: { emittedText, progressive }, gated: { authoritative } } = options;
  const finalText = textOf(authoritative);
  if (emittedText !== finalText) {
    if (emittedText && !finalText.startsWith(emittedText)) {
      throw incompleteError("Native final text differs from incremental stream");
    }
    const tail = finalText.slice(emittedText.length);
    if (tail) {
      const target = [...progressive].reverse().find((p) => p.kind === "text");
      if (target) {
        const block = output.content[target.contentIndex];
        if (block?.type === "text") {
          block.text += tail;
          stream.push({
            type: "text_delta",
            contentIndex: target.contentIndex,
            delta: tail,
            partial: output,
          });
        }
      } else {
        const contentIndex = output.content.length;
        output.content.push({ type: "text", text: tail });
        stream.push({ type: "text_start", contentIndex, partial: output });
        stream.push({ type: "text_delta", contentIndex, delta: tail, partial: output });
      }
    }
  }
  const finalThinkings = blocksOf(authoritative, "thinking");
  const openThinkings = progressive.filter((p) => p.kind === "thinking");
  openThinkings.forEach((prog, i) => {
    const block = output.content[prog.contentIndex];
    const final = finalThinkings[i] as
      | { thinking?: unknown; signature?: unknown }
      | undefined;
    if (block?.type === "thinking" && !prog.redacted) {
      if (typeof final?.signature === "string") {
        block.thinkingSignature = final.signature;
      } else if (prog.signature) {
        block.thinkingSignature = prog.signature;
      }
    }
    if (block?.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: prog.contentIndex,
        content: block.thinking,
        partial: output,
      });
    }
  });
  const openTexts = progressive.filter((p) => p.kind === "text");
  for (const prog of openTexts) {
    const block = output.content[prog.contentIndex];
    if (block?.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: prog.contentIndex,
        content: block.text,
        partial: output,
      });
    }
  }
}

/** Publish the response's tool calls, each to an active tool. */
function publishToolCalls(options: {
  output: AssistantMessage;
  stream: AssistantMessageEventStream;
  gated: GatedResponse;
  toolNames: string[];
}): ToolCall[] {
  const { output, stream, gated: { authoritative }, toolNames } = options;
  const toolCalls: ToolCall[] = [];
  for (const block of blocksOf(authoritative, "tool_use")) {
    // SAFETY: native content blocks are JSON objects; each field is checked below.
    const raw = block as unknown as Record<string, unknown>;
    const name = typeof raw["name"] === "string" ? raw["name"] : "";
    const bare = toolBareName(name);
    if (!bare || !toolNames.includes(bare)) {
      throw new ClaudeNativeError(
        "native",
        "Native returned a tool outside the active tools",
      );
    }
    const parsed = parseToolInput(raw["input"]);
    const toolCall: ToolCall = {
      type: "toolCall",
      id: typeof raw["id"] === "string" && raw["id"] ? raw["id"] : `tool-${toolCalls.length}`,
      name: bare,
      arguments: parsed,
    };
    const contentIndex = output.content.length;
    output.content.push({ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: {} });
    stream.push({ type: "toolcall_start", contentIndex, partial: output });
    const delta = JSON.stringify(parsed);
    stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
    const final = output.content[contentIndex];
    if (final?.type === "toolCall") {
      final.arguments = parsed;
    }
    toolCalls.push(toolCall);
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
  }
  return toolCalls;
}

/** Map the native stop reason, failing a turn that ended without an answer. */
function settleStop(
  options: {
    output: AssistantMessage;
    model: Model<Api>;
    native: NativeOutput;
    gated: GatedResponse;
    cutCalls: string[];
  },
  toolCallCount: number,
): PublishedStop {
  const { output, model, native, gated: { authoritative }, cutCalls } = options;
  const stop = authoritative.stop_reason ??
    native.streamStop ??
    (blocksOf(authoritative, "tool_use").length > 0 ? "tool_use" : "end_turn");
  const mapped = mapStopReason(
    stop,
    stop === "refusal" ? refusalText(authoritative) : undefined,
  );
  if (mapped.stopReason === "toolUse" && toolCallCount === 0) {
    throw incompleteError("Native stopped for tool use without tool calls");
  }
  output.stopReason = mapped.stopReason;
  if (mapped.errorMessage) {
    output.errorMessage = mapped.errorMessage;
  }
  // A turn can spend its entire output budget on thinking and return no text
  // and no tool call. Pi would publish an empty message and a generic
  // truncation notice that names no cause, so fail with the cause instead.
  const answered = output.content.some(
    (block) => (block.type === "text" && block.text.trim() !== "") || block.type === "toolCall",
  );
  if (stop === "max_tokens" && !answered && cutCalls.length > 0) {
    throw nativeError(
      `${model.id} ran out of output tokens while writing the arguments of ${cutCalls.join(", ")}, ` +
        "so the call was not run. Ask for smaller steps, or lower the thinking level, then retry.",
    );
  }
  if (stop === "max_tokens" && !answered) {
    throw nativeError(
      `${model.id} spent its whole output budget on thinking and returned no answer. ` +
        "Lower the thinking level or switch models, then retry.",
    );
  }
  return mapped.stopReason;
}

function mapStopReason(stop: string, detail?: string): {
  stopReason: PublishedStop;
  errorMessage?: string;
} {
  switch (stop) {
    case "end_turn":
      return { stopReason: "stop" };
    case "max_tokens":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "pause_turn":
    case "stop_sequence":
      return { stopReason: "stop" };
    case "refusal":
      return {
        stopReason: "error",
        errorMessage: detail || "The model refused to complete the request",
      };
    default:
      return { stopReason: "error", errorMessage: `Unhandled stop reason: ${stop}` };
  }
}

/** Merge stdout assistant messages for the non-relay fallback path. */
function mergeAssistants(
  assistants: NativeAssistantMessage[],
  result: NativeResultLine,
): NativeAssistantMessage {
  const content: NativeContentBlock[] = [];
  let stop: string | null | undefined;
  let id: string | undefined;
  let model: string | undefined;
  for (const assistant of assistants) {
    content.push(...deepClone(assistant.content));
    stop = assistant.stop_reason ?? stop;
    id = assistant.id ?? id;
    model = assistant.model ?? model;
  }
  return {
    role: "assistant",
    content,
    stop_reason: stop ?? null,
    usage: deepClone(result.usage ?? { input_tokens: 0, output_tokens: 0 }),
    ...(id ? { id } : {}),
    ...(model ? { model } : {}),
  };
}

function blocksOf(message: NativeAssistantMessage, type: string): NativeContentBlock[] {
  return message.content.filter((b) => b.type === type);
}

function textOf(message: NativeAssistantMessage): string {
  // SAFETY: blocksOf returned only text blocks, which carry `text`.
  return blocksOf(message, "text")
    .map((b) => ((b as unknown as Record<string, unknown>)["text"] as string) ?? "")
    .join("");
}

function refusalText(message: NativeAssistantMessage): string {
  const text = textOf(message);
  return text || "The model refused to complete the request";
}

/** Tool input as Pi arguments. Input that is not a JSON object throws, failing the call. */
function parseToolInput(input: unknown): JsonObject {
  const coerce = (value: unknown): JsonObject => {
    if (!isRecord(value)) {
      throw new ClaudeNativeError("native", "Native tool input is not an object");
    }
    // A JSON round-trip keeps the arguments within pi-ai's JsonValue type.
    return JSON.parse(JSON.stringify(value)) as JsonObject;
  };
  if (typeof input === "string") {
    return coerce(input.trim() ? (JSON.parse(input) as unknown) : {});
  }
  return coerce(input);
}
