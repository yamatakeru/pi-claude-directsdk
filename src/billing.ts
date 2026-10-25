/**
 * Usage-credit guard.
 *
 * Claude Code reports when a turn was charged to pay-as-you-go usage credits
 * through `rate_limit_event.rate_limit_info.isUsingOverage`. The guard stops
 * later turns unless the user explicitly opts in. It cannot undo the turn that
 * was already charged.
 */

import type { AssistantMessageDiagnostic, JsonObject } from "@earendil-works/pi-ai/compat";
import { DirectSdkError } from "./errors.js";

export const ALLOW_USAGE_CREDITS_ENV = "CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS";
export const RATE_LIMIT_DIAGNOSTIC = "pi-claude-directsdk/rate-limit";

/** The subset of native `rate_limit_info` this transport reads and reports. */
export interface RateLimitInfo {
  status?: string;
  rateLimitType?: string;
  resetsAt?: number;
  isUsingOverage?: boolean;
  overageStatus?: string;
  overageDisabledReason?: string;
  [key: string]: unknown;
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && !["", "0", "false", "no", "off"].includes(value.toLowerCase());
}

export function usageCreditsAllowed(env: NodeJS.ProcessEnv): boolean {
  return isTruthy(env[ALLOW_USAGE_CREDITS_ENV]);
}

/**
 * Anthropic rejects or reroutes requests it classifies as third-party app
 * usage with these messages. Every generated message contains "billing" so
 * Pi's retry classifier treats it as a non-retryable account error.
 */
const USAGE_CREDITS_REJECTION =
  /third-party apps now draw from your extra usage|out of extra usage|draws? from your usage credits/iu;

export function usageCreditsChargeError(info: RateLimitInfo): DirectSdkError {
  const status = info.status ?? "unknown";
  const type = info.rateLimitType ? `, ${info.rateLimitType}` : "";
  const reset = typeof info.resetsAt === "number"
    ? ` Resets at ${new Date(info.resetsAt * 1000).toISOString()}.`
    : "";
  return new DirectSdkError(
    "billing",
    "Claude Code billing: this request was charged to Claude usage credits instead of your plan limits " +
      `(rate limit status ${status}${type}).${reset} Pi stopped so further requests are not charged. ` +
      "To stay on plan limits only, turn off usage credits at claude.ai/settings/usage. " +
      `To allow usage credits, set ${ALLOW_USAGE_CREDITS_ENV}=1.`,
  );
}

/** Rewrite an Anthropic usage-credit rejection into the same actionable error. */
export function usageCreditsRejectionError(message: string): DirectSdkError | undefined {
  if (!USAGE_CREDITS_REJECTION.test(message)) {
    return undefined;
  }
  return new DirectSdkError(
    "billing",
    "Claude Code billing: Anthropic did not accept this request on your Claude plan limits and wants to charge " +
      "it to usage credits. This happens when your plan limit is used up, or when Anthropic classifies the " +
      "request as third-party app usage. Pi will not retry it. Original error: " +
      message,
  );
}

/** Fail a turn when Claude Code reported overage and the user did not opt in. */
export function enforceUsageCredits(
  info: RateLimitInfo | undefined,
  env: NodeJS.ProcessEnv,
): void {
  if (info?.isUsingOverage === true && !usageCreditsAllowed(env)) {
    throw usageCreditsChargeError(info);
  }
}

/** Durable diagnostic for completed and failed turns. */
export function rateLimitDiagnostic(info: RateLimitInfo): AssistantMessageDiagnostic {
  const details = JSON.parse(JSON.stringify(info)) as JsonObject;
  return {
    type: RATE_LIMIT_DIAGNOSTIC,
    timestamp: Date.now(),
    details,
  };
}
