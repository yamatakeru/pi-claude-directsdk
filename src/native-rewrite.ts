/**
 * The relay's payload hook: parse the admitted request once, apply the
 * replay-stable context (`native-context.ts`), and serialize once. The
 * original bytes are forwarded whenever nothing applied.
 */

import { stabilizeNativeRequest, type NativeContextReport } from "./native-context.js";
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

export function rewriteNativeRequest(
  raw: Buffer,
  queried: readonly NativeContentBlock[],
): NativeRewrite {
  const parsed = parse(raw);
  if (!parsed) {
    return { body: raw, nativeContext: { applied: [], skipped: ["body is not a Messages request"] } };
  }
  let nativeContext: NativeContextReport;
  try {
    nativeContext = stabilizeNativeRequest(parsed, queried);
  } catch {
    // A partial edit must not reach upstream: forward the CLI's body.
    return { body: raw, nativeContext: { applied: [], skipped: ["rewrite failed"] } };
  }
  return {
    body: nativeContext.applied.length > 0 ? Buffer.from(JSON.stringify(parsed), "utf-8") : raw,
    nativeContext,
  };
}
