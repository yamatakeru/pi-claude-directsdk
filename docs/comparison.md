# Comparison with pi-claude-bridge

[pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) is the closest alternative: both expose Claude as a Pi provider and let Pi execute provider tools. DirectSDK prioritizes request isolation and Pi-owned state. Bridge uses the official Agent SDK and adds optional delegation to Claude agents.

This comparison was reviewed before the v0.1.7 release, when DirectSDK reported package version 0.1.6 on `main`. It compares that transport with [Bridge source at `b2e7255`](https://github.com/elidickinson/pi-claude-bridge/tree/b2e7255ece0b8bfd3a6429fd5c147fd59984c785), reviewed on October 13, 2026. It is a source and documentation comparison, not a head-to-head benchmark.

| Dimension | DirectSDK | pi-claude-bridge |
|---|---|---|
| Transport and agent loop | Unmodified Claude CLI behind a local admission relay. Each Pi model call admits at most one upstream Messages request. | Official Agent SDK `query()`. An active query continues across Pi tool boundaries. |
| Tool execution | Inert MCP advertises tools but never executes them. Pi receives executable calls only after the upstream response completes and the child exits. Native tools are disabled. | MCP handlers wait for Pi to execute tools and return results to the active query. Native tools are disabled in provider mode. |
| System prompt | Supplies Pi's current system prompt through `--system-prompt-file` on every call. Claude Code can still add native context. | Uses the Claude Code prompt preset with selected Pi context, skills, and instructions appended. Some injection routes are unsupported, and resumed sessions can retain earlier instructions. |
| Conversation state | Reconstructs each request from Pi's current transcript, including native signed thinking when its stored projection still matches. No Claude session mirror. | Resumes a Claude session that mirrors Pi's history. Divergence, compaction, and some recovery paths require synchronization or rebuilding. |
| Process lifecycle | Fresh Claude process and serialized history replay for every Pi model call, including calls after tool execution. | Keeps the SDK query active across tool boundaries. Later user turns start a new query that can resume the saved session. |
| Prompt caching | Explicit historical cache anchor, matching cache lifetimes, stable empty native working directory, and reuse diagnostics. | Uses Claude Code caching and session resume, and suppresses changing Git instructions to stabilize the prefix. Its README reports cache misses after session rebuilds. |
| Connection reuse | Shared HTTP/HTTPS keep-alive agents, with at most two idle sockets per destination. Pools do not survive Pi restart. | Networking is handled by the SDK and Claude Code; the provider has no equivalent custom pooling layer. This does not establish that connections are not reused. |
| Authentication guards | Uses CLI login or a CLI setup token. Rejects conflicting API credentials, base URLs, and alternative backend settings rather than switching billing routes. Stops after a reported usage-credit overage unless `CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS=1` is set. | Uses Claude Code authentication through the SDK. Its README warns that inherited Anthropic API environment variables can redirect the child. |
| Startup and models | Cache-only startup and lazy transport loading. Refresh combines the CLI account picker with Anthropic documentation to validate model metadata. | Registers models from Pi's Anthropic catalog, with plan and context-window settings. |
| Compatibility and maintenance | Qualifies CLI versions `>=2.1.263 <2.2.0`; maintains replay, admission, SSE parsing, schema translation, and child supervision. | Uses a versioned Agent SDK dependency, with an optional external CLI. Maintains session synchronization, prompt projection, and MCP tool bridging. |
| Verification | Offline regression suite plus installed-Pi startup checks, documented paid replay and cache measurements, and lifecycle checks. The offline suite does not replace real-upstream checks. | Provides offline unit tests and API-backed integration tests. Test availability alone does not prove greater reliability. |
| Additional features | Focused inference provider. | Optional `AskClaude` delegation, including read-only and full native-tool modes. |

The current DirectSDK branch also keeps later system messages on models whose metadata supports mid-conversation tool changes. It sends the initial tools, a deferred placeholder, later additions with `defer_loading: true`, and `tool_addition`/`tool_removal` blocks at assistant boundaries. Unsupported models keep the collapsed shape. The Bridge column reflects the reviewed snapshot and was not re-reviewed for this change.

### Cache evidence is not a speed comparison

The [transport measurements](transport-measurements.md) report **99.59% and 99.71% cache-read share on two warm turns**, plus **99.84% after restarting Pi** in a separate Linux verification. These results show that reconstructing history can preserve prompt-cache reuse under stable inputs. They are repository-reported measurements, not independently reproduced results, and do not measure subscription allowance deductions.

The original 30-run baseline reported a **2,345.663 ms median provider completion**, including a **436.408 ms median child-spawn-to-replay interval**. It predates the cache repair and uses a different workload from the later cache checks. It does not demonstrate a post-fix speedup. No matched Bridge benchmark was established in this review, so there is no measured overall speed winner.

### Subscription and policy limits

Using the official CLI or SDK does not, by itself, establish Anthropic approval of either extension. Anthropic's [subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) states that Agent SDK, `claude -p`, and third-party app usage can still draw from subscription limits. Its [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview) separately says that third-party developers need prior approval to offer claude.ai login or rate limits in their products. These statements address different conditions; neither establishes project-specific approval or explicitly endorses DirectSDK's HTTP admission relay. Billing and policy guidance can change.

### Which to choose

Choose DirectSDK when you want Pi's current transcript and prompt to determine every request, with no mirrored Claude session and a hard one-request boundary. The trade-off is repeated child startup and history replay, plus custom transport maintenance.

Choose Bridge when you prefer the official SDK interface, query continuation across tool boundaries, or optional Claude-agent delegation. The trade-off is mirrored-session recovery and a Claude Code instruction environment rather than direct forwarding of Pi's full system prompt. See its [compatibility notes and known issues](https://github.com/elidickinson/pi-claude-bridge/blob/b2e7255ece0b8bfd3a6429fd5c147fd59984c785/README.md#compatibility-with-other-extensions) before relying on prompt injection or session rebuild behavior.

