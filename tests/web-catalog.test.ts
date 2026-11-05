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
  assert.deepEqual(result.warnings, []);
  assert.equal(result.withheld.length, 1);
  return result.withheld[0]!;
}

const MID_CONVERSATION = `${ROOT}/build-with-claude/mid-conversation-system-messages.md`;

// The shared pages plus Claude Opus 5.5, so a listed name enables every model it names.
const TWO_MODELS: Record<string, string> = {
  ...PAGES,
  [`${ROOT}/about-claude/models/overview.md`]: [
    "[Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview)",
    "[Claude Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview)",
    "",
    "| Feature | Claude Opus 5.5 | Claude Haiku 5.5 |",
    "|---|---|---|",
    "| Claude API ID | claude-opus-5-5 | claude-haiku-5-5 |",
    "",
  ].join("\n"),
  [`${ROOT}/about-claude/pricing.md`]: PAGES[`${ROOT}/about-claude/pricing.md`]!.replace(
    "| Claude Haiku 5.5 |",
    "| Claude Opus 5.5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.5 / MTok | $25 / MTok |\n| Claude Haiku 5.5 |",
  ),
  [`${ROOT}/models/opus-5-5/overview.md`]: PAGES[`${ROOT}/models/haiku-5-5/overview.md`]!.replace("claude-haiku-5-5", "claude-opus-5-5"),
};

async function catalogWithPage(t: test.TestContext, page: string) {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const body = url === MID_CONVERSATION ? page : TWO_MODELS[url];
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  });
  return loadWebCatalog([], new AbortController().signal);
}

const TOOL_CHANGES_BETA = "  [Mid-conversation tool changes](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#mid-conversation-tool-changes) are in beta on the same models.";

for (const [wording, sentence] of [
  // As published on 2026-11-05.
  ["current", "  Mid-conversation system messages are available on Claude Fable 5.1, [Claude Mythos 5.1](https://platform.claude.com/docs/en/models/mythos-5-1/overview), Claude Opus 5.5, and Claude Haiku 5.5. No beta header is required for mid-conversation system messages."],
  ["previous", "  This feature is available on Claude Opus 5.5 and Claude Haiku 5.5."],
] as const) {
  test(`the ${wording} mid-conversation wording turns on tool changes for the listed models`, async (t) => {
    const result = await catalogWithPage(t, ["<Note>", sentence, "", TOOL_CHANGES_BETA, "</Note>", ""].join("\n"));
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.withheld, []);
    assert.deepEqual(result.models.map((model) => [model.id, model.compat]), [
      ["claude-haiku-5-5", { supportsMidConvoToolChanges: true }],
      ["claude-opus-5-5", { supportsMidConvoToolChanges: true }],
    ]);
  });
}

test("a model the mid-conversation list does not name keeps tool changes off", async (t) => {
  const result = await catalogWithPage(t, ["  Mid-conversation system messages are available on Claude Fable 5.1 and Claude Haiku 5.5.", "", TOOL_CHANGES_BETA, ""].join("\n"));
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.withheld, []);
  assert.deepEqual(result.models.map((model) => [model.id, model.compat]), [
    ["claude-haiku-5-5", { supportsMidConvoToolChanges: true }],
    ["claude-opus-5-5", undefined],
  ]);
});

test("a mid-conversation list that does not name models withholds tool changes", async (t) => {
  const result = await catalogWithPage(t, ["  Mid-conversation system messages are available on all models.", "", TOOL_CHANGES_BETA, ""].join("\n"));
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.withheld, ["mid-conversation tool changes: unrecognized model in mid-conversation availability: all models"]);
  assert.deepEqual(result.models.map((model) => model.compat), [undefined, undefined]);
});

test("a mid-conversation page that no longer names its models withholds tool changes", async (t) => {
  const result = await catalogWithPage(t, ["The feature works on recent models.", "", TOOL_CHANGES_BETA, ""].join("\n"));
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.withheld, ["mid-conversation tool changes: missing mid-conversation model availability"]);
  assert.deepEqual(result.models.map((model) => model.compat), [undefined, undefined]);
});

test("an unavailable mid-conversation page withholds tool changes but keeps the catalog", async (t) => {
  const warning = await catalogWithout(t, async () => new Response("", { status: 503 }));
  assert.match(warning, /^mid-conversation tool changes: Cannot load model metadata from .*: HTTP 503$/);
});

test("a stalled mid-conversation page times out on its own and keeps the catalog", async (t) => {
  // AbortSignal.timeout does not keep the event loop alive; a stalled fetch
  // would. The guard holds it open and ends the stall if the deadline is lost.
  const warning = await catalogWithout(t, (signal) =>
    new Promise((_, reject) => {
      const guard = setTimeout(() => reject(new Error("page deadline never fired")), 10_000);
      signal.addEventListener("abort", () => {
        clearTimeout(guard);
        reject(signal.reason);
      });
    }));
  assert.match(warning, /^mid-conversation tool changes: Cannot load model metadata from .*: The operation was aborted due to timeout$/);
});
