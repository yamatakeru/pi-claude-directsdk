# Per-turn effort follows Claude Code's own placement

When Pi's thinking level changes mid-session, the relay states each replayed turn's effort where Claude Code itself would state it in one of its own sessions. It does not adopt pi-ai's managed-effort design.

Claude Code 2.1.322 sends the effort inside the conversation when per-turn effort is active for a model (beta `per-turn-control-2026-07-01`). Its own description of the field says:

> true: an effort change keeps the prompt cache, because the effort is sent inside the conversation, at the turn where it changes.

Its builder (`Xat` in the 2.1.322 bundle) reads the effort each recorded assistant turn ran at. The first statement rides on the environment message after the first user message. Each later change is a system message, `{"role": "system", "content": [], "output_config": {"effort": …}}`, placed after the user message and before the reply it governs. It is merged into a system message already at that position. The request-level `output_config.effort` is the last stated level.

Replayed history reaches a fresh child through stream-json, which drops any per-turn level on an assistant frame. This was checked on 2.1.302 and 2.1.322, with the level at the frame's top level and inside `message`. The CLI therefore states only the current level, on the environment message. A level change rewrites that message and missed the whole cache in both recorded cases (#5).

## Decision

- **Levels.** Each replayed assistant frame gets the effort it ran at:
  - the `providerThinkingLevel` this provider recorded, which is now set on every response to the effort sent as `--effort`, when the current model has that level. A level from another model that the current one lacks, such as `max`, is never restated.
  - otherwise Pi's `thinkingLevel`, mapped through the current model's `thinkingLevelMap`.
  - A turn with neither takes the next known level after it, as the CLI's own builder does. A session with one turn from another provider therefore keeps working, and the result is the same in every later request.
- **Placement.** The relay places the statements as the builder above would, after the native-context steps and the tool-change system messages.
- **When the relay changes nothing.** The request is forwarded as built when:
  - the CLI did not put exactly one statement, at the current level, on the system message where the first statement goes;
  - the assistant count differs from the replay;
  - every turn already ran at the current level.
- **Reporting.** The step reports `turnEffortsPlaced` or a skip reason in `nativeContext`, and never fails a call.

## Considered options

- **pi-ai's managed-effort design** (`supportsMidConvoEffort` in pi-ai 1.5.0). It puts a statement before every historical assistant message and one at the end. It fixes the request-level effort at `low`, adds the `mid-conversation-output-config-2026-07-01` and `thinking-binding-controls-2026-08-01` betas, and sets `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`. Rejected.
  - **Why it fits pi-ai.** pi-ai calls the API directly and owns the whole request, so choosing the shape itself is natural there, and `drop_block` is a reasonable guard for a direct client.
  - **Why it does not fit here.** Claude Native sends what Claude Code builds. The subscription route is built for Claude Code's requests, and Anthropic keeps the shapes the CLI sends working as the CLI changes. Each part of pi-ai's design is something the CLI does not send: the betas, the thinking setting, and the fixed request-level effort. Nothing would show if one of them stopped working after a CLI update.
  - **What is kept.** The goal and the API mechanism are the same as pi-ai's. Pi's recorded level of each turn is stated inside the conversation, so a change keeps the cache.
- **Labeling replayed frames with their level.** The CLI drops the label when it reads stream-json, so this has no effect.
- **Leaving the miss.** #5 was once closed because level changes were rare. The recorded sessions were biased: the maintainer avoided changes because of this miss.

## Consequences

- `drop_block` is not sent. Replayed signed thinking now runs behind the statements it was generated with, so a prefix mismatch is less likely than before. If mismatch errors appear, adding it is a separate decision.
- **The request-level effort follows the current level, as in the CLI's own requests.** A paid measurement on 2026-11-12 (Haiku 5.5, levels high → high → medium, one session) showed that this keeps the cache.
  - Third request: 15,137 tokens read from the cache, 12 written, 4 uncached.
  - That equals everything the second request read and wrote.
- **One intended difference from the CLI's builder.** The CLI delays a change that arrives while the last user message holds only tool results, until the next user message. Here the statement follows the last user message, so the level Pi asked for, which is also the `--effort` value, governs the reply.
- **Revisit triggers.** Watch `nativeContext` skip reasons after a CLI update. A model the CLI does not give per-turn effort keeps today's behavior.
