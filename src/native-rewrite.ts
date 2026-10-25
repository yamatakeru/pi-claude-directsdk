/**
 * The relay's payload hook: parse the admitted request once, apply the
 * replay-stable context (`native-context.ts`), then insert the native system
 * messages for mid-conversation tool changes (`transcript.ts`), and serialize
 * once. The original bytes are forwarded whenever nothing applied.
 *
 * Native-context runs first: it reads the CLI's own trailing system message,
 * which an injection at the request tail would otherwise follow.
 */

import { stabilizeNativeRequest, type NativeContextReport } from "./native-context.js";
import { injectNativeSystemMessages, type NativeTranscriptPlan } from "./transcript.js";
import type { NativeContentBlock } from "./types.js";
import { isRecord } from "./types.js";

export interface NativeRewrite {
  body: Buffer;
  nativeContext: NativeContextReport;
}

function parse(raw: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf-8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Native-context never fails a call. A required system injection that cannot
 * be applied throws, and the relay answers 500 without contacting upstream.
 */
export function rewriteNativeRequest(
  raw: Buffer,
  queried: readonly NativeContentBlock[],
  plan?: NativeTranscriptPlan,
): NativeRewrite {
  const injections = plan?.systemInjections ?? [];
  let parsed = parse(raw);
  if (!parsed) {
    if (injections.length > 0) throw new Error("Native request is not a JSON object");
    return { body: raw, nativeContext: { applied: [], skipped: ["body is not a Messages request"] } };
  }

  let nativeContext: NativeContextReport;
  try {
    nativeContext = stabilizeNativeRequest(parsed, queried);
  } catch {
    // A partial edit must not reach upstream: start again from the CLI's body.
    parsed = parse(raw)!;
    nativeContext = { applied: [], skipped: ["rewrite failed"] };
  }

  if (injections.length > 0) {
    const messages = parsed["messages"];
    if (!Array.isArray(messages)) throw new Error("Native request is missing its messages array");
    parsed["messages"] = injectNativeSystemMessages(messages, injections, plan!.assistantFrames);
  } else if (nativeContext.applied.length === 0) {
    return { body: raw, nativeContext };
  }
  return { body: Buffer.from(JSON.stringify(parsed), "utf-8"), nativeContext };
}
