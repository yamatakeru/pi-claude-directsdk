# Roadmap

Protect DirectSDK's request boundaries, measure its remaining overhead, and evaluate whether the Anthropic Agent SDK can reduce maintenance without changing Pi ownership.

These stages are ordered. Persistent Claude sessions and an SDK migration are not committed changes.

## 1. Add focused regression coverage

Build repeatable checks for the behavior that distinguishes DirectSDK:

- Admit at most one upstream Messages request per Pi model call.
- Keep tool execution in Pi, with no native tool execution.
- Publish executable tool calls only after a complete upstream response and child exit.
- Replay Pi history faithfully, including tool associations and valid native signed thinking.
- Forward Pi's current system prompt on every call.
- Reject conflicting authentication routes and alternative backend settings.
- Bound subprocess waits and clean up the process tree on cancellation or failure.
- Preserve historical cache-anchor metadata and compatible cache lifetimes.

Prefer a small set of public-boundary checks using real subprocesses and local endpoints over tests coupled to internal implementation. Review and approve each proposed test before adding it.

Current coverage: `npm test` checks admission, replay carriers, environment guards, the usage-credit guard, and the tool-change plan. It uses a fake native child and loopback endpoints. Real-upstream beta acceptance, cancellation, and process-tree behavior remain installed-Pi or manual checks.

Keep routine regression checks offline and free of subscription usage. Use a small, explicitly approved paid verification path for behavior that requires real Claude generation or upstream cache reuse. Local request inspection cannot establish a real cache hit.

Completion criteria: the agreed checks run repeatably, detect violations of these guarantees, and clearly separate offline coverage from paid verification. Document remaining gaps in [testing.md](testing.md).

## 2. Measure and optimize remaining startup and replay overhead

The cache repair, connection pooling, and stable native working directory address different sources of overhead and cache invalidation. They do not remove the fresh Claude process or serialized history replay on every Pi model call.

The [transport measurements](transport-measurements.md) demonstrate high warm-cache reuse, including across a Pi restart. The original 436.408 ms median child-spawn-to-replay interval predates subsequent changes. It is not a current estimate or a measured comparison with Bridge.

Measure the current implementation before changing its lifecycle:

- Separate child startup and replay, upstream response delay, and completion cleanup where observable.
- Cover short sessions, long sessions, and tool-loop workloads.
- Record model, CLI and Pi versions, transcript size, replay counts, output size, and cache conditions.
- Compare cold, same-process warm, and cross-restart behavior without treating cache-read share as a latency or billing measurement.
- If comparing with [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge), use matched Pi sessions, models, instructions, tools, and output requirements. Record unavoidable differences.

Paid measurements require explicit approval and a bounded request budget. Start with the narrowest workload that answers the decision.

Decision gate: optimize the measured bottleneck while preserving request isolation and Pi-owned state. Consider persistent sessions only if measured benefits justify session synchronization and a change to the current lifecycle contract. Approve that architectural trade-off before implementation.

Completion criteria: publish reproducible measurements with limitations, identify whether local startup and replay materially affect user-visible latency, and select a targeted change or retain the current lifecycle.

## 3. Evaluate delegation to the Anthropic Agent SDK

Investigate whether the [official Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) can remove meaningful transport plumbing. Treat this as a feasibility study, not a migration commitment.

Any candidate must preserve:

- Pi's current transcript and system prompt as authoritative inputs.
- Pi-only tool execution.
- At most one upstream Messages request per model call.
- Explicit authentication-route guards, with no silent billing-route fallback.
- Bounded cancellation, process cleanup, and complete-response validation before executable tool calls.

Identify which existing responsibilities the SDK would replace and which would remain custom. Assess replay and signed-thinking support, prompt behavior, request admission, networking, process lifecycle, and version compatibility. Separate documented SDK guarantees from behavior observed in a prototype.

Review current Anthropic authentication and subscription guidance separately. An official SDK dependency does not establish project-specific approval.

Decision gate: adopt the SDK only if it reduces maintenance without weakening the agreed behavior. If the relay and replay machinery must remain, account for the added dependency and integration layer before recommending migration. Any proposal to weaken a guarantee requires explicit approval.

Completion criteria: document the supported guarantees, remaining custom plumbing, verification gaps, and a recommendation to adopt, prototype further, or retain the CLI transport.
