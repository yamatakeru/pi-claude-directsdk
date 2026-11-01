/** Typed errors for the Claude Native provider. */

export type ClaudeNativeErrorKind =
  | "missing"
  | "logged-out"
  | "env-conflict"
  | "replay"
  | "incomplete"
  | "native"
  | "upstream"
  | "billing"
  | "timeout"
  | "cancelled";

export class ClaudeNativeError extends Error {
  readonly kind: ClaudeNativeErrorKind;

  constructor(kind: ClaudeNativeErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaudeNativeError";
    this.kind = kind;
  }
}

export const INSTALL_HINT =
  "Claude Code is not installed (no `claude` on PATH). " +
  "Install it with `npm install -g @anthropic-ai/claude-code` " +
  "or set PI_CLAUDE_NATIVE_COMMAND to the executable path.";

export const LOGIN_HINT =
  "Claude Code is installed but not logged in. " +
  "Run `claude auth login`, then select this provider again.";

export const LOGGED_OUT_HINT =
  "Claude Code is installed but has no usable login in the environment Pi runs it in. " +
  "Run `claude auth login` as the user Pi runs as, " +
  "set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) in Pi's environment, " +
  "or point PI_CLAUDE_NATIVE_CONFIG_DIR at a logged-in config directory, then try again.";

export function missingError(): ClaudeNativeError {
  return new ClaudeNativeError("missing", INSTALL_HINT);
}

export function loggedOutError(detail?: string): ClaudeNativeError {
  const suffix = detail ? ` (native: ${detail})` : "";
  return new ClaudeNativeError("logged-out", `${LOGGED_OUT_HINT}${suffix}`);
}

export function envConflictError(names: string[]): ClaudeNativeError {
  return new ClaudeNativeError(
    "env-conflict",
    "Subscription mode refuses conflicting native auth/backend overrides: " +
      names.join(", ") +
      ". Remove them from the launching environment. " +
      "Values are never printed.",
  );
}

export function replayError(detail: string): ClaudeNativeError {
  return new ClaudeNativeError("replay", `Pi history is not replayable: ${detail}`);
}

export function incompleteError(detail: string): ClaudeNativeError {
  return new ClaudeNativeError("incomplete", `Incomplete native response: ${detail}`);
}

export function nativeError(detail: string): ClaudeNativeError {
  return new ClaudeNativeError("native", `Native request failed: ${detail}`);
}

export function upstreamError(detail: string): ClaudeNativeError {
  return new ClaudeNativeError("upstream", `Incomplete upstream response: ${detail}`);
}

export function timeoutError(detail: string): ClaudeNativeError {
  return new ClaudeNativeError("timeout", `Claude request timed out: ${detail}`);
}

export function cancelledError(): ClaudeNativeError {
  return new ClaudeNativeError("cancelled", "Claude request cancelled");
}

/** True when the error represents user/outer cancellation rather than a failure. */
export function isCancelled(error: unknown): boolean {
  return (
    (error instanceof ClaudeNativeError && error.kind === "cancelled") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
