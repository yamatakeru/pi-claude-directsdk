# Pi Claude DirectSDK — experimental fork

[![CI](https://github.com/yamatakeru/pi-claude-directsdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yamatakeru/pi-claude-directsdk/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/github/license/yamatakeru/pi-claude-directsdk)](LICENSE)

This is an unofficial fork of [joaomj/pi-claude-directsdk](https://github.com/joaomj/pi-claude-directsdk), used to verify fixes and try them in everyday Pi sessions before proposing them upstream. Fork changes are not necessarily accepted upstream. The npm package `pi-claude-directsdk` is the upstream distribution; it does not contain this fork's changes.

Use Claude inside Pi, the coding agent, through the unmodified Claude Code executable. Pi owns the transcript, tools, approvals, and retries. The CLI supplies subscription authentication as a model transport.

## Requirements

- Pi 1.3.0 is verified in this fork; other Pi versions are unverified.
- Node 20 or later for Node-based Pi installations and local development. Compiled Pi uses its bundled runtime.
- Claude Code `>=2.1.263 <2.2.0` (the inherited compatibility range in `src/models.ts`). This fork was verified with 2.1.303, not every version in the range.
- A Claude paid plan. The free plan excludes the CLI.
- A Claude Code login via `claude auth login`.

## Install

Install the verified Claude Code version. The flag allows its executable setup scripts for this command only:

```sh
npm install -g --ignore-scripts=false @anthropic-ai/claude-code@2.1.303
```

Sign in through the official CLI login:

```sh
claude auth login
```

Install this fork from Git:

```sh
pi install git:github.com/yamatakeru/pi-claude-directsdk
```

This unpinned source installs the latest `main`, including changes without a release tag. To pin the code used in the post-#13 interactive verification below instead of following future changes, use `pi install git:github.com/yamatakeru/pi-claude-directsdk@1fa1c48` in place of the command above.

If upstream is already installed, first remove its declaration with `pi remove npm:pi-claude-directsdk` (or its Git source), or disable its extension loading. Only one DirectSDK extension should be active. `pi list` shows installed declarations.

Start or restart interactive Pi, open `/model`, and wait for the DirectSDK catalog refresh. Select a DirectSDK model. On a fresh install, this step must complete before selecting the model from the command line.

`pi update --models` does not load this extension in Pi 1.3.0; use the interactive model picker for DirectSDK refresh. After a successful refresh, later invocations can use the saved catalog:

```sh
pi --model claude-directsdk/claude-haiku-5-5
```

DirectSDK uses the CLI login, not the Pi Anthropic login.

The catalog does not guarantee account entitlement. Requests consume subscription allowance; some models require additional usage credits. To stay within the included allowance, disable additional paid usage in your Claude account.

## Upgrade

Update the fork explicitly:

```sh
pi update git:github.com/yamatakeru/pi-claude-directsdk
```

In Pi 1.3.0, bare `pi update` updates Pi itself, not its packages. An unpinned Git source tracks the repository's default branch; version-pinned sources remain pinned. To change a pin or switch back to upstream, remove the old declaration with `pi remove <old-source>`, then install the desired source. Keep only one DirectSDK extension active.

Restart Pi after upgrading, then open `/model` and wait for catalog refresh.

## Fork changes

Relative to upstream baseline `e8c9108`, these additions are merged into the fork. The first three are enabled by default; the fourth is opt-in:

- Replay-stable cache prefixes: remove recurring CLI-added context and restore trimmed tool results ([#1](https://github.com/yamatakeru/pi-claude-directsdk/issues/1), [#13](https://github.com/yamatakeru/pi-claude-directsdk/pull/13)).
- Pi's thinking level passed through native `--effort`, without an inherited effort override ([#2](https://github.com/yamatakeru/pi-claude-directsdk/issues/2)).
- Detailed relay failure diagnostics and termination when upstream drops mid-response ([#4](https://github.com/yamatakeru/pi-claude-directsdk/issues/4), [#7](https://github.com/yamatakeru/pi-claude-directsdk/issues/7)).
- Experimental mid-conversation prompt/tool changes, **off by default** ([#3](https://github.com/yamatakeru/pi-claude-directsdk/issues/3)).

### Enable mid-conversation prompt/tool changes

Start each Pi process with:

```sh
PI_DIRECTSDK_MID_CONVERSATION_SYSTEM=1 pi
```

Or export the variable in the environment used by your Pi launcher. Installing this fork alone does **not** enable this feature. It currently has no Pi settings-file switch; a persistent configuration path is being [considered](https://github.com/yamatakeru/pi-claude-directsdk/issues/14).

The relay keeps the initial prompt and tools stable and inserts later changes as system messages with deferred tool references. This is an explicit opt-in departure from forwarding the current prompt/tool list unchanged. `midConversation` in message diagnostics records whether the rewrite applied and any skip reason. See [architecture](docs/architecture.md#mid-conversation-system-messages-srcmid-conversationts) for the rewrite and fallbacks.

Limitations:

- Routes without mid-conversation system messages, such as Haiku 4.5, retain collapsed requests.
- A tool name redefined anywhere in the replayed transcript disables native tool changes for that history; the current full tool list is sent instead. Section updates can still apply.
- Thinking-level changes can still cause a cache miss ([#5](https://github.com/yamatakeru/pi-claude-directsdk/issues/5)). Long thinking/tool-loop misses remain under investigation ([#10](https://github.com/yamatakeru/pi-claude-directsdk/issues/10)).

### Fork verification

Live subscription checks used Pi 1.3.0 and Claude Code 2.1.303:

| Check | Opt-in | Result |
|---|---|---|
| Three-request Haiku 5.5 warm run | Not required | Requests 2 and 3 read 98.69% and 99.79% from cache |
| Haiku 5.5 section change and tool addition | Enabled | Cached prefix preserved; model called the added tool |
| Two fresh interactive sessions at `1fa1c48`, 31 requests total | Enabled | No restoration skips or rewrite fallbacks; next turn after 12 Haiku 5.5 / 10 Sonnet 5.5 tool calls read 99.4% / 99.0% from cache, respectively |

The last check used Herdr, a terminal multiplexer. It did not reproduce #10, but short-session checks do not rule it out or extend the permanent test harness. The [measurement report](docs/transport-measurements.md) details earlier checks and separately preserves upstream's v0.1.7 results.

Every call still sends history and starts a fresh Claude process. Cache reuse depends on inputs, lifetime, and upstream availability; these are not matched upstream/fork benchmarks. Cache-read share measures token reuse, not subscription allowance deductions or guaranteed savings.

Pi's per-model costs are estimates from [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), not subscription charges. Failed or interrupted requests are never reported as free.

## Comparison with pi-claude-bridge

Unlike [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge), DirectSDK starts a fresh CLI process for each call and keeps no mirrored Claude session. Pi owns the transcript; at most one upstream Messages request is admitted per call. By default, system messages collapse into the current prompt; the fork's opt-in rewrite places later changes inline instead.

There is no matched speed benchmark or implied Anthropic approval. See the [full comparison](docs/comparison.md) for trade-offs, evidence, and subscription-policy limits.

## Documentation

- [Usage and configuration](docs/usage.md): local checkout, environment settings, diagnostics, and verification.
- [Architecture](docs/architecture.md): request lifecycle diagram, model routing, tool transport, and admission relay.
- [Startup](docs/startup.md): catalog refresh, cache-only initialization, and lazy loading.
- [Troubleshooting](docs/troubleshooting.md): missing CLI, login, and conflicting environment settings.
- [Testing](docs/testing.md): supported verification commands and upstream environment baselines. Fork-specific paid checks are summarized [above](#fork-verification); temporary checks do not extend the permanent harness.
- [Transport measurements](docs/transport-measurements.md): timing baseline, warm-cache reuse, and measurement limits.
- [Full Bridge comparison](docs/comparison.md): transport, state, caching, authentication, and policy trade-offs.

## Issues and security

Report non-security fork-specific bugs and suggestions in [this fork's issues](https://github.com/yamatakeru/pi-claude-directsdk/issues).

Upstream accepts issues, not unsolicited PRs. Propose fixes through upstream issues with reproduction evidence and implementation links, distinguishing fork changes from upstream behaviour. [CONTRIBUTING.md](CONTRIBUTING.md) describes upstream's policy.

This fork has no configured private vulnerability-reporting channel. Do not disclose vulnerabilities or credentials in public issues. [SECURITY.md](SECURITY.md) documents upstream's private channel for upstream code only, not fork-only vulnerabilities.

## Acknowledgments

Based on [Pi Claude DirectSDK](https://github.com/joaomj/pi-claude-directsdk), Copyright (c) 2026 Joao Marcos, under the MIT license.

Behavioral reference and source of ported cache-stabilization logic: [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-official-plugins/tree/main/claude-subscription-directsdk), Copyright (c) 2026 Nous Research, under the [MIT license](https://github.com/NousResearch/hermes-official-plugins/blob/main/LICENSE). This fork also follows Pi's built-in Anthropic provider for the mid-conversation request shape.

## License

MIT. See `LICENSE`.
