# Pi Claude DirectSDK — experimental fork

[![CI](https://github.com/yamatakeru/pi-claude-directsdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yamatakeru/pi-claude-directsdk/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/github/license/yamatakeru/pi-claude-directsdk)](LICENSE)

Use Claude inside Pi, the coding agent, through the unmodified Claude Code executable. Pi owns the transcript, tools, approvals, and retries. The CLI supplies subscription authentication as a model transport.

This is an unofficial fork of [joaomj/pi-claude-directsdk](https://github.com/joaomj/pi-claude-directsdk). It is where fixes are tried in everyday use before being reported upstream; see [Fork changes](#fork-changes). The npm package `pi-claude-directsdk` is upstream's and does not include them.

## Requirements

- Pi. This fork is verified with Pi 1.3.0.
- Node 20 or later for Node-based Pi installations and local development. Compiled Pi uses its bundled runtime.
- Claude Code `>=2.1.263 <2.2.0` (`QUALIFIED_CLI_RANGE` in `src/models.ts`). This fork is verified with 2.1.303.
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

This follows `main`. To stay on the last interactively verified commit instead, install `git:github.com/yamatakeru/pi-claude-directsdk@1fa1c48`.

Keep only one DirectSDK extension active. If upstream is installed, remove it first with `pi remove npm:pi-claude-directsdk` (or its Git source); `pi list` shows what is installed.

Start or restart interactive Pi, open `/model`, and wait for the DirectSDK catalog refresh. Select a DirectSDK model. On a fresh install, this step must complete before selecting the model from the command line.

`pi update --models` does not load this extension in Pi 1.3.0; use the interactive model picker for DirectSDK refresh. After a successful refresh, later invocations can use the saved catalog:

```sh
pi --model claude-directsdk/claude-haiku-5-5
```

DirectSDK uses the CLI login, not the Pi Anthropic login.

The catalog lists models, not what your plan includes. Start with Haiku for a small first request. Requests draw on your subscription allowance, and some models need additional usage credits; to avoid extra charges, disable additional paid usage in your Claude account.

## Upgrade

Update the fork explicitly:

```sh
pi update git:github.com/yamatakeru/pi-claude-directsdk
```

In Pi 1.3.0, a bare `pi update` updates Pi itself, not its packages. Pinned sources stay pinned; to change a pin or switch back to upstream, `pi remove` the old source and install the new one.

Restart Pi after upgrading, then open `/model` and wait for catalog refresh.

## Fork changes

Relative to upstream baseline `e8c9108`:

- **Cache reuse across calls** (default). Every call replays history through a fresh CLI process, and the CLI adds per-request context (a session reminder, the date line) that never recurs. The relay moves or drops that context, so each request's cached prefix is read by the next one ([#1](https://github.com/yamatakeru/pi-claude-directsdk/issues/1), [#13](https://github.com/yamatakeru/pi-claude-directsdk/pull/13)).
- **Thinking level honoured** (default). Pi's thinking level reaches the CLI as `--effort`; an inherited `CLAUDE_CODE_EFFORT_LEVEL` no longer overrides it ([#2](https://github.com/yamatakeru/pi-claude-directsdk/issues/2)).
- **Clearer relay failures** (default). Connection errors report codes, addresses and the failing phase instead of a bare `AggregateError`, and a connection dropped mid-response ends the call instead of hanging it ([#4](https://github.com/yamatakeru/pi-claude-directsdk/issues/4), [#7](https://github.com/yamatakeru/pi-claude-directsdk/issues/7)).
- **Prompt and tool changes without a full cache miss** (experimental, opt-in). See below ([#3](https://github.com/yamatakeru/pi-claude-directsdk/issues/3)).

### Enabling prompt and tool changes mid-conversation

By default, when Pi's system prompt or tool list changes during a session, the next request starts with the new prompt and tools, so nothing cached can be reused. With the opt-in, the relay keeps the session's first prompt and tools in place and sends later changes as system messages inside the conversation, the way Pi's own Anthropic provider does.

Start Pi with the variable set, or export it in your launcher's environment:

```sh
PI_DIRECTSDK_MID_CONVERSATION_SYSTEM=1 pi
```

Installing the fork does not enable it, and there is no settings-file switch yet ([#14](https://github.com/yamatakeru/pi-claude-directsdk/issues/14)). When the relay cannot apply the rewrite, it forwards the request in the default form and records why in the `midConversation` diagnostic. Some models, such as Haiku 4.5, always use the default form. Details are in [architecture](docs/architecture.md#mid-conversation-system-messages-srcmid-conversationts).

### Known issues

- Changing the thinking level mid-session still causes a near-full cache miss ([#5](https://github.com/yamatakeru/pi-claude-directsdk/issues/5)).
- After a long tool loop with thinking, the next user turn may miss part of the cache; under investigation ([#10](https://github.com/yamatakeru/pi-claude-directsdk/issues/10)).

### Verification

With Pi 1.3.0, Claude Code 2.1.303 and Haiku 5.5, the second and third requests of a warm run read 98.69% and 99.79% of their input from cache. With the opt-in enabled, a prompt change and an added tool kept the cached prefix, and the model called the new tool. Interactive sessions with Haiku 5.5 and Sonnet 5.5 stayed near 99% after tool loops. The measurement report has the full numbers and limits for the [warm run](docs/transport-measurements.md#replay-stable-native-context), the [opt-in](docs/transport-measurements.md#mid-conversation-system-messages-experimental) and the [interactive sessions](docs/transport-measurements.md#interactive-sessions-after-the-trimmed-result-fix).

Cache-read share measures token reuse, not subscription allowance. Pi's per-model costs are estimates from [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), not subscription charges, and failed or interrupted requests are never reported as free.

## Comparison with pi-claude-bridge

[pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) also exposes Claude as a Pi provider and lets Pi execute tools.

- **DirectSDK:** Pi's current transcript and prompt determine each request. A fresh CLI process admits at most one upstream Messages request, with no mirrored Claude session. The trade-off is repeated process startup and history replay, plus custom transport maintenance.
- **Bridge:** Uses the official Agent SDK, continues queries across Pi tool boundaries, and offers optional Claude-agent delegation. The trade-off is mirrored-session recovery and a Claude Code instruction environment rather than direct forwarding of Pi's full system prompt.

No matched benchmark compares their speed, and using the official CLI or SDK does not imply Anthropic approval of either. See the [full comparison](docs/comparison.md).

## Documentation

- [Usage and configuration](docs/usage.md): local checkout, environment settings, diagnostics, and verification.
- [Architecture](docs/architecture.md): request lifecycle diagram, model routing, tool transport, and admission relay.
- [Startup](docs/startup.md): catalog refresh, cache-only initialization, and lazy loading.
- [Troubleshooting](docs/troubleshooting.md): missing CLI, login, and conflicting environment settings.
- [Testing](docs/testing.md): verification commands and upstream's verified environments. Fork checks are summarized under [Verification](#verification).
- [Transport measurements](docs/transport-measurements.md): timing baseline, warm-cache reuse, and measurement limits.
- [Full Bridge comparison](docs/comparison.md): transport, state, caching, authentication, and policy trade-offs.

## Issues and security

Report fork-specific bugs and suggestions in [this fork's issues](https://github.com/yamatakeru/pi-claude-directsdk/issues). Upstream takes issues but not unsolicited pull requests ([CONTRIBUTING.md](CONTRIBUTING.md)), so fixes found here are proposed there as issues with reproduction evidence.

This fork has no private vulnerability-reporting channel; please do not post vulnerabilities or credentials in public issues. [SECURITY.md](SECURITY.md) describes upstream's channel, which covers upstream code only.

## Acknowledgments

Based on [Pi Claude DirectSDK](https://github.com/joaomj/pi-claude-directsdk), Copyright (c) 2026 Joao Marcos, under the MIT license.

Behavioral reference and source of ported cache-stabilization logic: [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-official-plugins/tree/main/claude-subscription-directsdk), Copyright (c) 2026 Nous Research, under the [MIT license](https://github.com/NousResearch/hermes-official-plugins/blob/main/LICENSE). This fork also follows Pi's built-in Anthropic provider for the mid-conversation request shape.

## License

MIT. See `LICENSE`.
