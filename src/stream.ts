/**
 * Pi `streamSimple` implementation for the Claude Native provider.
 *
 * One Pi model call spawns one request-scoped `claude` child, replays Pi
 * history in native `stream-json` form, admits at most one upstream Messages
 * request through the loopback relay, and converts the native response to Pi
 * stream events. Pi alone executes tools: native tool calls are published
 * only after the first upstream response is complete, usage and stop reason
 * are captured, and the child has exited.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessage,
  AssistantMessageDiagnostic,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { AdmissionRelay } from "./admission.js";
import { rateLimitDiagnostic } from "./billing.js";
import { gateResponse, mapUsage, publishResponse } from "./completion.js";
import {
  PREFIX_HASH_ENV,
  RequestMeasurements,
  promptHashesEnabled,
} from "./measurements.js";
import {
  cancelledError,
  envConflictError,
  incompleteError,
  isCancelled,
  missingError,
  nativeError,
} from "./errors.js";
import { PROVIDER_ID, QUALIFIED_CLI_RANGE, nativeModel } from "./models.js";
import type { NativeContextReport } from "./native-context.js";
import { NativeOutput, parseNativeLine } from "./native-output.js";
import { rewriteNativeRequest } from "./native-rewrite.js";
import { encodeCarrier, messageProjection, type ReplayAdjustment } from "./replay.js";
import { planRequest } from "./request-plan.js";
import {
  buildArgv,
  buildChildEnv,
  checkEnvConflicts,
  requestEffort,
  writeRequestFiles,
} from "./request.js";
import { NATIVE_TOOL_CHANGES_BETA } from "./transcript.js";
import { qualifiedCli, resolveClaude } from "./setup.js";
import { deepClone, isRecord } from "./types.js";
import { spawnSupervised, stableChildCwd } from "./process.js";
import type { ChildHandle } from "./process.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const NATIVE_API = "claude-native";

export interface CallDeps {
  spawn: (options: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
  }) => ChildHandle;
  createRelay: (
    upstream: string,
    timeoutMs: number,
    options?: { transformRequest?: (body: Buffer) => Buffer; betas?: string[] },
  ) => Promise<AdmissionRelay>;
  checkCli: (resolved: string[], env: NodeJS.ProcessEnv) => boolean;
  makeRequestDir: () => string;
  childCwd: () => string;
}

export const defaultDeps: CallDeps = {
  spawn: (options) => spawnSupervised(options),
  createRelay: (upstream, timeoutMs, options) => AdmissionRelay.create(upstream, timeoutMs, options),
  checkCli: (resolved, env) => qualifiedCli(resolved, env),
  makeRequestDir: () => mkdtempSync(join(tmpdir(), "pi-claude-native-")),
  childCwd: () => stableChildCwd(),
};

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function streamClaudeNative(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
  deps: CallDeps = defaultDeps,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void executeCall(model, context, options ?? {}, stream, deps).catch((error) => {
    // executeCall always terminates the stream itself; this is unreachable.
    void error;
  });
  return stream;
}

async function executeCall(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions,
  stream: AssistantMessageEventStream,
  deps: CallDeps,
): Promise<void> {
  const measurements = new RequestMeasurements();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: NATIVE_API,
    provider: PROVIDER_ID,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  let started = false;
  let relay: AdmissionRelay | null = null;
  let child: ChildHandle | null = null;
  let requestDir: string | null = null;
  let nativeModelId: string | null = null;
  let cliAvailable = false;
  let nativeCostUsd = -1;
  let native: NativeOutput | null = null;
  let abortRelay: (() => void) | undefined;
  let nativeContext: NativeContextReport | null = null;
  let replayAdjustments: ReplayAdjustment[] = [];

  const metaDiagnostic = (): AssistantMessageDiagnostic => {
    return {
      type: "pi-claude-native/meta",
      timestamp: Date.now(),
      details: {
        nativeModel: nativeModelId,
        requestId: relay?.requestId ?? "",
        upstreamRequests: relay?.used ? 1 : 0,
        blockedRequests: relay?.denied ?? 0,
        relayFailure: relay?.failure ? deepClone(relay.failure) : null,
        nativeContext: nativeContext
          ? { applied: [...nativeContext.applied], skipped: [...nativeContext.skipped] }
          : null,
        replayAdjustments: replayAdjustments.map((adjustment) => ({ ...adjustment })),
        nativeCostUsd,
        nativeCostNote: "estimate, not subscription charge",
        cliAvailable,
        measurements: measurements.toJson(
          relay?.requestBodyBytes ?? null,
          relay?.capture.message?.usage,
          native?.observedUsage,
          relay?.upstreamConnectionReused ?? null,
        ),
      },
    };
  };
  const fail = (error: unknown): void => {
    if (child?.exitInfo) {
      measurements.mark("childExited");
    }
    measurements.mark("completionPublished");
    const aborted = isCancelled(error) || options.signal?.aborted === true;
    // Keep any usage captured before the failure instead of zeroing it.
    output.stopReason = aborted ? "aborted" : "error";
    output.errorMessage =
      error instanceof Error ? error.message : JSON.stringify(error);
    const diagnostics = output.diagnostics ?? [];
    output.diagnostics = [
      ...diagnostics.filter((diagnostic) => diagnostic.type !== "pi-claude-native/meta"),
      ...(native?.latestRateLimit ? [rateLimitDiagnostic(native.latestRateLimit)] : []),
      metaDiagnostic(),
    ];
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end();
  };

  const cleanup = (): void => {
    if (abortRelay) options.signal?.removeEventListener("abort", abortRelay);
    if (child) {
      child.cancel();
    }
    if (relay) {
      void relay.close().catch(() => undefined);
    }
    if (requestDir) {
      try {
        rmSync(requestDir, { recursive: true, force: true });
      } catch {
        // Cleanup must not mask the request outcome.
      }
    }
  };
  if (options.signal?.aborted) {
    fail(cancelledError());
    return;
  }

  try {
    const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    const includePrefixHashes = promptHashesEnabled(mergedEnv);
    const conflicts = checkEnvConflicts(mergedEnv);
    if (conflicts.length > 0) {
      throw envConflictError(conflicts);
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be positive milliseconds");
    }

    const requestNativeModelId = nativeModel(model.id, model.contextWindow);
    nativeModelId = requestNativeModelId;
    const plan = planRequest(model, context, options, mergedEnv, requestNativeModelId);
    const { systemPrompt, build, nativeTranscript, frames } = plan;
    replayAdjustments = plan.replayAdjustments;
    measurements.setReplayFrameCount(frames.length);
    measurements.mark("historyPrepared");

    // Extension request inspection hook. The replacement replaces the native
    // request body when it returns one.
    const payloadReplacement = await options.onPayload?.(
      deepClone(build.body),
      model,
    );
    const body =
      payloadReplacement === undefined
        ? build.body
        : isRecord(payloadReplacement)
          ? (payloadReplacement as Record<string, unknown>)
          : (() => {
              throw new Error("onPayload replacement must be an object");
            })();
    if (includePrefixHashes) {
      measurements.hashPiInputs(systemPrompt, {
        requestTools: body["tools"] ?? null,
        mcpManifest: build.manifest,
      });
    }

    const resolved = resolveClaude(undefined, mergedEnv);
    if (!resolved?.[0]) {
      throw missingError();
    }
    if (!deps.checkCli(resolved, mergedEnv)) {
      throw nativeError(
        `Unsupported claude version: this provider qualifies ${QUALIFIED_CLI_RANGE}`,
      );
    }
    cliAvailable = true;
    const upstream = mergedEnv["ANTHROPIC_BASE_URL"] || "https://api.anthropic.com";

    requestDir = deps.makeRequestDir();
    const files = writeRequestFiles(requestDir, {
      systemPrompt,
      body,
      manifest: build.manifest,
    });
    // The final frame is exactly what Pi queried.
    const queried = frames[frames.length - 1]?.message.content ?? [];
    relay = await deps.createRelay(upstream, timeoutMs, {
      transformRequest: (raw: Buffer) => {
        const rewrite = rewriteNativeRequest(raw, queried, nativeTranscript);
        nativeContext = rewrite.nativeContext;
        return rewrite.body;
      },
      ...(nativeTranscript ? { betas: [NATIVE_TOOL_CHANGES_BETA] } : {}),
    });
    const activeRelay = relay;
    // Stashed at header time, invoked after the response completes and
    // before the completion gate consumes it, per the streamSimple contract.
    let providerResponse: { status: number; headers: Record<string, string> } | null = null;
    activeRelay.onUpstreamResponse = (status, headers) => {
      measurements.mark("upstreamResponseHeaders");
      providerResponse = { status, headers };
    };
    activeRelay.onUpstreamRequestStarted = () => measurements.mark("upstreamRequestStarted");
    activeRelay.onUpstreamFirstData = () => measurements.mark("upstreamFirstData");
    activeRelay.onUpstreamResponseEnded = () => measurements.mark("upstreamResponseEnded");
    abortRelay = (): void => {
      activeRelay.abort();
    };
    options.signal?.addEventListener("abort", abortRelay, { once: true });

    const childEnv = buildChildEnv({ baseEnv: mergedEnv, relayUrl: relay.url, body });
    delete childEnv[PREFIX_HASH_ENV];
    const { command, args } = buildArgv({
      claudeBin: resolved[0],
      nativeModelId: requestNativeModelId,
      files,
      effort: requestEffort(body),
    });
    child = deps.spawn({
      command,
      args,
      env: childEnv,
      cwd: deps.childCwd(),
      timeoutMs,
      signal: options.signal,
    });
    measurements.mark("childSpawned");

    stream.push({ type: "start", partial: output });
    started = true;

    // Replay history. Historical user frames expect zero-turn
    // acknowledgments; only the final frame may generate.
    for (let i = 0; i < frames.length; i += 1) {
      const frame = frames[i];
      if (!frame) {
        continue;
      }
      if (i === frames.length - 1) {
        measurements.mark("replayComplete");
      }
      await child.writeLine(JSON.stringify(frame));
      measurements.recordFrameWritten();
      if (frame.type === "user" && i < frames.length - 1) {
        for (;;) {
          const line = await child.nextLine();
          if (line === null) {
            throw incompleteError("Native exited before replay acknowledgment");
          }
          const ack = parseNativeLine(line);
          if (ack.type !== "result") {
            continue;
          }
          if (ack.num_turns !== 0 || ack.is_error) {
            throw incompleteError(
              "Native history replay not supported: expected zero-turn acknowledgment",
            );
          }
          measurements.recordHistoricalUserAcknowledgment();
          break;
        }
      }
    }
    child.closeStdin();

    // Consume the final response. Text and thinking stream as they arrive.
    const nativeOutput = new NativeOutput(output, stream);
    native = nativeOutput;
    for (;;) {
      const line = await child.nextLine();
      if (line === null) {
        break;
      }
      nativeOutput.accept(line);
      if (options.signal?.aborted) {
        throw cancelledError();
      }
    }

    const exitInfo = await child.wait();
    measurements.mark("childExited");
    if (options.signal?.aborted) {
      throw cancelledError();
    }
    if (providerResponse) {
      await options.onResponse?.(providerResponse, model);
    }

    // Completion gate. Tool calls publish only after the first upstream
    // response is complete, usage and stop reason are captured, and the
    // child has exited.
    // Native result diagnostics can be present even when stderr is empty.
    const childDetail = ` (exit ${child.exitInfo?.code ?? "?"}${
      child.exitInfo?.signal ? `/${child.exitInfo.signal}` : ""
    }, stderr: ${child.stderrTail(500) || "<empty>"})`;
    const gated = gateResponse({
      relay,
      native: nativeOutput,
      exitCode: exitInfo.code,
      childDetail,
      model,
      nativeModelId: requestNativeModelId,
    });
    const stopReason = publishResponse({
      output,
      stream,
      model,
      native: nativeOutput,
      gated,
      toolNames: build.toolNames,
      cutCalls: relay.capture.unparsed,
      env: mergedEnv,
    });

    const projection = messageProjection(output);
    const natives = relay.used && relay.capture.message ? [relay.capture.message] : nativeOutput.assistants;
    nativeCostUsd =
      typeof gated.result.total_cost_usd === "number" ? gated.result.total_cost_usd : -1;
    const carrier = encodeCarrier(natives, projection);
    measurements.mark("completionPublished");
    output.diagnostics = [
      carrier,
      ...(nativeOutput.latestRateLimit ? [rateLimitDiagnostic(nativeOutput.latestRateLimit)] : []),
      metaDiagnostic(),
    ];

    if (stopReason === "error") {
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
      return;
    }
    stream.push({ type: "done", reason: stopReason, message: output });
    stream.end();
  } catch (error) {
    // Preserve partial usage captured before the failure.
    if (started && relay?.capture.message?.usage) {
      const partial = mapUsage(relay.capture.message.usage);
      if (partial) {
        try {
          calculateCost(model, partial);
          output.usage = partial;
        } catch {
          // Accounting must not mask the original failure.
        }
      }
    }
    fail(error);
  } finally {
    cleanup();
  }
}
