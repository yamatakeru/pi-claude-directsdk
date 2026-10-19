# Usage and configuration

## Run from a local checkout

Start Pi with the local extension without installing it:

```sh
pi -e ./extensions/claude-directsdk/index.ts
```

Open `/model` and wait for catalog refresh. Then select a DirectSDK model. Later invocations can use the verified snapshot:

```sh
pi -e ./extensions/claude-directsdk/index.ts --list-models claude-directsdk
pi -e ./extensions/claude-directsdk/index.ts -p --model claude-directsdk/sonnet -- "Hello."
```

Startup performs no CLI probes or web requests. Pi restores only a previously verified catalog snapshot, labeled as such. A fresh offline install has no DirectSDK models. Interactive Pi refreshes catalogs in the background after the editor is ready.

Refresh uses Claude Code's account picker and Anthropic's public model, pricing, and effort documentation. Models absent from the account picker are labeled `not in CLI picker`; their account entitlement is unverified. Missing required metadata excludes the affected model with a warning. A failed refresh reports the error and removes the snapshot. There is no pinned fallback.

The request transport still loads on the first Claude request. See [docs/startup.md](startup.md) for behavior and limits.

## Configuration

| Setting | Purpose |
|---|---|
| `CLAUDE_DIRECTSDK_COMMAND` | Override the `claude` executable path. |
| `CLAUDE_DIRECTSDK_CONFIG_DIR` | Point at a logged-in CLI config directory. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Supply a token from `claude setup-token` in the environment Pi runs in. |
| `PI_DIRECTSDK_MID_CONVERSATION_SYSTEM` | Experimental. Set to `1` to send later prompt and tool changes as mid-conversation system messages instead of rewriting the leading prompt. See [architecture.md](architecture.md#mid-conversation-system-messages-srcmid-conversationts). |
| `PI_DIRECTSDK_PROMPT_HASHES` | Set to `1` to add SHA-256 hashes of the provider-supplied system prompt and tool definitions to message diagnostics. Unset it or set it to `0` to disable hashes. |

Success and failure diagnostics include request-phase timings, replay counts, upstream request-body bytes, and cache-read share. Unobserved milestones and unavailable cache-read shares are `null`. Milestone times are elapsed milliseconds from call start; durations are separate intervals and are not additive. The spawn-to-replay interval includes CLI startup, and first response data is not necessarily the first generated token.

Cache-read share measures token reuse, not subscription allowance deductions. Prefix hashes cover the Pi-supplied system prompt and tool definitions; they do not detect system-prompt changes added by Claude Code. Diagnostics store hashes, not the prompt or tool definitions.

See [docs/troubleshooting.md](troubleshooting.md) for login and environment errors.

## Verification

```sh
npm test
```

This runs offline startup verification through your installed Pi and consumes no subscription allowance. Real model requests and complete-session replay require explicit approval. See [docs/testing.md](testing.md).

