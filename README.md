# Pi Claude Native

[![CI](https://github.com/yamatakeru/pi-claude-native/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yamatakeru/pi-claude-native/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/github/license/yamatakeru/pi-claude-native)](LICENSE)

Use your Claude subscription as a model in Pi. Requests go through the official Claude Code executable and its login, while Pi stays in charge of the conversation, the system prompt, tools, and approvals.

This is an independent project, not made or endorsed by Anthropic.

## How it differs

- **Claude works as Pi's agent.** Pi's system prompt is the only instruction layer; Claude Code's own prompt, tools, settings, and memory are not added.
- **Pi's history is the only history.** Every call replays Pi's current transcript, signed thinking included, into a fresh `claude -p` process. There is no Claude-side session to drift from Pi's, so branching, editing, and compaction need no resynchronisation.
- **Pi runs every tool.** A response's tool calls, parallel ones included, reach Pi together after the response completes.
- **Plan limits are protected.** Requests carry the extension's own client label instead of an SDK one, which [anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074) measured as drawing the 5-hour window faster. A turn charged to usage credits stops the session unless you opt in.
- **The prompt cache is reused** across calls despite the replay: 98.6% to 99.9% cache-read share on warm turns in the recorded [measurements](docs/transport-measurements.md). The lower values come from short sessions, where each new turn is a larger share of the prompt.

The costs: each call starts a new Claude Code process, which adds about half a second. The transport depends on Claude Code's internal `stream-json` and request formats, so only a qualified range of versions is supported. A local relay rewrites each request to keep the cache stable and admits one upstream request per call. Anthropic does not document this kind of use, and a policy or billing change could stop it working.

### Alternatives

Other Pi extensions that use a Claude subscription through Claude Code:

- [pi-claude-directsdk](https://github.com/joaomj/pi-claude-directsdk) 1.0 and later: the official Agent SDK. Pi's prompt is appended to Claude Code's, and a live Claude session is kept per conversation and rebuilt when Pi's history diverges.
- [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge): the official Agent SDK, with a Claude session that mirrors Pi's history.
- [pi-claude-code](https://github.com/earendil-works/pi-claude-code): `claude -p` behind a relay, like this extension, reusing a warm process for text-only turns.

## Requirements

- Pi. Verified with Pi 1.5.2.
- Node 20 or later for Node-based Pi installations and local development. Compiled Pi uses its bundled runtime.
- Claude Code in the qualified range `>=2.1.263 <2.2.0` (see `QUALIFIED_CLI_RANGE` in `src/models.ts`). Verified with 2.1.322.
- A Claude paid plan. The free plan excludes the CLI.
- A Claude Code login via `claude auth login`.

## Install

Install the verified Claude Code version, then sign in through the official CLI:

```sh
npm install -g --ignore-scripts=false @anthropic-ai/claude-code@2.1.322
claude auth login
```

Install the extension from npm. It follows the latest release:

```sh
pi install npm:pi-claude-native
```

To stay on a release instead, add its version, for example `npm:pi-claude-native@0.9.1`; `pi update` does not move a pinned version. Releases are listed on [GitHub](https://github.com/yamatakeru/pi-claude-native/releases).

To follow `main` between releases, install from Git instead with `pi install git:github.com/yamatakeru/pi-claude-native`, or add a tag such as `@v0.9.1` to stay on a release. Install from one source only: Pi identifies an npm package by its name and a Git package by its URL, so both would load.

Start or restart interactive Pi, open `/model`, and wait for the catalog refresh. On a fresh install, this step must complete before selecting the model from the command line; later invocations can use the saved catalog, for example `pi --model claude-native/haiku`. `pi update --models` does not refresh this catalog.

The extension uses the CLI login, not the Pi Anthropic login. The `npm install` flag enables the Claude Code installer for that command only.

The model catalog does not guarantee account entitlement. Start with `haiku` for a small request. Models that require usage credits can incur separate charges, and the extension cannot undo a charge that Claude Code already reported. See [usage credits](docs/usage.md#usage-credit-guard).

## Upgrade

```sh
pi update npm:pi-claude-native
```

For a Git installation, use `pi update git:github.com/yamatakeru/pi-claude-native`. A bare `pi update` updates Pi itself, not its packages; `pi update --extensions` updates every installed package. Restart Pi afterwards, then open `/model` and wait for catalog refresh.

### Moving from a Git installation

Releases up to 0.9.0 were installed from Git. To move to npm, remove the Git package, then install from npm:

```sh
pi remove git:github.com/yamatakeru/pi-claude-native
pi install npm:pi-claude-native
```

The provider id is unchanged, so saved sessions continue.

### Moving from pi-claude-directsdk

Remove the old package (`pi remove npm:pi-claude-directsdk` or `pi remove git:github.com/yamatakeru/pi-claude-directsdk`), then install this one. The provider id and the environment variable names changed; see [0.4.0 in the changelog](CHANGELOG.md#040---2026-11-01). Since [0.6.0](CHANGELOG.md#060---2026-11-02), sessions saved by the old extension continue without their signed thinking; earlier turns replay as visible text and tool calls.

## Known issues

- Plan billing depends on two undocumented Anthropic checks: the custom client label must stay out of the SDK bucket, and the replacement `<docs>` section must not look like Pi's prompt ([#23](https://github.com/yamatakeru/pi-claude-native/issues/23), joaomj/pi-claude-directsdk [#27](https://github.com/joaomj/pi-claude-directsdk/issues/27)). If rejections return, the extension can go back to the `sdk-cli` label; if [anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074) is fixed, the label and the prompt change can both go.
- Changing the thinking level mid-session keeps the cache only where Claude Code states the effort per turn for the model. Elsewhere the next request misses the whole cache once ([Per-turn effort](docs/architecture.md#per-turn-effort-srcturn-effortts)).
- After a long tool loop with thinking, the next user turn may miss part of the cache; under investigation ([#10](https://github.com/yamatakeru/pi-claude-native/issues/10)).
- A tool change still causes a full cache miss on models that Anthropic's documentation does not list for mid-conversation tool changes, such as Haiku 4.5 and Sonnet 5 ([Tool changes](docs/troubleshooting.md#tool-changes)). Anthropic does not support the blocks that keep the cache on those models.

## Documentation

- [Usage and configuration](docs/usage.md): local checkout, environment settings, costs, diagnostics, and verification.
- [Architecture](docs/architecture.md): request lifecycle, model routing, tool transport, and admission relay.
- [Troubleshooting](docs/troubleshooting.md): missing CLI, login, version, and conflicting environment settings.
- [Testing](docs/testing.md), [startup](docs/startup.md), and [transport measurements](docs/transport-measurements.md): verified environments, offline and paid checks, and cache measurements.

## Issues and security

Report bugs and suggestions in [this repository's issues](https://github.com/yamatakeru/pi-claude-native/issues). See [CONTRIBUTING.md](CONTRIBUTING.md).

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md); please do not post vulnerabilities or credentials in public issues.

## History

This is a Pi port of [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-official-plugins/tree/main/claude-subscription-directsdk). It began as a fork of [joaomj/pi-claude-directsdk](https://github.com/joaomj/pi-claude-directsdk), where fixes were tried in everyday use and reported upstream. When that project moved to the official Agent SDK in v1.0.0, this one continued from v0.3.1 with the direct transport and was renamed to avoid confusion with the npm package `pi-claude-directsdk`.

v0.4.0 is the first release under this name. Changes since v0.3.1 include cache reuse across calls ([#1](https://github.com/yamatakeru/pi-claude-native/issues/1), [#13](https://github.com/yamatakeru/pi-claude-native/pull/13)), Pi's thinking level passed as `--effort` ([#2](https://github.com/yamatakeru/pi-claude-native/issues/2)), clearer relay failures ([#4](https://github.com/yamatakeru/pi-claude-native/issues/4), [#7](https://github.com/yamatakeru/pi-claude-native/issues/7)), tool changes placed on the right assistant boundary ([#18](https://github.com/yamatakeru/pi-claude-native/issues/18)), Pi's docs guidance kept in the replacement `<docs>` section ([#30](https://github.com/yamatakeru/pi-claude-native/issues/30)), quoted rejection text no longer failing as a billing error ([#20](https://github.com/yamatakeru/pi-claude-native/issues/20)), and a stricter usage-credit opt-in ([#21](https://github.com/yamatakeru/pi-claude-native/issues/21)). Later changes are in [CHANGELOG.md](CHANGELOG.md) and the [release notes](https://github.com/yamatakeru/pi-claude-native/releases).

## Acknowledgments and license

Based on [Pi Claude DirectSDK](https://github.com/joaomj/pi-claude-directsdk), Copyright (c) 2026 Joao Marcos, under the MIT license. Thanks to Joao Marcos for the original implementation.

Behavioral reference and source of ported cache-stabilization logic: [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-official-plugins/tree/main/claude-subscription-directsdk), Copyright (c) 2026 Nous Research, under the [MIT license](https://github.com/NousResearch/hermes-official-plugins/blob/main/LICENSE).

MIT. See `LICENSE`.
