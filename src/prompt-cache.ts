/** Prompt cache TTL shared by the child, the replay anchor and Pi; apart from request.ts so the provider entry stays light. */

import { isTruthy, type NativeCacheControl } from "./types.js";

/** Keep replay anchors and CLI-generated breakpoints on the same TTL. */
export function promptCacheTtl(env: NodeJS.ProcessEnv): "5m" | "1h" {
  if (isTruthy(env["FORCE_PROMPT_CACHING_5M"])) return "5m";
  const ttl = env["CLAUDE_CODE_PROMPT_CACHE_TTL"] ?? "1h";
  if (ttl !== "5m" && ttl !== "1h") {
    throw new Error("CLAUDE_CODE_PROMPT_CACHE_TTL must be 5m or 1h; unset it to use 1h");
  }
  return ttl;
}

/** Cache metadata only; Pi still owns every message and instruction. */
export function replayCacheControl(
  env: NodeJS.ProcessEnv,
  nativeModelId: string,
): NativeCacheControl | undefined {
  const ttl = promptCacheTtl(env);
  const family = ["haiku", "sonnet", "opus", "fable", "mythos"].find(
    (name) => nativeModelId.toLowerCase().includes(name),
  );
  if (
    isTruthy(env["DISABLE_PROMPT_CACHING"]) ||
    (family && isTruthy(env[`DISABLE_PROMPT_CACHING_${family.toUpperCase()}`]))
  ) {
    return undefined;
  }
  return { type: "ephemeral", ttl };
}

/** Lifetime for both of Pi's tiers (the child ignores `cacheRetention`); undefined when caching is off or the TTL is invalid. */
export function declaredPromptCache(
  env: NodeJS.ProcessEnv,
  nativeModelId: string,
): { short: number; long: number } | undefined {
  let control: NativeCacheControl | undefined;
  try {
    control = replayCacheControl(env, nativeModelId);
  } catch {
    return undefined;
  }
  if (!control) return undefined;
  const seconds = control.ttl === "1h" ? 3600 : 300;
  return { short: seconds, long: seconds };
}
