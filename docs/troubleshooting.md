# Troubleshooting

## Error kinds

`ClaudeNativeError` in `src/errors.ts` carries a `kind` for model-call failures. Catalog refresh reports ordinary errors.

| Symptom | Kind or source | Action |
|---|---|---|
| No `claude` on `PATH` | `missing` | Install with `npm install -g @anthropic-ai/claude-code` or set `PI_CLAUDE_NATIVE_COMMAND` to the executable path. |
| CLI installed but not logged in | `logged-out` | Run `claude auth login` as the user Pi runs as, set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the environment Pi runs in, or point `PI_CLAUDE_NATIVE_CONFIG_DIR` at a logged-in config directory. Then select the provider again. The message names the `claude` executable and config directory Pi used, which can differ from your shell's. |
| Backend overrides | `env-conflict` | Remove the named variables from the launching environment. Values are never printed. |
| A turn used usage credits | `billing` | The turn may already be charged. Later turns stop unless `PI_CLAUDE_NATIVE_ALLOW_USAGE_CREDITS=1` is set. Disable usage credits in the Claude account settings to stay on plan limits. |
| Catalog refresh fails | catalog | Read the warning for the source or CLI failure. Open `/model` in interactive Pi and wait for refresh. No pinned fallback is used. |
| Model excluded from catalog | metadata | Read the warning for the missing field. Update Claude Code if picker metadata is incomplete. Unverified limits and prices are never guessed. |
| Optional features left off | metadata | Anthropic's mid-conversation page could not be read or no longer names its models. Models stay usable, but a tool change misses the prompt cache. Check the page; if its wording changed, `toolChangeModels` in `src/web-catalog.ts` needs the new sentence. |
| Older models or the `fable` alias are missing from `/model` | catalog | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DISABLE_TELEMETRY` in the environment Pi runs in makes Claude Code answer its generic picker. Unset them for the account's own picker, or keep them to stay with the generic list. A backend override also gives the generic list. |
| No Claude Native models on a fresh offline install | catalog | Connect once, start interactive Pi, and open `/model`. Wait for refresh before selecting a model from the command line. |
| History cannot be replayed | `replay` | Compact or restart the session. Causes: assistant prefill (a history ending in an assistant turn without tool calls), a tool call with an empty ID, or an unsupported content block. |
| Prompt is too long | `native` | Read the reported route and context window. Remove stale `contextWindow` overrides in `models.json` to use verified limits, or compact the session. |
| The model refused to complete the request | stop reason | The message shows Anthropic's explanation, or the model's text if there is none, plus the refusal category and request id when sent. Include the request id in a false-positive report. |
| Native request failed | `native` | Read the native detail in the message. |
| `<model> spent its whole output budget on thinking and returned no answer` | `native` | The turn spent its whole output budget on thinking. Lower the thinking level or switch models, then retry. |
| `<model> ran out of output tokens while writing the arguments of <tool>` | `native` | The output budget ended inside a tool call, with no text before it. The call was not run. Ask for smaller steps, such as a shorter file per write, or lower the thinking level, then retry. When text came before the call, the turn ends as truncated with that text instead. |
| Upstream response incomplete | `upstream` | Read `upstream said:` for Anthropic's reason. A status 429 at a usage limit means waiting for the reset; otherwise retry the request. The reason is shown even when Claude Code ends without a result line. |
| Request timed out | `timeout` | Retry the request. The default timeout is 180 seconds. |
| Request cancelled | `cancelled` | Re-run the request. Cancel kills the full child process tree. |

Missing CLI and logged-out CLI fail before any upstream contact. The messages are actionable and safe to show.

## High token usage

The provider sends history on each call. A cache hit reuses a stable prefix; it does not eliminate history transmission.

Check cache-read share in message diagnostics across a stable, sufficiently long conversation. Short conversations, changed prompts or tools, cache expiry, and upstream eviction can prevent reuse. Token counters do not establish subscription allowance deductions. See [transport-measurements.md](transport-measurements.md) for the recorded evidence and its limits.

## Environment reference

| Variable | Set by | Purpose |
|---|---|---|
| `PI_CLAUDE_NATIVE_COMMAND` | User | Override the `claude` executable path or argv head. Used by `resolveClaude`. |
| `PI_CLAUDE_NATIVE_CONFIG_DIR` | User | Logged-in config directory. Mapped to `CLAUDE_CONFIG_DIR` for children and setup probes. Never forwarded under its own name. |
| `CLAUDE_CODE_OAUTH_TOKEN` | User | Token from `claude setup-token` for environments without an interactive login. |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Provider | The model's `maxTokens`, or Pi's per-call override. Claude Code replaces the request's `max_tokens` with its own default of 32,000 for models missing from its table, so the model limit reaches the child through this variable. |
| `PI_CLAUDE_NATIVE_ALLOW_USAGE_CREDITS` | User | Set to `1` to allow turns that Claude Code reports as charged to usage credits. Any other value, or none, stops later turns after overage. |
| `PI_CLAUDE_NATIVE_ENTRYPOINT` | User | Client label for `cc_entrypoint`, which plan usage is metered by. Defaults to `pi-claude-native` and replaces an inherited label. An empty value lets Claude Code label the session. Must be 1 to 64 characters of letters, digits, dot, underscore, or hyphen. |
| `PI_CLAUDE_NATIVE_TEST_UPSTREAM` | Development only | Bypass the subscription environment guard for an explicit custom endpoint. Never set it in normal subscription use. |

## Subscription guard

Subscription mode refuses backend overrides in the merged environment: `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY`. The error names the variables without printing values. API credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_FOUNDRY_API_KEY`) are not refused; they are left out of the environment of every Claude Code process, so it signs in with the subscription login. The development override `PI_CLAUDE_NATIVE_TEST_UPSTREAM=1` bypasses this guard. The installed-Pi harness does not set it.

## Usage credits

Claude Code can report that a response used pay-as-you-go usage credits instead of plan limits. Claude Native stops the turn with a `billing` error unless `PI_CLAUDE_NATIVE_ALLOW_USAGE_CREDITS=1` is set. The error names the reported status and reset time. The guard runs after the response and usage are captured, so it cannot undo the charge for that turn.

Upstream rejections that mention third-party usage, extra usage, or usage credits produce the same error. Pi's retry classifier treats messages containing `billing` as non-retryable. To stay on plan limits only, disable usage credits in the Claude account settings and leave the override unset. Do not set the override just to silence the error.

When a rejection names third-party apps, the error also suggests trying `PI_CLAUDE_NATIVE_ENTRYPOINT` set to an empty string if plan limit remains, so Claude Code labels the request itself. Anthropic meters that label faster ([Plan usage metering](usage.md#plan-usage-metering)).

Completed and failed turns carry a `pi-claude-native/rate-limit` diagnostic when the native child reported rate-limit status.

## Version mismatch

The qualified CLI range is `>=2.1.263 <2.2.0` (`QUALIFIED_CLI_RANGE` in `src/models.ts`). The detected version is recorded per call. Behavior failures outside the range fail at runtime. Install the qualified version from [README](../README.md#install), then run the installed-Pi verification scenarios from [testing.md](testing.md).

## Session recovery

Switching providers does not require compaction or a restart. Thinking without a matching native carrier is replayed as ordinary assistant text. This also applies after editing an assistant message that carried signed thinking.

Replay accepts every history pi-ai's Anthropic provider can send ([ADR 0001](adr/0001-replay-input-contract.md)), and lists each adjustment in the meta diagnostic (`replayAdjustments`). For a history it still rejects, such as one ending in an assistant turn without tool calls, compact or restart the session. Do not hand-edit session files to reattach native blocks. A stale signature is never attached to rewritten content by design.

## Tool changes

Models whose built-in metadata supports mid-conversation tool changes replay `tool_addition` and `tool_removal` blocks at assistant boundaries. A tool used earlier in the conversation can be removed from the active tools without failing replay. Pi still validates the model response against the active tools, so a removed tool is never executed.

Unsupported models keep the collapsed system message and current tool set, so any tool change misses the whole prompt cache on the next request. For models Anthropic does not list for mid-conversation tool changes, this cannot be avoided ([#3](https://github.com/yamatakeru/pi-claude-native/issues/3)). When the catalog could not load or parse Anthropic's page, it reports a warning and supported models fall back the same way; open `/model` in interactive Pi and wait for the catalog refresh to restore the capability. On those models, an earlier call to a tool that is no longer in the current set is replayed as text with its result instead of failing replay.

## Cross-provider history

The provider replays foreign thinking as ordinary text and maps incompatible tool-call IDs together with their result references. A tool call the request does not declare, in a turn that does not match a native carrier (for example another provider's call in a side request that sends the history with no tools), is replayed as text with its result. Assistant turns with nothing left to send, from failed or aborted responses or from edits, are omitted. A tool call left without a result gets the result `No result provided`. The stored session remains unchanged.
