import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { JsonObject } from "@earendil-works/pi-ai/compat";
import { toNumber, type NativeUsage } from "./types.js";

export const PREFIX_HASH_ENV = "PI_CLAUDE_NATIVE_PROMPT_HASHES";

export type TimingMilestone =
  | "historyPrepared"
  | "childSpawned"
  | "replayComplete"
  | "upstreamRequestStarted"
  | "upstreamResponseHeaders"
  | "upstreamFirstData"
  | "upstreamResponseEnded"
  | "childExited"
  | "completionPublished";

const MILESTONES: TimingMilestone[] = [
  "historyPrepared",
  "childSpawned",
  "replayComplete",
  "upstreamRequestStarted",
  "upstreamResponseHeaders",
  "upstreamFirstData",
  "upstreamResponseEnded",
  "childExited",
  "completionPublished",
];

function cacheReadShare(usage: NativeUsage | undefined): number | null {
  const input = toNumber(usage?.input_tokens);
  if (input === null) {
    return null;
  }
  const cacheRead = toNumber(usage?.cache_read_input_tokens) ?? 0;
  const cacheWrite = toNumber(usage?.cache_creation_input_tokens) ?? 0;
  const denominator = input + cacheRead + cacheWrite;
  return denominator > 0 ? cacheRead / denominator : null;
}

export function promptHashesEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[PREFIX_HASH_ENV];
  if (value === undefined || value === "0") {
    return false;
  }
  if (value === "1") {
    return true;
  }
  throw new Error(
    `${PREFIX_HASH_ENV} must be 1 or 0. Set it to 1 to enable prefix hashes, or unset it (or set it to 0) to disable them.`,
  );
}

export class RequestMeasurements {
  private readonly callStartedAt = performance.now();
  private readonly milestoneTimes: Partial<Record<TimingMilestone, number>> = {};
  private preparedFrames: number | null = null;
  private historicalFrames: number | null = null;
  private writtenFrames = 0;
  private historicalUserAcknowledgments = 0;
  private prefixHashes: {
    piSystemPromptSha256: string;
    piToolDefinitionsSha256: string;
  } | null = null;

  mark(milestone: TimingMilestone): void {
    if (this.milestoneTimes[milestone] === undefined) {
      this.milestoneTimes[milestone] = performance.now() - this.callStartedAt;
    }
  }

  setReplayFrameCount(frames: number): void {
    this.preparedFrames = frames;
    this.historicalFrames = Math.max(0, frames - 1);
  }

  recordFrameWritten(): void {
    this.writtenFrames += 1;
  }

  recordHistoricalUserAcknowledgment(): void {
    this.historicalUserAcknowledgments += 1;
  }

  hashPiInputs(systemPrompt: string, toolDefinitions: unknown): void {
    const hash = (value: string): string =>
      createHash("sha256").update(value, "utf8").digest("hex");
    this.prefixHashes = {
      piSystemPromptSha256: hash(systemPrompt),
      piToolDefinitionsSha256: hash(JSON.stringify({ toolDefinitions })),
    };
  }

  toJson(
    upstreamRequestBodyBytes: number | null,
    upstreamUsage: NativeUsage | undefined,
    observedUsage: NativeUsage | undefined,
    upstreamConnectionReused: boolean | null,
  ): JsonObject {
    const milestonesMs: JsonObject = {};
    for (const name of MILESTONES) {
      const value = this.milestoneTimes[name];
      milestonesMs[name] = value === undefined ? null : Number(value.toFixed(3));
    }
    const measurements: JsonObject = {
      milestonesMs,
      durationsMs: {
        historyPreparation: this.durationMs("callStarted", "historyPrepared"),
        setupAfterHistory: this.durationMs("historyPrepared", "childSpawned"),
        spawnToReplayComplete: this.durationMs("childSpawned", "replayComplete"),
        replayToUpstreamRequest: this.durationMs("replayComplete", "upstreamRequestStarted"),
        upstreamToHeaders: this.durationMs("upstreamRequestStarted", "upstreamResponseHeaders"),
        headersToFirstData: this.durationMs("upstreamResponseHeaders", "upstreamFirstData"),
        upstreamToFirstData: this.durationMs("upstreamRequestStarted", "upstreamFirstData"),
        firstDataToUpstreamEnd: this.durationMs("upstreamFirstData", "upstreamResponseEnded"),
        upstreamRequest: this.durationMs("upstreamRequestStarted", "upstreamResponseEnded"),
        upstreamEndToChildExit: this.durationMs("upstreamResponseEnded", "childExited"),
        childExitToCompletion: this.durationMs("childExited", "completionPublished"),
      },
      replay: {
        framesPrepared: this.preparedFrames,
        historicalFrames: this.historicalFrames,
        framesWritten: this.writtenFrames,
        historicalUserAcknowledgments: this.historicalUserAcknowledgments,
      },
      upstreamRequestBodyBytes,
      upstreamConnectionReused,
      cacheReadShare:
        cacheReadShare(upstreamUsage) ?? cacheReadShare(observedUsage),
    };
    if (this.prefixHashes) {
      measurements["prefixHashes"] = this.prefixHashes;
    }
    return measurements;
  }

  private durationMs(
    start: "callStarted" | TimingMilestone,
    end: TimingMilestone,
  ): number | null {
    const startAt = start === "callStarted" ? 0 : this.milestoneTimes[start];
    const endAt = this.milestoneTimes[end];
    if (startAt === undefined || endAt === undefined || endAt < startAt) {
      return null;
    }
    return Number((endAt - startAt).toFixed(3));
  }
}
