import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Message, Model, Tool, TranscriptContext } from "@earendil-works/pi-ai/compat";
import { DOCS_SECTION, replaceDocsSections } from "../src/docs-section.ts";
import { PROVIDER_ID } from "../src/models.ts";
import { defaultDeps, streamClaudeNative, type CallDeps } from "../src/stream.ts";
import { prepareNativeTranscript } from "../src/transcript.ts";

/** Pi's default docs section as the transcript stores it, abridged. */
const PI_DOCS = "<docs>\nPi documentation (read only when the user asks about the harness itself):\n" +
  "- When asked about: custom providers (docs/custom-provider.md), adding models (docs/models.md)\n</docs>";
const REPLACED = `<docs>\n${DOCS_SECTION}\n</docs>`;

const read: Tool = { name: "read", description: "read", parameters: { type: "object", properties: {} } };

function system(sections: Record<string, string | null>, extra: Partial<Message> = {}): Message {
  return { role: "system", content: "", sections, timestamp: 0, ...extra } as Message;
}

function assistant(text: string): Message {
  return {
    role: "assistant",
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt",
    content: [{ type: "text", text }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  } as Message;
}

test("replaces Pi's docs section in the leading system message, in place", () => {
  const messages = [
    system({ preamble: "You are Pi.", docs: PI_DOCS, cwd: "<cwd>\n/x\n</cwd>" }),
    { role: "user", content: "hi", timestamp: 1 } as Message,
  ];
  const replaced = replaceDocsSections(messages);
  const head = replaced[0] as Extract<Message, { role: "system" }>;
  assert.deepEqual(Object.entries(head.sections ?? {}), [
    ["preamble", "You are Pi."],
    ["docs", REPLACED],
    ["cwd", "<cwd>\n/x\n</cwd>"],
  ]);
  assert.equal(replaced[1], messages[1]);
});

test("drops a later docs update that the replacement makes redundant", () => {
  const messages = [
    system({ preamble: "You are Pi.", docs: PI_DOCS }, { toolsAdded: [read] }),
    { role: "user", content: "first", timestamp: 1 } as Message,
    assistant("one"),
    // Pi records the hook's replacement when the session moves to Claude Native.
    system({ docs: REPLACED, rules: "<rules>\nnew\n</rules>" }),
    { role: "user", content: "second", timestamp: 2 } as Message,
    assistant("two"),
    // Back on another provider, Pi restores its default; still redundant here.
    system({ docs: PI_DOCS }),
    { role: "user", content: "third", timestamp: 3 } as Message,
  ];
  const replaced = replaceDocsSections(messages);
  assert.deepEqual((replaced[3] as Extract<Message, { role: "system" }>).sections, { rules: "<rules>\nnew\n</rules>" });
  assert.equal("sections" in (replaced[6] as object), false);

  // The native transcript then injects only the rules update.
  const plan = prepareNativeTranscript(replaced, true);
  assert.ok(plan);
  assert.equal(plan.systemInjections.length, 1);
  assert.match(JSON.stringify(plan.systemInjections[0]?.content), /Updated system prompt section \\"rules\\"/u);
});

test("keeps a docs removal and the restore after it", () => {
  const replaced = replaceDocsSections([
    system({ docs: PI_DOCS }),
    system({ docs: null }),
    system({ docs: PI_DOCS }),
  ]);
  assert.deepEqual(replaced.map((message) => (message as Extract<Message, { role: "system" }>).sections), [
    { docs: REPLACED },
    { docs: null },
    { docs: REPLACED },
  ]);
});

test("returns the same history when no system message has a docs section", () => {
  const messages = [system({ preamble: "Custom." }), { role: "user", content: "hi", timestamp: 1 } as Message];
  assert.equal(replaceDocsSections(messages), messages);
});

function model(midConversationTools: boolean): Model<Api> {
  return {
    id: "claude-opus-5",
    name: "Opus",
    api: "claude-native" as Api,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-native",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
    compat: { supportsMidConvoToolChanges: midConversationTools },
  };
}

/** The system prompt file the child would receive; the call stops before the relay starts. */
async function sentSystemPrompt(context: TranscriptContext, midConversationTools: boolean): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "pi-claude-native-docs-"));
  let requestDir = "";
  let prompt: string | undefined;
  try {
    const deps: CallDeps = {
      ...defaultDeps,
      checkCli: () => true,
      makeRequestDir: () => (requestDir = mkdtempSync(join(root, "request-"))),
      createRelay: async () => {
        prompt = readFileSync(join(requestDir, "system.md"), "utf8");
        throw new Error("stop before the relay");
      },
    };
    const stream = streamClaudeNative(model(midConversationTools), context, {
      timeoutMs: 5_000,
      env: { PI_CLAUDE_NATIVE_COMMAND: process.execPath },
    }, deps);
    for await (const _event of stream) { /* drain */ }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(prompt !== undefined, "the request reached the relay");
  return prompt;
}

test("a session started on another provider sends the replacement with its first prompt", async () => {
  // Native tool changes send the leading system message as the prompt (#28).
  const prompt = await sentSystemPrompt({
    messages: [
      system({ preamble: "You are Pi.", docs: PI_DOCS }, { toolsAdded: [read] }),
      { role: "user", content: "first", timestamp: 1 } as Message,
      assistant("one"),
      system({ docs: REPLACED }),
      { role: "user", content: "second", timestamp: 2 } as Message,
    ],
  }, true);
  assert.ok(prompt.includes(DOCS_SECTION));
  assert.equal(prompt.includes("docs/custom-provider.md"), false);
});

test("a side request made while another provider is current sends the replacement", async () => {
  // No tools: the collapsed prompt applies every section update in order.
  const prompt = await sentSystemPrompt({
    messages: [
      system({ preamble: "You are Pi.", docs: PI_DOCS }),
      { role: "user", content: "question", timestamp: 1 } as Message,
    ],
  }, false);
  assert.ok(prompt.includes(DOCS_SECTION));
  assert.equal(prompt.includes("docs/custom-provider.md"), false);
});
