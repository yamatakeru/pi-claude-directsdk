/**
 * The relay's single payload hook: parse the admitted request once, apply the
 * replay-stable context (`native-context.ts`) and, when planned, the
 * mid-conversation rewrite (`mid-conversation.ts`), then serialize once.
 * The original bytes are forwarded whenever nothing applied.
 */

import {
  applyMidConversation,
  skippedReport,
  type MidConversationPlan,
  type MidConversationReport,
  type MidConversationSkip,
} from "./mid-conversation.js";
import { stabilizeNativeRequest, type NativeContextReport } from "./native-context.js";
import type { NativeContentBlock } from "./types.js";
import { isRecord } from "./types.js";

export interface NativeRewrite {
  body: Buffer;
  nativeContext: NativeContextReport;
  /** Null when the opt-in is off. */
  midConversation: MidConversationReport | null;
}

function parse(raw: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf-8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function rewriteNativeRequest(
  raw: Buffer,
  queried: readonly NativeContentBlock[],
  midPlan: MidConversationPlan | MidConversationSkip | null,
): NativeRewrite {
  let parsed = parse(raw);
  if (!parsed) {
    return {
      body: raw,
      nativeContext: { applied: [], skipped: ["body is not a Messages request"] },
      midConversation:
        midPlan === null
          ? null
          : skippedReport(typeof midPlan === "string" ? midPlan : "body is not a Messages request"),
    };
  }

  let nativeContext: NativeContextReport;
  try {
    nativeContext = stabilizeNativeRequest(parsed, queried);
  } catch {
    // A partial edit must not reach upstream: start again from the CLI's body.
    parsed = parse(raw)!;
    nativeContext = { applied: [], skipped: ["rewrite failed"] };
  }

  let midConversation: MidConversationReport | null = null;
  if (typeof midPlan === "string") {
    midConversation = skippedReport(midPlan);
  } else if (midPlan) {
    try {
      midConversation = applyMidConversation(parsed, midPlan);
    } catch {
      // Every check runs before the first edit, so a throw leaves the body intact.
      midConversation = skippedReport("rewrite failed");
    }
  }

  const changed = nativeContext.applied.length > 0 || midConversation?.applied === true;
  return {
    body: changed ? Buffer.from(JSON.stringify(parsed), "utf-8") : raw,
    nativeContext,
    midConversation,
  };
}
