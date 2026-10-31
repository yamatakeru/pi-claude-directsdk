# Pi Claude DirectSDK — experimental fork

[![CI](https://github.com/yamatakeru/pi-claude-directsdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yamatakeru/pi-claude-directsdk/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/github/license/yamatakeru/pi-claude-directsdk)](LICENSE)

Use Claude inside Pi through the unmodified Claude Code executable. Pi owns the transcript, tools, approvals, and retries; the CLI supplies subscription authentication as a model transport.

Each request starts a fresh `claude -p` process that replays Pi's history with an explicit cache anchor, and every tool call returns to Pi for execution. Three measurements recorded 99.6% to 99.8% cache-read share on warm turns; see [transport measurements](docs/transport-measurements.md) for the workloads and their limits.

This is an unofficial fork of [joaomj/pi-claude-directsdk](https://github.com/joaomj/pi-claude-directsdk). It is where fixes are tried in everyday use before being reported upstream; see [Fork changes](#fork-changes). The npm package `pi-claude-directsdk` is upstream's and does not include them.

## Requirements

- Pi. This fork is verified with Pi 1.4.0.
- Node 20 or later for Node-based Pi installations and local development. Compiled Pi uses its bundled runtime.
- Claude Code in the qualified range `>=2.1.263 <2.2.0` (see `QUALIFIED_CLI_RANGE` in `src/models.ts`). This fork is verified with 2.1.312.
- A Claude paid plan. The free plan excludes the CLI.
- A Claude Code login via `claude auth login`.

## Install

Install the verified Claude Code version, then sign in through the official CLI:

```sh
npm install -g --ignore-scripts=false @anthropic-ai/claude-code@2.1.312
claude auth login
```

Install this fork from Git. It follows `main`:

```sh
pi install git:github.com/yamatakeru/pi-claude-directsdk
```

Keep only one DirectSDK extension active. If upstream is installed, remove it first with `pi remove npm:pi-claude-directsdk` (or its Git source); `pi list` shows what is installed.

Start or restart interactive Pi, open `/model`, and wait for the DirectSDK catalog refresh. On a fresh install, this step must complete before selecting the model from the command line; later invocations can use the saved catalog, for example `pi --model claude-directsdk/haiku`. `pi update --models` does not refresh the DirectSDK catalog.

DirectSDK uses the CLI login, not the Pi Anthropic login. The `npm install` flag enables the Claude Code installer for that command only.

The model catalog does not guarantee account entitlement. Start with `haiku` for a small request. Models that require usage credits can incur separate charges, and DirectSDK cannot undo a charge that Claude Code already reported. See [usage credits](docs/usage.md#usage-credit-guard).

## Upgrade

```sh
pi update git:github.com/yamatakeru/pi-claude-directsdk
```

A bare `pi update` updates Pi itself, not its packages; `pi update --extensions` updates every installed package. Version-pinned sources remain pinned when updated, so change a pin or switch back to upstream with `pi remove <old-source>` and a fresh install. Restart Pi afterwards, then open `/model` and wait for catalog refresh.

## Fork changes

Relative to upstream v0.3.1 (`4371343`):

- **Cache reuse across calls** (default). Every call replays history through a fresh CLI process, and the CLI adds per-request context (a session reminder, the date line) that never recurs. The relay moves or drops that context, so each request's cached prefix is read by the next one ([#1](https://github.com/yamatakeru/pi-claude-directsdk/issues/1), [#13](https://github.com/yamatakeru/pi-claude-directsdk/pull/13)).
- **Thinking level honoured** (default). Pi's thinking level reaches the CLI as `--effort`; an inherited `CLAUDE_CODE_EFFORT_LEVEL` no longer overrides it ([#2](https://github.com/yamatakeru/pi-claude-directsdk/issues/2)).
- **Clearer relay failures** (default). Connection errors report codes, addresses and the failing phase instead of a bare `AggregateError`, and a connection dropped mid-response ends the call instead of hanging it ([#4](https://github.com/yamatakeru/pi-claude-directsdk/issues/4), [#7](https://github.com/yamatakeru/pi-claude-directsdk/issues/7)).
- **Inherited client label removed in any case** (default). On Windows, an inherited `CLAUDE_CODE_ENTRYPOINT` with different letter case is removed too, so it cannot shadow the label DirectSDK sets, or survive an empty `CLAUDE_DIRECTSDK_ENTRYPOINT`.
- **Pi's docs guidance kept** (default). Upstream replaces Pi's `<docs>` section with a one-sentence pointer on DirectSDK turns. The fork sends Pi's guidance as prose instead, with `docs/docs.json` as the index in place of the rejected topic-to-path list ([#30](https://github.com/yamatakeru/pi-claude-directsdk/issues/30)).
- **Tool changes on the right assistant boundary** (default). Upstream's mid-conversation tool changes now skip carried assistant frames that the CLI drops, and a request whose assistant messages differ from the replay fails before reaching upstream instead of placing tool changes at the wrong point ([#13](https://github.com/yamatakeru/pi-claude-directsdk/pull/13), [#18](https://github.com/yamatakeru/pi-claude-directsdk/issues/18)).

Upstream's maintainer workflows (AI review, auto-assign, upstream watch) are kept unchanged in `.github/workflows` but disabled in this repository.

### Known issues

- Plan billing depends on two undocumented Anthropic checks: the custom client label must stay out of the SDK bucket, and the replacement `<docs>` section must not look like Pi's prompt ([#23](https://github.com/yamatakeru/pi-claude-directsdk/issues/23), upstream [#27](https://github.com/joaomj/pi-claude-directsdk/issues/27)). If rejections return, the fork can go back to the `sdk-cli` label; if [anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074) is fixed, the label and the prompt change can both go.
- A session that did not start on a DirectSDK model, including one started before updating to this version, is rejected when continued on DirectSDK; start a new session or set `CLAUDE_DIRECTSDK_ENTRYPOINT=` for it ([#28](https://github.com/yamatakeru/pi-claude-directsdk/issues/28)).
- Changing the thinking level mid-session still causes a near-full cache miss ([#5](https://github.com/yamatakeru/pi-claude-directsdk/issues/5)).
- After a long tool loop with thinking, the next user turn may miss part of the cache; under investigation ([#10](https://github.com/yamatakeru/pi-claude-directsdk/issues/10)).
- A tool change still causes a full cache miss on models that Anthropic's documentation does not list for mid-conversation tool changes, such as Haiku 4.5 and Sonnet 5, and on any model when a tool is redefined under the same name ([#3](https://github.com/yamatakeru/pi-claude-directsdk/issues/3)).

### Verification

After the upstream v0.3.1 merge, with Pi 1.4.0, Claude Code 2.1.312, Haiku 5.5 and upstream's default client label, the second and third requests of a warm run read 98.64% and 99.87% of their input from cache, as after v0.3.0 with the `sdk-cli` label (98.76% and 99.85% after v0.2.0 with Claude Code 2.1.310). Earlier checks, before the merge and with Pi 1.3.0 and Claude Code 2.1.303, found the same level in interactive sessions with Haiku 5.5 and Sonnet 5.5 after tool loops, and showed that a prompt change and an added tool kept the cached prefix under the fork's former tool-change rewrite. The measurement report has the full numbers and limits for the [warm run](docs/transport-measurements.md#replay-stable-native-context), the [earlier tool-change rewrite](docs/transport-measurements.md#mid-conversation-system-messages-earlier-fork-rewrite) and the [interactive sessions](docs/transport-measurements.md#interactive-sessions-after-the-trimmed-result-fix).

## Comparison with other Claude providers

Three extensions expose the Claude subscription through Claude Code while Pi owns the session. This table reflects DirectSDK `main`, [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) 0.9.3, and [pi-claude-code](https://github.com/earendil-works/pi-claude-code) 0.1.0 (experimental) as of October 23, 2026.

| | DirectSDK | pi-claude-bridge | pi-claude-code |
|---|---|---|---|
| Extra charges | Stops after an overage charge unless opted in | No overage stop; 1M context Extra Usage is opt-in | Stops after an overage charge unless opted in |
| Tools | Pi executes; no delegation | Pi executes; optional AskClaude delegation, deprecated | Pi executes; no delegation |
| Conversation | Fresh CLI; full replay; tool changes on supported models | Live Agent SDK query with a mirrored Claude session | Fresh CLI; warm reuse for text-only turns |
| Latency and cache | 99.6–99.8% cache-read share on warm turns | Query continues across tool calls; rebuilds miss the cache | Warm text turns skip startup; tool loops replay |
| Models | CLI picker plus Anthropic docs, with verified prices | pi-ai Anthropic catalog, updated automatically | CLI discovery plus fallback metadata |

DirectSDK requires Claude Code `>=2.1.263 <2.2.0`; pi-claude-bridge requires Pi `>=0.86.1`; pi-claude-code accepts the installed Claude Code version. All three use a Claude Code login, draw on the same subscription, and can be affected by Anthropic billing changes. None has a matched performance benchmark. See the [full comparison](docs/comparison.md) for source-level detail.

## Documentation

- [Usage and configuration](docs/usage.md): local checkout, environment settings, costs, diagnostics, and verification.
- [Architecture](docs/architecture.md): request lifecycle, model routing, tool transport, and admission relay.
- [Troubleshooting](docs/troubleshooting.md): missing CLI, login, version, and conflicting environment settings.
- [Testing](docs/testing.md), [startup](docs/startup.md), [transport measurements](docs/transport-measurements.md), and the [full Bridge comparison](docs/comparison.md). `docs/testing.md` lists upstream's verified environments; fork checks are under [Verification](#verification).

## Issues and security

Report fork-specific bugs and suggestions in [this fork's issues](https://github.com/yamatakeru/pi-claude-directsdk/issues). Upstream takes issues but not unsolicited pull requests ([CONTRIBUTING.md](CONTRIBUTING.md)), so fixes found here are proposed there as issues with reproduction evidence.

This fork has no private vulnerability-reporting channel; please do not post vulnerabilities or credentials in public issues. [SECURITY.md](SECURITY.md) describes upstream's channel, which covers upstream code only.

## Acknowledgments and license

Based on [Pi Claude DirectSDK](https://github.com/joaomj/pi-claude-directsdk), Copyright (c) 2026 Joao Marcos, under the MIT license.

Behavioral reference and source of ported cache-stabilization logic: [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-official-plugins/tree/main/claude-subscription-directsdk), Copyright (c) 2026 Nous Research, under the [MIT license](https://github.com/NousResearch/hermes-official-plugins/blob/main/LICENSE).

MIT. See `LICENSE`.
