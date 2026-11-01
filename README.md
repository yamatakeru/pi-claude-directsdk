# Pi Claude Native

[![CI](https://github.com/yamatakeru/pi-claude-native/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yamatakeru/pi-claude-native/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/github/license/yamatakeru/pi-claude-native)](LICENSE)

Use Claude inside Pi through the unmodified Claude Code executable. Pi owns the transcript, system prompt, tools, approvals, and retries; the CLI supplies subscription authentication as a model transport.

Each request starts a fresh `claude -p` process that replays Pi's history in Claude Code's native `stream-json` form, signed thinking included, with an explicit cache anchor. A local relay admits one upstream request per Pi model call, and every tool call returns to Pi for execution. Three measurements recorded 99.6% to 99.8% cache-read share on warm turns; see [transport measurements](docs/transport-measurements.md) for the workloads and their limits.

This is a Pi port of [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-official-plugins/tree/main/claude-subscription-directsdk), continued from [joaomj/pi-claude-directsdk](https://github.com/joaomj/pi-claude-directsdk) v0.3.1. That project moved to the official Claude Agent SDK in v1.0.0; this one keeps the direct transport. See [History](#history).

## Requirements

- Pi. Verified with Pi 1.4.0.
- Node 20 or later for Node-based Pi installations and local development. Compiled Pi uses its bundled runtime.
- Claude Code in the qualified range `>=2.1.263 <2.2.0` (see `QUALIFIED_CLI_RANGE` in `src/models.ts`). Verified with 2.1.312.
- A Claude paid plan. The free plan excludes the CLI.
- A Claude Code login via `claude auth login`.

## Install

Install the verified Claude Code version, then sign in through the official CLI:

```sh
npm install -g --ignore-scripts=false @anthropic-ai/claude-code@2.1.312
claude auth login
```

Install from Git. It follows `main`:

```sh
pi install git:github.com/yamatakeru/pi-claude-native
```

Start or restart interactive Pi, open `/model`, and wait for the catalog refresh. On a fresh install, this step must complete before selecting the model from the command line; later invocations can use the saved catalog, for example `pi --model claude-native/haiku`. `pi update --models` does not refresh this catalog.

The extension uses the CLI login, not the Pi Anthropic login. The `npm install` flag enables the Claude Code installer for that command only.

The model catalog does not guarantee account entitlement. Start with `haiku` for a small request. Models that require usage credits can incur separate charges, and the extension cannot undo a charge that Claude Code already reported. See [usage credits](docs/usage.md#usage-credit-guard).

## Upgrade

```sh
pi update git:github.com/yamatakeru/pi-claude-native
```

A bare `pi update` updates Pi itself, not its packages; `pi update --extensions` updates every installed package. Restart Pi afterwards, then open `/model` and wait for catalog refresh.

### Moving from pi-claude-directsdk

Remove the old package first (`pi remove npm:pi-claude-directsdk`, or `pi remove git:github.com/yamatakeru/pi-claude-directsdk`), then install this one; `pi list` shows what is installed. The provider id is now `claude-native`, so select the model again in `/model` when resuming an older session. Signed thinking saved by the old extension still replays for now; that compatibility will be removed in a later version. Rename `CLAUDE_DIRECTSDK_*` settings to `PI_CLAUDE_NATIVE_*`; the old names are not read.

## Changes since pi-claude-directsdk v0.3.1

- **Cache reuse across calls**. Every call replays history through a fresh CLI process, and the CLI adds per-request context (a session reminder, the date line) that never recurs. The relay moves or drops that context, so each request's cached prefix is read by the next one ([#1](https://github.com/yamatakeru/pi-claude-native/issues/1), [#13](https://github.com/yamatakeru/pi-claude-native/pull/13)).
- **Thinking level honoured**. Pi's thinking level reaches the CLI as `--effort`; an inherited `CLAUDE_CODE_EFFORT_LEVEL` no longer overrides it ([#2](https://github.com/yamatakeru/pi-claude-native/issues/2)).
- **Clearer relay failures**. Connection errors report codes, addresses and the failing phase instead of a bare `AggregateError`, and a connection dropped mid-response ends the call instead of hanging it ([#4](https://github.com/yamatakeru/pi-claude-native/issues/4), [#7](https://github.com/yamatakeru/pi-claude-native/issues/7)).
- **Inherited client label removed in any case**. On Windows, an inherited `CLAUDE_CODE_ENTRYPOINT` with different letter case is removed too, so it cannot shadow the label the extension sets, or survive an empty `PI_CLAUDE_NATIVE_ENTRYPOINT`.
- **Pi's docs guidance kept**. pi-claude-directsdk replaces Pi's `<docs>` section with a one-sentence pointer. This extension sends Pi's guidance as prose instead, with `docs/docs.json` as the index in place of the rejected topic-to-path list ([#30](https://github.com/yamatakeru/pi-claude-native/issues/30)).
- **Quoted rejection text is not a billing error**. A successful reply that mentions a usage-credit rejection phrase, such as `out of extra usage`, is returned as the reply instead of failing as a billing error ([#20](https://github.com/yamatakeru/pi-claude-native/issues/20)).
- **Tool changes on the right assistant boundary**. Mid-conversation tool changes skip carried assistant frames that the CLI drops, and a request whose assistant messages differ from the replay fails before reaching upstream instead of placing tool changes at the wrong point ([#13](https://github.com/yamatakeru/pi-claude-native/pull/13), [#18](https://github.com/yamatakeru/pi-claude-native/issues/18)).
- **Renamed**. Package `pi-claude-native`, provider id `claude-native`, settings `PI_CLAUDE_NATIVE_*`, default client label `pi-claude-native`.

### Known issues

- Plan billing depends on two undocumented Anthropic checks: the custom client label must stay out of the SDK bucket, and the replacement `<docs>` section must not look like Pi's prompt ([#23](https://github.com/yamatakeru/pi-claude-native/issues/23), joaomj/pi-claude-directsdk [#27](https://github.com/joaomj/pi-claude-directsdk/issues/27)). If rejections return, the extension can go back to the `sdk-cli` label; if [anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074) is fixed, the label and the prompt change can both go.
- A session that did not start on a Claude Native model is rejected when continued on one; start a new session or set `PI_CLAUDE_NATIVE_ENTRYPOINT=` for it ([#28](https://github.com/yamatakeru/pi-claude-native/issues/28)).
- Changing the thinking level mid-session still causes a near-full cache miss ([#5](https://github.com/yamatakeru/pi-claude-native/issues/5)).
- After a long tool loop with thinking, the next user turn may miss part of the cache; under investigation ([#10](https://github.com/yamatakeru/pi-claude-native/issues/10)).
- A tool change still causes a full cache miss on models that Anthropic's documentation does not list for mid-conversation tool changes, such as Haiku 4.5 and Sonnet 5, and on any model when a tool is redefined under the same name ([#3](https://github.com/yamatakeru/pi-claude-native/issues/3)).

### Verification

After the pi-claude-directsdk v0.3.1 merge, with Pi 1.4.0, Claude Code 2.1.312, Haiku 5.5 and the custom client label, the second and third requests of a warm run read 98.64% and 99.87% of their input from cache, as after v0.3.0 with the `sdk-cli` label (98.76% and 99.85% after v0.2.0 with Claude Code 2.1.310). Earlier checks, before the merge and with Pi 1.3.0 and Claude Code 2.1.303, found the same level in interactive sessions with Haiku 5.5 and Sonnet 5.5 after tool loops, and showed that a prompt change and an added tool kept the cached prefix under a former tool-change rewrite. The measurement report has the full numbers and limits for the [warm run](docs/transport-measurements.md#replay-stable-native-context), the [earlier tool-change rewrite](docs/transport-measurements.md#mid-conversation-system-messages-earlier-fork-rewrite) and the [interactive sessions](docs/transport-measurements.md#interactive-sessions-after-the-trimmed-result-fix).

## Comparison with other Claude providers

Three extensions expose the Claude subscription through Claude Code while Pi owns the session. This table reflects Claude Native `main`, [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) 0.9.3, and [pi-claude-code](https://github.com/earendil-works/pi-claude-code) 0.1.0 (experimental) as of October 23, 2026.

| | Claude Native | pi-claude-bridge | pi-claude-code |
|---|---|---|---|
| Extra charges | Stops after an overage charge unless opted in | No overage stop; 1M context Extra Usage is opt-in | Stops after an overage charge unless opted in |
| Tools | Pi executes; no delegation | Pi executes; optional AskClaude delegation, deprecated | Pi executes; no delegation |
| Conversation | Fresh CLI; full replay; tool changes on supported models | Live Agent SDK query with a mirrored Claude session | Fresh CLI; warm reuse for text-only turns |
| Latency and cache | 99.6–99.8% cache-read share on warm turns | Query continues across tool calls; rebuilds miss the cache | Warm text turns skip startup; tool loops replay |
| Models | CLI picker plus Anthropic docs, with verified prices | pi-ai Anthropic catalog, updated automatically | CLI discovery plus fallback metadata |

Claude Native requires Claude Code `>=2.1.263 <2.2.0`; pi-claude-bridge requires Pi `>=0.86.1`; pi-claude-code accepts the installed Claude Code version. All three use a Claude Code login, draw on the same subscription, and can be affected by Anthropic billing changes. None has a matched performance benchmark. See the [full comparison](docs/comparison.md) for source-level detail.

## Documentation

- [Usage and configuration](docs/usage.md): local checkout, environment settings, costs, diagnostics, and verification.
- [Architecture](docs/architecture.md): request lifecycle, model routing, tool transport, and admission relay.
- [Troubleshooting](docs/troubleshooting.md): missing CLI, login, version, and conflicting environment settings.
- [Testing](docs/testing.md), [startup](docs/startup.md), [transport measurements](docs/transport-measurements.md), and the [full Bridge comparison](docs/comparison.md). `docs/testing.md` lists the verified environments; recent checks are under [Verification](#verification).

## Issues and security

Report bugs and suggestions in [this repository's issues](https://github.com/yamatakeru/pi-claude-native/issues). See [CONTRIBUTING.md](CONTRIBUTING.md).

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md); please do not post vulnerabilities or credentials in public issues.

## History

This extension started as a fork of [joaomj/pi-claude-directsdk](https://github.com/joaomj/pi-claude-directsdk), where fixes were tried in everyday use and reported upstream. In v1.0.0 that project replaced the direct `claude -p` transport with the official Claude Agent SDK, appending Pi's instructions to Claude Code's base prompt and keeping a live Claude session per conversation. This extension keeps the design both projects started from, Hermes's: Pi's prompt is the only instruction layer, and every call replays Pi's history as Claude Code's native messages. It was renamed to avoid confusion with the npm package `pi-claude-directsdk`.

## Acknowledgments and license

Based on [Pi Claude DirectSDK](https://github.com/joaomj/pi-claude-directsdk), Copyright (c) 2026 Joao Marcos, under the MIT license. Thanks to Joao Marcos for the original implementation.

Behavioral reference and source of ported cache-stabilization logic: [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-official-plugins/tree/main/claude-subscription-directsdk), Copyright (c) 2026 Nous Research, under the [MIT license](https://github.com/NousResearch/hermes-official-plugins/blob/main/LICENSE).

MIT. See `LICENSE`.
