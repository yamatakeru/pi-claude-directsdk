# Changelog

Pi shows the entries newer than the last version it saw on the first fresh launch after an update. The [release notes](https://github.com/yamatakeru/pi-claude-native/releases) start from the same text and add details and how to pin a release.

## [0.9.1] - 2026-11-12

Claude Native is now published on npm as `pi-claude-native` and can be installed with `pi install npm:pi-claude-native`. Nothing else changed.

### Changed

- To move a Git installation to npm, run `pi remove git:github.com/yamatakeru/pi-claude-native`, then `pi install npm:pi-claude-native`. Installing from both loads the extension twice.

## [0.9.0] - 2026-11-12

Checked with Pi 1.5.2 and Claude Code 2.1.322. `/model` lists the models your account can use, and changing the thinking level during a session keeps the prompt cache.

### Changed

- The model list comes from the picker Claude Code serves your account, so `/model` also shows the older models the account still runs and the `fable` alias. To get that picker, discovery talks to Anthropic directly with Claude Code's nonessential traffic and feature flags left on; error reports and self-updates stay off, and a value you export is kept. Discovery never starts a model turn. Behind `ANTHROPIC_BASE_URL` or another backend it keeps the generic list ([#57](https://github.com/yamatakeru/pi-claude-native/issues/57), [#84](https://github.com/yamatakeru/pi-claude-native/pull/84)).
- The `pi-claude-native/meta` diagnostic keeps the upstream HTTP status as `upstreamStatus`, so a saved session shows whether a failed turn was, for example, a 429 or a 400 ([#64](https://github.com/yamatakeru/pi-claude-native/issues/64), [#83](https://github.com/yamatakeru/pi-claude-native/pull/83)).

### Fixed

- Changing the thinking level during a session no longer makes the next request miss the whole prompt cache, on models where Claude Code states the effort per turn. Each earlier turn's level is stated where Claude Code places it in its own sessions, and `nativeContext` reports `turnEffortsPlaced`. The design is recorded in [ADR 0002](docs/adr/0002-per-turn-effort-placement.md) ([#5](https://github.com/yamatakeru/pi-claude-native/issues/5), [#85](https://github.com/yamatakeru/pi-claude-native/pull/85)).
- On Windows, `PI_CLAUDE_NATIVE_ENTRYPOINT` is read under any letter case instead of being ignored ([#29](https://github.com/yamatakeru/pi-claude-native/issues/29), [#83](https://github.com/yamatakeru/pi-claude-native/pull/83)).

## [0.8.0] - 2026-11-11

Checked with Pi 1.5.2 and Claude Code 2.1.322 (a fresh request, and a session written by another provider continued on Claude Native). Replay now accepts every history that Pi's own Anthropic provider can send. Switching models during a session, extensions that edit the history, and side requests such as an advisor no longer fail replay.

### Changed

- Parts of a history that Claude cannot take natively are adjusted without losing content, and each adjustment is listed under `replayAdjustments` in the `pi-claude-native/meta` diagnostic. The rule is recorded in [ADR 0001](docs/adr/0001-replay-input-contract.md) ([#76](https://github.com/yamatakeru/pi-claude-native/issues/76), [#78](https://github.com/yamatakeru/pi-claude-native/pull/78)).

### Fixed

- A request that declares fewer tools than the history used no longer fails with "Tool call outside the current inventory". This covers a tool-less side request, a session that started on another provider, and a removed tool on a model without mid-conversation tool changes. Those calls and their results are replayed as text ([#72](https://github.com/yamatakeru/pi-claude-native/issues/72), [#73](https://github.com/yamatakeru/pi-claude-native/pull/73)).
- An assistant turn with nothing left to send is omitted instead of failing with "Empty assistant message cannot be replayed". For example, an advisor called with no text before it leaves such a turn ([#74](https://github.com/yamatakeru/pi-claude-native/issues/74), [#78](https://github.com/yamatakeru/pi-claude-native/pull/78)).
- A tool call left without a result, as after a failed or interrupted turn, gets the result `No result provided` instead of making the request invalid. A result that arrives after a user message is kept as text ([#75](https://github.com/yamatakeru/pi-claude-native/issues/75), [#78](https://github.com/yamatakeru/pi-claude-native/pull/78)).
- Pi's docs section is replaced in every request, including sessions that started on another provider and side requests made while another model is active ([#28](https://github.com/yamatakeru/pi-claude-native/issues/28), [#77](https://github.com/yamatakeru/pi-claude-native/pull/77)).

## [0.7.1] - 2026-11-10

### Fixed

- On Fable 5.1, switching between a tool-result step and a new user turn no longer writes the whole conversation to the prompt cache again. On tool-result steps Claude Code sends a batching reminder after the date line, and the date was then left out of the start of the conversation. The same applies on any model where Anthropic turns that reminder on ([#41](https://github.com/yamatakeru/pi-claude-native/issues/41), [#70](https://github.com/yamatakeru/pi-claude-native/pull/70)).

## [0.7.0] - 2026-11-06

Checked with Pi 1.5.0 and Claude Code 2.1.318 (startup, a fresh request, warm cache and replayed thinking). An `ANTHROPIC_API_KEY` set for Pi's own Anthropic provider no longer blocks Claude Native, and on models that support them, mid-conversation tool changes work again and keep the cache when a tool is redefined.

### Changed

- API credentials in Pi's environment (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_FOUNDRY_API_KEY`) are left out of Claude Code instead of refusing every turn, so Claude Code always signs in with your subscription ([#55](https://github.com/yamatakeru/pi-claude-native/issues/55), [#65](https://github.com/yamatakeru/pi-claude-native/pull/65)). Backend overrides such as `ANTHROPIC_BASE_URL` are still refused.
- On models that support mid-conversation tool changes, a tool redefined under the same name no longer makes the next request miss the whole cache. Later tools are now sent by value, as Pi's own Anthropic provider does ([#56](https://github.com/yamatakeru/pi-claude-native/issues/56), [#66](https://github.com/yamatakeru/pi-claude-native/pull/66)).

### Fixed

- Mid-conversation tool changes were turned off, with a warning on every catalog refresh, after Anthropic reworded the page that lists the supported models ([#51](https://github.com/yamatakeru/pi-claude-native/issues/51), [#59](https://github.com/yamatakeru/pi-claude-native/pull/59)).
- A reply cut off at the output limit inside a tool call no longer fails with a JSON error. The turn ends as `length` when the reply already has text or another call; otherwise the error names the tool that was cut off ([#52](https://github.com/yamatakeru/pi-claude-native/issues/52), [#60](https://github.com/yamatakeru/pi-claude-native/pull/60)).
- When a failed upstream request makes Claude Code end without a result, for example at a usage limit, the error shows Anthropic's reason instead of "Expected exactly one native result" ([#54](https://github.com/yamatakeru/pi-claude-native/issues/54), [#62](https://github.com/yamatakeru/pi-claude-native/pull/62)).

## [0.6.0] - 2026-11-02

Verified with Pi 1.5.0 and Claude Code 2.1.316. Sessions saved by pi-claude-directsdk no longer replay their signed thinking.

### Changed

- The prose that replaces Pi's `<docs>` section again says that the codemode guide covers classifiers and image models, and that Pi's docs are needed only for questions about Pi itself. Both were in Pi's section but had been dropped ([#47](https://github.com/yamatakeru/pi-claude-native/pull/47)).
- Pi shows this changelog on the first fresh launch after an update ([#48](https://github.com/yamatakeru/pi-claude-native/pull/48)).

### Removed

- Signed thinking saved by pi-claude-directsdk (carrier type `pi-claude-directsdk/native`) is no longer restored, as announced in 0.4.0. Such sessions still continue: their earlier turns replay as the visible text and tool calls, without the thinking.

## [0.5.0] - 2026-11-01

Replayed thinking now reaches the model, and the cache keeps the conversation after long thinking loops.

### Changed

- Signed thinking from earlier turns is sent again ([#42](https://github.com/yamatakeru/pi-claude-native/issues/42), [#43](https://github.com/yamatakeru/pi-claude-native/pull/43)). Through v0.4.0 the extension restored it from the session but Claude Code dropped it before the request, so in a tool loop the model did not see its earlier reasoning.
- After a tool loop longer than the cache lookback, the next user turn reads the conversation before the loop from the cache instead of only the system prompt and tools ([#10](https://github.com/yamatakeru/pi-claude-native/issues/10), [#44](https://github.com/yamatakeru/pi-claude-native/pull/44)).

### What to expect

Requests in tool loops now carry the earlier thinking, so their input grows by those tokens. After the first write they are mostly read from the cache. The net effect on subscription usage has not been measured.

## [0.4.0] - 2026-11-01

First release under the name pi-claude-native. It continues pi-claude-directsdk v0.3.1 with the direct `claude -p` transport.

### Moving from pi-claude-directsdk

- Remove the old package (`pi remove npm:pi-claude-directsdk` or `pi remove git:github.com/yamatakeru/pi-claude-directsdk`), then run `pi install git:github.com/yamatakeru/pi-claude-native`.
- The provider id is now `claude-native`. Select the model again in `/model` when you resume an older session.
- Environment variables are now `PI_CLAUDE_NATIVE_*`. The old `CLAUDE_DIRECTSDK_*` and `PI_DIRECTSDK_*` names are not read.
- Signed thinking saved by the old extension still replays for now. A later version removes this.

### Changed since pi-claude-directsdk v0.3.1

- Cache reuse across calls ([#1](https://github.com/yamatakeru/pi-claude-native/issues/1), [#13](https://github.com/yamatakeru/pi-claude-native/pull/13)).
- Pi's thinking level passed to Claude Code as `--effort` ([#2](https://github.com/yamatakeru/pi-claude-native/issues/2)).
- Clearer relay failures ([#4](https://github.com/yamatakeru/pi-claude-native/issues/4), [#7](https://github.com/yamatakeru/pi-claude-native/issues/7)).
- Tool changes placed on the right assistant boundary ([#18](https://github.com/yamatakeru/pi-claude-native/issues/18)).
- Pi's docs guidance kept in the replacement `<docs>` section ([#30](https://github.com/yamatakeru/pi-claude-native/issues/30)).
- Quoted rejection text no longer fails a successful turn as a billing error ([#20](https://github.com/yamatakeru/pi-claude-native/issues/20), [#33](https://github.com/yamatakeru/pi-claude-native/pull/33)).
- Claude Code runs with native artifacts off, so its scratchpad line cannot reach requests under the custom client label ([#34](https://github.com/yamatakeru/pi-claude-native/issues/34), [#36](https://github.com/yamatakeru/pi-claude-native/pull/36)).
- `PI_CLAUDE_NATIVE_ALLOW_USAGE_CREDITS` allows charges only when set to `1`. Before, a typo or `disabled` turned the guard off ([#21](https://github.com/yamatakeru/pi-claude-native/issues/21), [#37](https://github.com/yamatakeru/pi-claude-native/pull/37)).
- The model catalog survives a failed or stalled fetch of the mid-conversation page. Only tool changes are withheld ([#25](https://github.com/yamatakeru/pi-claude-native/issues/25), [#39](https://github.com/yamatakeru/pi-claude-native/pull/39)).
- The docs match the code for the thinking-only truncation error and for failed-request cost reporting ([#26](https://github.com/yamatakeru/pi-claude-native/issues/26), [#38](https://github.com/yamatakeru/pi-claude-native/pull/38)).
