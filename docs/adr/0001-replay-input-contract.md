# Replay accepts any history pi-ai's Anthropic provider can send

Replay accepts every Pi history that pi-ai's built-in Anthropic provider turns into a valid request. The reference is the pi-ai version this repository verifies against (1.5.0, the `devDependencies` pin). Parts the native form cannot represent are adjusted so that no content is lost, and each adjustment is recorded in the `pi-claude-native/meta` diagnostic (`replayAdjustments`). Replay rejects a history only when the result would describe an event that did not happen, could not pair a tool call with its result, or would change what the request asks for. A carrier keeps a replay faithful and cacheable; replay does not depend on it.

This replaces "reject unsupported history instead of flattening it into prose". That rule came from the upstream fork's original PRD (`35d50a3`, removed in `ed14966`), which copied the behavior contract of the Hermes DirectSDK plugin and gave no reason. The rule assumed that Claude Native had written the history itself. In Pi, other writers edit the history too: other providers after a model switch, extensions through the `context` event and side requests, compaction, and tool changes during a session. Every failure the rule caused was for a history that pi-ai's providers already send (#72, #74). Hermes itself has since relaxed the rule (`directsdk.py`, checked 2026-10-10). It replaces remote image URLs with a text hint ("A hint keeps the turn alive where an error would fail every retry of the same history") and accepts host-edited history.

## Considered Options

These options were considered for historical tool calls the request does not declare (#72):

- **Reject the history** (the original rule). This fails side requests and provider switches, even though the content is still meaningful.
- **Send the call as a native `tool_use` without declaring the tool** (Hermes #39). Whether upstream accepts this when other tools are declared is unverified, and an error would come from upstream as an opaque 400.
- **Declare stub tools for the missing names.** This makes the tools callable in a request that is meant to have none.
- **Replay the call and its result as labeled text** (chosen). No content is lost, and the request stays valid whatever tools it declares.

## Consequences

- Adjustments follow pi-ai where pi-ai has a rule:
  - A tool call without a result gets the result `No result provided`, marked as an error, before the next user message, the next assistant turn, or the end of the history. A call replayed as text gets it as text.
  - Images from an error result move after the turn's tool results.
  - An assistant turn with nothing left to send is omitted.
- Replay keeps more than pi-ai in one place. pi-ai drops failed and aborted assistant turns; replay keeps whatever content they have and closes their calls as above, so the content is not lost.
- Where pi-ai would send a request upstream rejects, replay goes further and keeps the content as labeled text: a tool result without an open call, for example one that arrives after a user message (#75). These rejections by upstream are inferred from pi-ai's own workarounds, not observed.
- Adding a missing tool result and remapping a tool-call ID do not count as describing an event that did not happen. The first only states that a result is missing; the second only changes an identifier.
- Replay still rejects these histories:
  - one that ends in an assistant turn without tool calls (prefill);
  - a tool call with an empty ID;
  - content types outside Pi's message types.
- The tests in `tests/replay-contract.test.ts` check each case against this contract.
