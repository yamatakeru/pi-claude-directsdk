import assert from "node:assert/strict";
import test from "node:test";
import { loadWebCatalog } from "../src/web-catalog.ts";

const ROOT = "https://platform.claude.com/docs/en";
const PAGES: Record<string, string> = {
  [`${ROOT}/about-claude/models/overview.md`]: [
    "[Claude Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview)",
    "",
    "| Feature | Claude Haiku 5.5 |",
    "|---|---|",
    "| Claude API ID | claude-haiku-5-5 |",
    "",
  ].join("\n"),
  [`${ROOT}/about-claude/pricing.md`]: [
    "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |",
    "|---|---|---|---|---|---|",
    "| Claude Haiku 5.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.1 / MTok | $5 / MTok |",
    "",
    "| Cache operation | Multiplier | Duration |",
    "|---|---|---|",
    "| 5-minute cache write | 1.25x | Cache valid for 5 minutes |",
    "| 1-hour cache write | 2x | Cache valid for 1 hour |",
    "",
  ].join("\n"),
  [`${ROOT}/build-with-claude/effort.md`]: [
    "| Level | Notes |",
    "|---|---|",
    "| max | Available on Claude Haiku 5.5. |",
    "| xhigh | Available on Claude Haiku 5.5. |",
    "| high | Default. |",
    "| medium | |",
    "| low | |",
    "",
  ].join("\n"),
  [`${ROOT}/models/haiku-5-5/overview.md`]: [
    "| Model | ID |",
    "|---|---|",
    "| Claude API | claude-haiku-5-5 |",
    "",
    "| Feature | Value |",
    "|---|---|",
    "| Input → output | Text and images → text |",
    "| Thinking | Adaptive |",
    "| Default effort | high |",
    "| Context window | 200K tokens |",
    "| Max output | 64K tokens |",
    "",
  ].join("\n"),
};

async function catalogWithout(
  t: test.TestContext,
  missing: (signal: AbortSignal) => Promise<Response>,
) {
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const page = PAGES[url];
    return page === undefined ? missing(init!.signal!) : new Response(page);
  });
  const result = await loadWebCatalog([], new AbortController().signal);
  assert.deepEqual(result.models.map((model) => model.id), ["claude-haiku-5-5"]);
  assert.equal(result.models[0]?.compat, undefined);
  assert.equal(result.warnings.length, 1);
  return result.warnings[0]!;
}

test("an unavailable mid-conversation page withholds tool changes but keeps the catalog", async (t) => {
  const warning = await catalogWithout(t, async () => new Response("", { status: 503 }));
  assert.match(warning, /^mid-conversation tool changes: Cannot load model metadata from .*: HTTP 503$/);
});

test("a stalled mid-conversation page times out on its own and keeps the catalog", async (t) => {
  // AbortSignal.timeout does not keep the event loop alive; a stalled fetch would.
  const warning = await catalogWithout(t, (signal) =>
    new Promise((_, reject) => {
      const pending = setInterval(() => {}, 1_000);
      signal.addEventListener("abort", () => {
        clearInterval(pending);
        reject(signal.reason);
      });
    }));
  assert.match(warning, /^mid-conversation tool changes: Cannot load model metadata from .*: The operation was aborted due to timeout$/);
});
