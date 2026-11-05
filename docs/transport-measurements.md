# Long-session transport measurement baseline

The historical cache-anchor repair achieved **99.59% and 99.71% cache-read share on two warm turns** in a three-request same-process verification. Both warm turns also reused the upstream HTTPS connection.

This report records the original timing baseline, the cache investigation, and the post-fix verification. Workloads differ between batches, so their timings do not establish a transport speedup.

## Original 30-run timing result

The median provider-call completion time was **2,345.663 ms**. The nearest-rank p95 was **4,037.668 ms**. The upstream request-to-first-data interval had a median of **1,415.731 ms** and a p95 of **3,328.727 ms**.

| Measurement | Median | p95, nearest rank |
|---|---:|---:|
| Whole Pi process wall time | 3,704 ms | 5,631 ms |
| Provider call to completion | 2,345.663 ms | 4,037.668 ms |
| History preparation | 1.785 ms | 2.827 ms |
| Setup after history | 18.849 ms | 27.932 ms |
| Child spawn to replay complete | 436.408 ms | 704.098 ms |
| Replay complete to upstream request | 28.647 ms | 42.274 ms |
| Upstream request to first response data | 1,415.731 ms | 3,328.727 ms |
| First response data to upstream response end | 274.013 ms | 332.143 ms |
| Upstream request to response end | 1,743.929 ms | 3,478.182 ms |
| Upstream response end to child exit | 79.919 ms | 94.986 ms |
| Child exit to Pi completion | 0.427 ms | 0.711 ms |

The nearest-rank p95 for 30 samples is the 29th value, or the second-slowest sample. Treat it as an exploratory estimate from this one workload.

## Workload and method

- Model: `claude-directsdk/claude-haiku-5-5`.
- Runs: 30 sequential replays of the same saved session; all 30 succeeded.
- Session: 32 tool calls and 467,954 bytes on disk.
- Per replay: 69 prepared frames, including 68 historical frames and 34 historical user acknowledgments.
- Upstream request body: 347,888 bytes in every run.
- Percentiles: median and nearest-rank p95, calculated separately for each measurement.

The batch ran with opt-in prefix hashing enabled. The measured system-prompt hash differed in all 30 runs; the tool-definition hash was the same in all 30. This shows that the Pi-supplied prompt input was not byte-identical across runs. The hashes do not identify the cause or which prompt portion changed. This report does not include hashes, prompts, or tool arguments.

## Cache counters

The median cache-read share was **2.2028%**; its nearest-rank p95 was **2.2030%**. Across all runs, reported usage counters summed to 60 input tokens, 377 output tokens, 88,530 cache-read tokens, and 3,930,250 cache-write tokens.

These counters describe token usage and reuse. They do not state subscription allowance deductions or billed cost. Because the system-prompt hash changed between runs, do not treat this result as a fixed-prefix cache benchmark without first identifying the changing prompt input.

## Limits

This is one long-session scenario for one model. It is not a before-and-after comparison, and it does not show that a proposed transport change would improve latency.

The upstream request-to-first-data interval combines transport setup and upstream response delay. The measurement does not isolate DNS, connection establishment, response headers, or model processing. First response data is not necessarily the first generated token.

A separate single fresh-request check is not part of these N=30 statistics and is not a short-session cohort. This report also does not cover image-heavy requests, failed-call diagnostics, or end-to-end multi-turn task duration.


## Same-process cache investigation

Three additional paid requests ran sequentially through one Pi RPC process, using a private fork of an existing session and a fixed agent directory. All three succeeded, each admitted one upstream request, and the process produced no stderr. Auto-retry and auto-compaction were disabled. This measurement ran before connection pooling was implemented.

The starting session was 746,001 bytes, not the 467,954-byte session used in the earlier 30-run baseline. Do not compare their timings as a transport improvement.

| Turn | RPC prompt to settled | Provider completion | Cache-read tokens | Cache-write tokens | Cache-read share |
|---|---:|---:|---:|---:|---:|
| 1 | 3,620.861 ms | 3,510.288 ms | 2,951 | 196,674 | 1.4783% |
| 2 | 3,097.597 ms | 3,082.145 ms | 7,298 | 192,399 | 3.6545% |
| 3 | 2,365.867 ms | 2,350.713 ms | 7,298 | 192,460 | 3.6534% |

The Pi system prompt, native system blocks, and native tool definitions had identical content hashes across all three calls. Request bodies were 530,509, 530,844, and 531,134 bytes. Replay required 59, 60, and 61 historical user acknowledgments. History preparation took 0.930–2.542 ms, child spawn to replay completion took 531.599–602.012 ms, and replay completion to upstream request took 33.959–52.514 ms.

The earlier fresh-process benchmark changed paths that Pi includes in its system prompt. The same-process run removes that confound, but cache reuse remains low. Stable system and tool content alone does not explain the missing history reuse.

### Native prefix observations

A private observer recorded content hashes, byte counts, and cache-control positions at the native request boundary. It did not save prompt text, tool arguments, or authentication headers.

- Native requests contained 121, 123, and 125 messages.
- Two system text blocks had explicit one-hour cache controls.
- There were no tool breakpoints or top-level cache controls.
- Each request had one message breakpoint, on the first block of its final system-role message. That block had identical content across the three calls.
- For each consecutive pair, earlier history was identical. Differences began at the former final user message: its replay lost tail blocks, and the former final system-message position became an assistant message.

Thus, the conversation cache breakpoint was after native tail content that the next replay did not reproduce. There was no explicit conversation anchor in the unchanged historical prefix. The official [prompt-caching guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) requires exact matching prefixes and describes the distinction between cache-writing breakpoints and the limited backward lookup window. A stable earlier prefix does not, by itself, establish that the API cached that prefix.

These observations support adding an explicit anchor to stable historical replay content. Do not remove legitimate Pi instructions or freeze the system prompt to improve cache reuse.

### Cache-anchor repair

`src/replay.ts` now places one explicit cache control on the last nonempty block of the latest historical user/tool-result frame. It does not mark the final user frame: the CLI inserts transient reminder content inside that frame. The historical anchor lets the API write a reusable prefix before that transient content.

The change affects replay metadata only. It does not edit Pi messages, tool arguments, tool-result associations, system instructions, or signed thinking. If there is no historical user frame, it adds no anchor. The native completion gate and one-request admission limit remain unchanged.

Replay and native breakpoints use matching cache lifetimes. The transport defaults to `1h`, matching the original measured subscription requests. Set `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` for a five-minute lifetime. `FORCE_PROMPT_CACHING_5M` takes precedence. Invalid TTL values produce an error that names the setting. Global and model-family cache-disable flags suppress the replay anchor.

The existing benchmark was run against a loopback-only, refused upstream to inspect real CLI request generation without paid requests. The CLI preserved the historical anchor before the final user and system-tail messages. Requests had four breakpoints: two system blocks, the historical anchor, and the native tail. Both one-hour and forced five-minute settings produced compatible cache controls.

Those model calls failed as expected because the upstream was blocked. That check verified native marker emission only. The subsequent paid verification below confirmed successful generation and high warm-cache reuse with one-hour controls. Longer gaps or more than the API's backward lookup window between anchors can still prevent reuse.

### Replay-stable native context

The historical anchor still left the previous call's final frame uncached. On Claude Code 2.1.303, a loopback capture of real CLI requests (structure and hashes only) showed three causes:

- The CLI's session-context reminder, which carries the account email in an empty child directory, is added to the final frame. It appears in three places: as text before the user message, as a suffix of a string tool result, or as trailing text after parallel tool results and a user message.
- From the second request on, today's date moves from the end of the environment system message to a trailing system message. That changes the conversation's second message after call 1, so call 2 missed everything after it.
- The CLI's message breakpoint sits on that trailing date message, which never recurs.

`CLAUDE_CODE_DISABLE_ATTACHMENTS=1` did not change the request. No setting was found that removes the reminder while keeping OAuth.

The relay now restores a replay-stable prefix (see [architecture.md](architecture.md#replay-stable-native-context-srcnative-contextts)). This ports the Hermes reference relay's `restore_queried_turn`, `stable_request_context`, `_frame_first`, and `pin_message_breakpoint` ([hermes-official-plugins#83](https://github.com/NousResearch/hermes-official-plugins/pull/83) and earlier changes). After the change, the same capture showed every request's prefix through its message breakpoint replayed unchanged in the next request. This held for user turns, a tool round, and parallel tools followed by text. Each request still had at most four breakpoints.

A paid three-request `warm` run then went through installed Pi 1.3.0 with Claude Code 2.1.303 and `claude-haiku-5-5`. It used no prior session and short prompts. All three requests succeeded, each admitted one upstream request, and the Pi prompt and tool hashes stayed stable:

| Request | Cache-read tokens | Cache-write tokens | Cache-read share |
|---|---:|---:|---:|
| 1 | 19,431 | 9,109 | 66.93% |
| 2 | 28,540 | 376 | 98.69% |
| 3 | 28,916 | 56 | 99.79% |

Request 1 read the system and tools prefix cached by earlier runs. Requests 2 and 3 read the whole previous request and wrote only the new turn. Before this change, the previous call's final frame was written again on every call, and call 2 re-wrote the opening turn.

After the upstream v0.2.0 merge (fork #19, commit `0700cf7`), the same run on installed Pi 1.4.0 with Claude Code 2.1.310 started from an empty cache and read 0%, 98.76% and 99.85% (28,705 / 357 / 41 cache-write tokens). Each request again admitted one upstream request with stable Pi prompt and tool hashes. After the upstream v0.3.0 merge, with Claude Code 2.1.312 and the CLI's own `sdk-cli` label ([fork #23](https://github.com/yamatakeru/pi-claude-directsdk/issues/23)), it read 0%, 98.64% and 99.87% (25,953 / 353 / 30 cache-write tokens), again with stable hashes. After the upstream v0.3.1 merge, with upstream's default `pi-claude-directsdk` label and its replacement `<docs>` section, it read 0%, 98.64% and 99.87% (25,588 / 349 / 30 cache-write tokens), again with stable hashes. On installed Pi 1.5.0 with Claude Code 2.1.316, after v0.5.0 and with the replacement `<docs>` section updated for Pi 1.5.0, it read 0%, 98.68% and 99.85% (26,607 / 353 / 37 cache-write tokens), again with stable hashes.

Three options were considered for the reminder:

- **Drop it after the opening call (adopted, as in Hermes).** Native Claude Code attaches this context only when the history lacks it, so a continuous session carries it once. Dropping it keeps every replay in the context its signed thinking was generated against. In this transport it carries only the account email.
- **Move it after the frame on every call (rejected).** The model would see it on every call, but each call's thinking would be generated with context that its replay lacks.
- **Pin it after the conversation's first frame (not adopted).** This is closest to native behaviour, but it has no reference measurements, and it requires normalizing CLI text that differs by placement.

Limits:

- Routes without a mid-conversation environment message, such as Haiku 4.5, still miss once on call 2: the CLI changes its opening-turn text between the first and second request.
- After a tool loop that contains thinking, the next user turn can still miss entries written after the first thinking block. That is a separate API-side behaviour. The relay now ports the Hermes turn-start marker ([hermes-official-plugins#36](https://github.com/NousResearch/hermes-official-plugins/issues/36), `_keep_turn_mark`), where the next turn's read rose from 54% to 94% in Hermes' live run. A loopback capture with Claude Code 2.1.316 after a 14-round thinking loop showed the marker on the opening frame within four breakpoints; this transport has no paid measurement of it yet. Until replayed thinking reached the request (see below), this miss did not apply here.
- A later CLI that changes these placements disables the affected step and shows up in `nativeContext`, not as a failed call.

### Artifact scratchpad line under the custom label

A loopback server recorded `/v1/messages` bodies from Claude Code 2.1.312 and 2.1.316 on macOS, run with this extension's child arguments and environment. No paid requests were made.

| Child environment | Scratchpad line |
|---|---|
| As `buildChildEnv` sets it (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`), label `pi-claude-native` | Absent; the body matches the `sdk-cli` one apart from the label and `session_id` |
| Without `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, label `pi-claude-native` or `claude-desktop` | Present, in the Environment reminder at `messages[1]`, with a per-process UUID path |
| Same, plus `CLAUDE_CODE_DISABLE_ARTIFACT=1` | Absent; the body matches the `sdk-cli` one apart from the label and `session_id` |
| Label `sdk-cli` | Absent in every case |

The gate the CLI applies before adding the line was not identified, so other accounts or CLI versions may add it even with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. The child therefore also sets `CLAUDE_CODE_DISABLE_ARTIFACT=1`, which left these bodies unchanged where the line was absent. The extension does not use native tools, so turning off native artifacts removes nothing it relies on.

### Replayed thinking and the assistant model

Through v0.4.0 the replay restored signed thinking from the carrier, but Claude Code did not send it. A loopback capture with Claude Code 2.1.312 and 2.1.316, Opus 5.5 at effort `high`, and a signature taken from a real session replayed a 14-round tool loop. All 15 thinking blocks were in the replayed frames, and none were in the `/v1/messages` body.

The cause is the assistant frame's `model`. `prepareHistory` sent only `role` and `content`. In the 2.1.316 binary, an assistant message without a string `model` counts as written by another model. The CLI keeps such thinking only when its "foreign thinking" setting allows it. That setting is the `tengu_rustling_pixel` feature flag, overridable with `CLAUDE_CODE_RUSTLING_PIXEL` (`all`, `upgrade` or `none`). It is `none` when `ANTHROPIC_BASE_URL` is not a first-party URL, as with this transport's relay. With the carrier's `model` on each restored frame, the same capture sent all 15 blocks.

Prompt caching was not affected: the stripping was the same on every call, so the warm-turn measurements above still read the previous request. The model, however, did not see its earlier reasoning, as in [hermes-official-plugins#40](https://github.com/NousResearch/hermes-official-plugins/issues/40). Hermes replays the stored native message, `model` included, so it does not hit this.

A paid run through the real API then checked the fix: Claude Code 2.1.316, `claude-haiku-5-5` at effort `high`, and a two-round tool loop calling `streamClaudeNative` directly. A logging proxy recorded only status and counts.

| Call | Status | Earlier assistant messages | Thinking blocks sent | Cache-read tokens | Cache-write tokens |
|---|---:|---:|---:|---:|---:|
| 1 | 200 | 0 | 0 | 0 | 0 |
| 2 | 200 | 1 | 1 | 0 | 901 |
| 3 | 200 | 2 | 2 | 901 | 360 |

The API accepted the replayed signed thinking, and call 3 read call 2's whole request. Call 1 wrote nothing, which suggests its prompt was below the model's minimum cacheable length.

Claude Code 2.1.318 "Removed the 2.1.288 fix that kept the model's earlier thinking when resuming a conversation started on 2.1.286 or earlier; that thinking can now be dropped." The paid check was repeated on 2.1.318 on 2026-11-05, with the same model, effort and proxy. A fourth call asked a follow-up question after the tool loop.

| Call | Status | Earlier assistant messages | Thinking blocks sent | Thinking blocks returned | Cache-read tokens | Cache-write tokens |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 200 | 0 | 0 | 0 | 545 | 0 |
| 2 | 200 | 1 | 0 | 0 | 919 | 0 |
| 3 | 200 | 2 | 0 | 1 | 979 | 0 |
| 4 | 200 | 3 | 1 | 1 | 979 | 175 |

Calls 1 and 2 returned no thinking, so calls 2 and 3 had none to send. The thinking returned by call 3 was sent with call 4 and accepted. Call 1 read a prefix that an earlier attempt with the same transcript had written.

So on 2.1.318, replayed signed thinking is still sent and accepted. The transcript was built for this check, not started on Claude Code 2.1.286 or earlier, so the case the change names was not tested. This transport replays history over stdin on every call instead of resuming a Claude Code session file, so the change most likely does not apply to it; that is an inference, not a measurement.

### Mid-conversation system messages (earlier fork rewrite)

These measurements used the fork's former opt-in relay rewrite (`PI_DIRECTSDK_MID_CONVERSATION_SYSTEM=1`, fork #12). It was removed in fork #18 in favour of upstream v0.2.0's tool changes, which send the same kind of request: the initial prompt and tools, a deferred placeholder, and later changes as `role: system` messages. The numbers below were not re-measured with upstream's implementation.

Without either, a later Pi prompt or tool change rewrites the leading prompt and tool list, and the next call misses the whole cache. On Claude Code 2.1.303, the CLI ignored `type: "system"` lines on stream-json input and rejected `role: "system"` inside a user line, so the change cannot reach the API through the CLI, and the admitted request has to be rewritten in the relay.

A loopback capture covered three changes after the first call: a section update with an added tool, a removed tool, and a redefined tool. For additions and removals, the leading system blocks and the tool-list prefix stayed identical across calls, and each request's prefix through its message breakpoint replayed unchanged. A redefined tool fell back to the current tool list, as designed. Haiku 4.5, which has no mid-conversation system messages, was forwarded collapsed.

Three approved paid requests went through the provider path with `claude-haiku-5-5`. A prompt section change and an added tool came between calls 1 and 2:

| Request | What happened | Cache-read tokens | Cache-write tokens | Uncached input |
|---|---|---:|---:|---:|
| 1 | Initial tools | 0 | 7,795 | 493 |
| 2 | Section changed, tool added; the model called the added tool | 7,795 | 350 | 151 |
| 3 | Tool result returned; final answer | 8,145 | 215 | 2 |

The added tool was declared with `defer_loading` and activated by `tool_addition`; the model called it through the inert MCP server. Each request admitted one upstream request. Opus 5.5 and Sonnet 5.5 produced the same request shape in the loopback capture, but only Haiku 5.5 was measured on the subscription route.

### Tools defined by value (`inline-tools-2026-09-15`)

Since #56, later tools are defined by value in `tool_addition` blocks instead of being declared up front with `defer_loading`, and the admitted request carries the `inline-tools-2026-09-15` beta value. The tool list is the initial tools plus the placeholder for the whole conversation, so a tool redefined under the same name no longer falls back to the current tool list.

A loopback capture with Claude Code 2.1.318 showed that the CLI sends `mid-conversation-tool-changes-2026-07-01` on its own and forwards the request body unchanged; the relay appends `inline-tools-2026-09-15`.

Three approved paid requests ran on 2026-11-05 with `claude-haiku-5-5` and Claude Code 2.1.318, through `streamClaudeNative`, first on this change and then with the same transcript on `main`. The initial tools were `alpha` and `gamma`. Before request 2, `alpha` was redefined with a new required `mode` field and `beta` was added; before request 3, `gamma` was removed.

| Request | What happened | This change: cache read / write | `main`: cache read / write |
|---|---|---:|---:|
| 1 | Initial tools | 0 / 623 | 623 / 0 |
| 2 | `alpha` redefined, `beta` added; the model called `alpha` with `mode` | 623 / 344 | 0 / 984 |
| 3 | Tool result returned, `gamma` removed; final answer | 967 / 546 | 0 / 996 |

The model's call used the new required field, so the redefinition reached it. On `main`, request 1 read the prefix the first run wrote, and requests 2 and 3 each missed the whole cache. With this change, each request read everything the previous one wrote. The prompts were small, so the token counts are small; the read/miss pattern is the result.

### Interactive sessions after the trimmed-result fix

At commit `1fa1c48`, two fresh interactive Pi 1.3.0 sessions ran with the earlier mid-conversation opt-in enabled and Claude Code 2.1.303, driven through the Herdr terminal multiplexer. Across 31 requests, `nativeContext` reported no skipped restoration and `midConversation` reported no fallback. The first user turn after a tool loop read 99.4% from cache after 12 Haiku 5.5 tool calls, and 99.0% after 10 Sonnet 5.5 tool calls.

These sessions did not reproduce the long thinking/tool-loop miss ([#10](https://github.com/yamatakeru/pi-claude-directsdk/issues/10)), but they were too short to rule it out. They were one-off checks and are not part of the permanent harness.

### Paid verification of the repair

Three approved requests ran sequentially through one Pi RPC process with the historical anchor and shared connection pools enabled. All three succeeded, each admitted one upstream request, and the process produced no stderr. Auto-retry and auto-compaction remained disabled.

| Turn | RPC prompt to settled | Provider completion | Cache-read tokens | Cache-write tokens | Cache-read share | HTTPS connection reused |
|---|---:|---:|---:|---:|---:|---|
| 1 | 3,312.022 ms | 3,192.764 ms | 2,951 | 111,010 | 2.59% | No |
| 2 | 3,154.486 ms | 3,139.958 ms | 113,576 | 464 | 99.59% | Yes |
| 3 | 1,731.962 ms | 1,714.062 ms | 113,772 | 332 | 99.71% | Yes |

The Pi system prompt, native system blocks, and native tool definitions had identical content hashes across these three calls. Native requests contained 93, 95, and 97 messages. Each had four one-hour breakpoints, including the historical anchor before the final user frame and native tail.

The first turn wrote the large prefix. The following turns read almost all input from cache and wrote only a small suffix. This confirms that the repaired request path can reuse historical content, rather than only system instructions and tool definitions.

The starting session file had grown to 1,520,559 bytes. Its replay prepared 91, 93, and 95 frames, compared with 119, 121, and 123 frames in the earlier cache investigation. Request bodies were 264,370, 264,730, and 265,028 bytes, not the earlier approximately 530 KB bodies. These are different replay workloads, not a controlled before-and-after latency comparison.

The earlier warm cache-read share was approximately 3.65%; the repaired workload achieved more than 99.5% on both warm turns. Treat this as evidence of successful warm reuse, not an exact workload-matched improvement ratio. Output counts also differed: 210, 235, and 21 tokens. Neither cache reuse nor connection pooling alone explains the timing differences.

### Connection reuse and remaining lifecycle verification

The relay now uses shared HTTP and HTTPS agents, with at most two idle sockets per destination and no shared admission state or request headers. Request cleanup destroys an active upstream request, not pooled sockets from completed requests. Downstream-close listeners are removed when upstream forwarding settles, and the stream removes its relay-abort listener on failure as well as success.

Diagnostics now report whether Node reused an upstream socket and separate response-header arrival from first response data. These measurements do not isolate DNS or TLS time, and headers-to-first-data is not necessarily time to the first generated token.

TypeScript checking, whitespace checking, and the existing offline startup verification passed. The paid batch verified normal successful HTTPS reuse across request-scoped child processes. Dedicated cancellation and late-cleanup checks have not run. The post-fix batch used exactly the three additional approved paid requests; no further paid calls were made.


## Subsequent lifecycle and benchmark changes

Subprocess writes and child-closure waits now have request-timeout bounds. Read timeouts remove the correct waiter and terminate the child. Cancellation rejects pending reads and writes, and discovery cleanup releases its server and temporary directory even after an exit-observation failure. The completion gate before executable tool calls is unchanged.

Model-request children now use a persistent, empty, private cache directory rather than a new temporary directory per Pi process. See [architecture.md](architecture.md#native-working-directory-srcchild-cwdts) for paths and validation. This removes a changing directory path from native context. The Linux cross-restart verification below measured successful reuse.

The supported `warm` scenario now reproduces the three-turn same-process measurement through installed Pi. It has an explicit three-request budget, private configuration and session cleanup, no-tool enforcement, and a no-model-request dry run. See [testing.md](testing.md#same-process-warm-cache-measurement).

TypeScript checking, compilation, Python and observer syntax checks, offline startup, and RPC dry-run preparation passed. A complete-session loopback-only refusal probe completed 86 historical acknowledgments and reached the deliberately blocked upstream. Both native children exited, and the persistent child directory stayed empty with mode `0700`. That probe verifies replay and failure cleanup, not successful generation. Its model call failed as expected; no paid request was made.

The earlier measured 99.59% and 99.71% warm-cache shares are from before these subsequent changes. Subsequent Linux verification covered deadlines, cancellation, and successful cache reuse across a Pi restart, as described below.


## Linux lifecycle and cross-restart verification

The background verification completed successfully in 19.7 seconds. It used temporary verification programs outside the repository and exactly three approved paid requests.

### Forced stalls and cancellation

Temporary Node child programs exercised the public subprocess supervisor with real Linux pipes and process groups. They did not emulate model responses or contact an API.

- Stalled stdin writes, silent stdout reads, and child-exit waits timed out with a 300 ms supervisor limit.
- Whole-case durations, including child startup and cleanup, were 409, 393, and 405 ms, respectively.
- Cancellation during a blocked write, pending read, and exit wait completed each whole case in 103, 101, and 103 ms.
- Each case confirmed that the parent and its descendant were no longer running.
- The pre-fix supervisor lacked the write and exit deadlines. Those two regression controls reached the independent 800 ms safety guard instead, then were terminated.

These checks verify the Linux supervisor's timeout and cancellation behavior. They are not a complete Pi tool-execution cancellation test or a dedicated relay late-cleanup test.

### Cache reuse after restarting Pi

One installed Pi RPC process forked a private snapshot and completed two requests. It then exited. A second Pi RPC process resumed the saved private session and completed the third request. Both processes used the same copied agent directory, working folder, model, and empty native working directory. Auto-retry, auto-compaction, idle warming, and tool execution were disabled for verification.

| Request | Phase | Cache-read tokens | Cache-write tokens | Cache-read share | HTTPS connection reused | RPC prompt to settled |
|---|---|---:|---:|---:|---|---:|
| 1 | Cold | 2,951 | 194,728 | 1.49% | No | 3,347.356 ms |
| 2 | Same-process warm | 197,137 | 610 | 99.69% | Yes | 5,193.948 ms |
| 3 | After Pi restart | 197,491 | 310 | 99.84% | No | 3,134.302 ms |

All three requests succeeded and admitted exactly one upstream request each. Pi system-prompt and tool-definition hashes were identical across the restart. Replay prepared 205, 207, and 209 frames, with 102, 103, and 104 historical acknowledgments. Request bodies were 492,536, 492,868, and 493,155 bytes.

The restarted process opened a new HTTPS connection but still read 99.84% of input from the API cache. This verifies that prompt-cache reuse survives a Pi restart under these stable inputs; it does not depend on keeping the old connection or Pi process alive.

Cache hits do not guarantee lower latency. The same-process warm request waited 3,944.553 ms for response headers, despite 99.69% cache-read share. These three timings are not a controlled latency comparison. Legitimate instruction or tool changes, cache lifetime expiry, and upstream eviction can still prevent reuse.
