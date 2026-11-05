# Changelog

Pi shows the entries newer than the last version it saw on the first fresh launch after an update. The [release notes](https://github.com/yamatakeru/pi-claude-native/releases) start from the same text and add details and how to pin a release.

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
