/**
 * Reads the child's stdout for the queried frame and streams it to Pi as it
 * arrives. Text and thinking are published progressively; tool calls wait for
 * the completion gate (`src/completion.ts`), because Pi may run them only
 * after the response is complete and the child has exited.
 */

import type {
  AssistantMessage,
  AssistantMessageEventStream,
  ThinkingContent,
} from "@earendil-works/pi-ai/compat";
import type { RateLimitInfo } from "./billing.js";
import { ClaudeNativeError } from "./errors.js";
import { isRecord, toNumber } from "./types.js";
import type { NativeAssistantMessage, NativeResultLine, NativeUsage } from "./types.js";

/** A text or thinking block published while it streams. */
export interface ProgressiveBlock {
  kind: "text" | "thinking";
  /** Native content-block index from the upstream stream. */
  nativeIndex: number;
  contentIndex: number;
  emitted: string;
  signature: string;
  redacted: boolean;
}

function findProgressive(
  progressive: ProgressiveBlock[],
  kind: ProgressiveBlock["kind"],
  nativeIndex: number,
): ProgressiveBlock | undefined {
  return (
    progressive.find((p) => p.kind === kind && p.nativeIndex === nativeIndex) ??
    [...progressive].reverse().find((p) => p.kind === kind)
  );
}

export function parseNativeLine(line: string): { type: string; [key: string]: unknown } {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed["type"] !== "string") {
      throw new Error("not a native event");
    }
    return parsed as { type: string; [key: string]: unknown };
  } catch (error) {
    throw new ClaudeNativeError(
      "native",
      `Invalid native stream-json output: ${JSON.stringify(line.slice(0, 300))}`,
      { cause: error },
    );
  }
}

function assistantErrorDetail(message: Record<string, unknown>): {
  text: string;
  code?: string | undefined;
} | null {
  const direct = message["error"];
  if (typeof direct === "string" && direct) {
    return { text: direct };
  }
  if (isRecord(direct)) {
    return {
      text: typeof direct["message"] === "string" ? direct["message"] : JSON.stringify(direct),
      code: typeof direct["code"] === "string" ? direct["code"] : undefined,
    };
  }
  const content = message["message"];
  const blocks = isRecord(content) ? content["content"] : message["content"];
  if (Array.isArray(blocks)) {
    const text = blocks
      .filter(isRecord)
      .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
      .map((b) => b["text"] as string)
      .join("\n");
    const nested = (message["message"] as Record<string, unknown> | undefined)?.["error"];
    if (text && nested) {
      return { text };
    }
  }
  return null;
}

/** What the child printed for the queried frame, with text and thinking already published. */
export class NativeOutput {
  readonly assistants: NativeAssistantMessage[] = [];
  readonly results: NativeResultLine[] = [];
  readonly progressive: ProgressiveBlock[] = [];
  /** Whether the stream reached message_stop. */
  stopped = false;
  streamId: string | undefined;
  streamModel: string | undefined;
  streamUsage: NativeUsage | undefined;
  streamStop: string | undefined;
  /** Error text from the child's assistant lines. */
  nativeErrorText: string | undefined;
  /** Text published so far. */
  emittedText = "";
  /** The latest usage seen, for diagnostics. */
  observedUsage: NativeUsage | undefined;
  latestRateLimit: RateLimitInfo | undefined;
  private toolBlocks = 0;
  private readonly output: AssistantMessage;
  private readonly stream: AssistantMessageEventStream;

  constructor(output: AssistantMessage, stream: AssistantMessageEventStream) {
    this.output = output;
    this.stream = stream;
  }

  accept(line: string): void {
    const event = parseNativeLine(line);
    if (event.type === "assistant") {
      const message = (event as { message?: unknown }).message;
      if (isRecord(message)) {
        const detail = assistantErrorDetail(message);
        if (detail) {
          this.nativeErrorText = this.nativeErrorText ? `${this.nativeErrorText}\n${detail.text}` : detail.text;
          if (detail.code === "authentication_failed") {
            this.nativeErrorText = `authentication_failed: ${this.nativeErrorText}`;
          }
        } else {
          // SAFETY: the completion gate reads only the fields it checks, and
          // takes the relay capture instead whenever there is one.
          this.assistants.push(message as unknown as NativeAssistantMessage);
        }
      }
    } else if (event.type === "result") {
      // SAFETY: every field of a result line is optional and checked where read.
      const result = event as unknown as NativeResultLine;
      this.results.push(result);
      if (isRecord(result.usage)) {
        this.observedUsage = result.usage as NativeUsage;
      }
    } else if (event.type === "rate_limit_event") {
      const info = event["rate_limit_info"];
      if (isRecord(info)) {
        this.latestRateLimit = info as RateLimitInfo;
      }
    } else if (event.type === "stream_event") {
      const native = (event as { event?: unknown }).event;
      if (isRecord(native)) {
        this.acceptStreamEvent(native);
      }
    }
  }

  private acceptStreamEvent(native: Record<string, unknown>): void {
    switch (native["type"]) {
      case "message_start": {
        const message = native["message"];
        if (isRecord(message)) {
          this.streamId = typeof message["id"] === "string" ? message["id"] : this.streamId;
          this.streamModel =
            typeof message["model"] === "string" ? message["model"] : this.streamModel;
          if (isRecord(message["usage"])) {
            this.streamUsage = message["usage"] as NativeUsage;
            this.observedUsage = this.streamUsage;
          }
        }
        break;
      }
      case "content_block_start":
        this.startBlock(native);
        break;
      case "content_block_delta":
        this.applyDelta(native);
        break;
      case "message_delta": {
        const delta = native["delta"];
        if (isRecord(delta) && typeof delta["stop_reason"] === "string") {
          this.streamStop = delta["stop_reason"];
        }
        const usage = native["usage"];
        if (isRecord(usage)) {
          this.streamUsage = { ...(this.streamUsage ?? {}), ...(usage as NativeUsage) } as NativeUsage;
          this.observedUsage = this.streamUsage;
        }
        break;
      }
      case "message_stop":
        this.stopped = true;
        break;
      default:
        break;
    }
  }

  private startBlock(native: Record<string, unknown>): void {
    const { output, stream } = this;
    const index = toNumber(native["index"]) ?? this.toolBlocks + this.progressive.length;
    const block = native["content_block"];
    if (!isRecord(block)) {
      return;
    }
    if (block["type"] === "text") {
      const contentIndex = output.content.length;
      output.content.push({ type: "text", text: "" });
      this.progressive.push({ kind: "text", nativeIndex: index, contentIndex, emitted: "", signature: "", redacted: false });
      stream.push({ type: "text_start", contentIndex, partial: output });
    } else if (block["type"] === "thinking") {
      const contentIndex = output.content.length;
      const thinkingBlock: ThinkingContent = {
        type: "thinking",
        thinking: "",
        thinkingSignature: typeof block["signature"] === "string" ? block["signature"] : "",
      };
      output.content.push(thinkingBlock);
      this.progressive.push({
        kind: "thinking",
        nativeIndex: index,
        contentIndex,
        emitted: "",
        signature: thinkingBlock.thinkingSignature ?? "",
        redacted: false,
      });
      stream.push({ type: "thinking_start", contentIndex, partial: output });
    } else if (block["type"] === "redacted_thinking") {
      const contentIndex = output.content.length;
      output.content.push({
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: typeof block["data"] === "string" ? block["data"] : "",
        redacted: true,
      });
      this.progressive.push({
        kind: "thinking",
        nativeIndex: index,
        contentIndex,
        emitted: "[Reasoning redacted]",
        signature: "",
        redacted: true,
      });
      stream.push({ type: "thinking_start", contentIndex, partial: output });
    } else if (block["type"] === "tool_use") {
      // Published by the completion gate from the final message.
      this.toolBlocks += 1;
    } else {
      throw new ClaudeNativeError(
        "native",
        `Unsupported native content block: ${String(block["type"])}`,
      );
    }
  }

  private applyDelta(native: Record<string, unknown>): void {
    const { output, stream } = this;
    const delta = native["delta"];
    const index = toNumber(native["index"]) ?? -1;
    if (!isRecord(delta)) {
      return;
    }
    if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
      const target = findProgressive(this.progressive, "text", index);
      if (target) {
        const block = output.content[target.contentIndex];
        if (block?.type === "text") {
          block.text += delta["text"];
          target.emitted += delta["text"];
          this.emittedText += delta["text"];
          stream.push({
            type: "text_delta",
            contentIndex: target.contentIndex,
            delta: delta["text"],
            partial: output,
          });
        }
      }
    } else if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
      const target = findProgressive(this.progressive, "thinking", index);
      const open = target && !target.redacted ? target : undefined;
      if (open) {
        const block = output.content[open.contentIndex];
        if (block?.type === "thinking") {
          block.thinking += delta["thinking"];
          open.emitted += delta["thinking"];
          stream.push({
            type: "thinking_delta",
            contentIndex: open.contentIndex,
            delta: delta["thinking"],
            partial: output,
          });
        }
      }
    } else if (delta["type"] === "signature_delta" && typeof delta["signature"] === "string") {
      const target = findProgressive(this.progressive, "thinking", index);
      if (target) {
        target.signature += delta["signature"];
        const block = output.content[target.contentIndex];
        if (block?.type === "thinking") {
          block.thinkingSignature = (block.thinkingSignature ?? "") + delta["signature"];
        }
      }
    }
  }
}
