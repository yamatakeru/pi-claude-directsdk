# Pi's cache warming uses the lifetime the child writes

Pi 1.5 refreshes a prompt cache before it expires when a model declares `promptCache`. Claude Native declared the pricing page's lifetimes, `{short: 300, long: 3600}`. Pi's default tier is `short`, so Pi assumed 5 minutes and sent refreshes 4.5 minutes after each request. The child writes the 1-hour cache, so those refreshes were not needed. They also failed: Pi refreshes with a one-token output limit, and Claude Native reported a thinking-only `max_tokens` stop as an error. Pi drops failed refreshes without a record (#89).

## Decision

- **Lifetime.** Each published model declares the lifetime that the replay anchor and the child use:
  - 3,600 seconds for `1h`, the default;
  - 300 seconds for `5m`, set by `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` or `FORCE_PROMPT_CACHING_5M`.

  Both of Pi's tiers get the same value, because the child's TTL does not follow Pi's `cacheRetention`. When caching is off globally or for the model's family, or the TTL setting is invalid, the model declares nothing and Pi does not warm it. The request path still reports an invalid setting.
- **Where.** The provider applies the lifetime whenever it publishes models, from a live refresh or a stored snapshot. A snapshot saved with older lifetimes is corrected when it is restored.
- **One-token limit.** When Pi asks for one output token, a thinking-only `max_tokens` stop returns `length`, as it does from Pi's own Anthropic provider. Every other thinking-only `max_tokens` stop still fails with its cause.
  - A loopback check showed the outgoing request is unchanged: `max_tokens: 1` with adaptive thinking.
  - Claude Code retried that stop three times; the relay denies the retries.

## Considered options

- **Declaring no lifetime.** This turns warming off and would end the failed refreshes. It also removes warming for anyone who chose `5m`, and leaves one-token requests failing. Rejected.
- **Treating Pi's `short` tier as 5 minutes.** This would change the default TTL away from Claude Code's own default on a subscription, which is 1 hour within usage limits. Rejected.
- **Leaving the TTL to Claude Code, and reading it from the child's request in the relay.** Without an explicit TTL, Claude Code 2.1.322 chose `1h` on its own behind the relay in a loopback check. That choice depends on a remotely configured allowlist (`tengu_prompt_cache_1h_config`), so dropping the explicit TTL would change nothing today and add a dependency on the request shape. Rejected; the child keeps an explicit `CLAUDE_CODE_PROMPT_CACHE_TTL`.
- **Recognizing Pi's refresh by all of its options** (one output token, no retries, no continuation). The extra options say nothing about the answer the caller expects, and a change to them in Pi would make refreshes fail again without notice. Rejected.

## Consequences

- With the default `1h`, Pi plans a refresh 54 minutes after a request. That is past Pi's 30-minute idle limit, and the next one would be past Pi's one-hour limit. So there is at most one refresh per request, during a single tool run longer than 54 minutes.
- With `5m`, refreshes run every 4.5 minutes during long tool runs. They also run between runs when Pi expects them to pay for themselves.
- Pi's cache-miss notices do not read `promptCache`. They work as before.
- The declaration reads Pi's process environment. A request also merges `options.env`. Pi does not pass `options.env` for session requests, so the two match in practice.
- Two points are unverified:
  - whether Claude Code switches to `5m` on its own while extra usage is in use;
  - how the real API answers a one-token refresh through this provider. The earlier `claude-directsdk` provider recorded 53 successful one-token refreshes.
  - whether a one-token refresh keeps the cache on a model with budget-based thinking, whose budget follows the output limit. Pi skips such models for its own Anthropic provider. The loopback check covered adaptive thinking only.
