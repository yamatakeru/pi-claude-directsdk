import assert from "node:assert/strict";
import test from "node:test";
import type { AnyModel, RefreshModelsContext } from "@earendil-works/pi-ai";
import { createClaudeNativeProvider } from "../src/provider.ts";
import { declaredPromptCache } from "../src/prompt-cache.ts";
import { buildChildEnv } from "../src/request.ts";

const base = {
  provider: "claude-native",
  baseUrl: "process://claude-native",
  input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
} as const;

test("an offline start restores only chat models from the snapshot", async () => {
  const stored: AnyModel[] = [
    { ...base, id: "claude-chat", name: "Chat", api: "claude-native", reasoning: true, contextWindow: 1, maxTokens: 1 },
    { ...base, id: "painter", name: "Painter", api: "openai-images", type: "image", output: ["image"] },
  ] as AnyModel[];
  const provider = createClaudeNativeProvider(() => {});
  const context = {
    signal: new AbortController().signal,
    allowNetwork: false,
    force: false,
    stored: { models: stored, checkedAt: 1 },
    publish: async ({ update }: { update: () => void }) => { update(); return true; },
  } as unknown as RefreshModelsContext;
  await provider.refreshModels!(context);
  const models = provider.getModels!();
  assert.deepEqual(models.map(model => [model.id, model.name]), [["claude-chat", "Chat (last verified snapshot)"]]);
});

const CACHE_ENV = [
  "CLAUDE_CODE_PROMPT_CACHE_TTL", "FORCE_PROMPT_CACHING_5M", "DISABLE_PROMPT_CACHING", "DISABLE_PROMPT_CACHING_HAIKU",
];

function withCacheEnv(t: test.TestContext, values: Record<string, string>): void {
  const saved = CACHE_ENV.map(name => [name, process.env[name]] as const);
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of CACHE_ENV) delete process.env[name];
  Object.assign(process.env, values);
}

test("declares the prompt cache lifetime the child writes", () => {
  const cases: Array<[Record<string, string>, { short: number; long: number } | undefined]> = [
    [{}, { short: 3600, long: 3600 }],
    [{ CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" }, { short: 300, long: 300 }],
    [{ FORCE_PROMPT_CACHING_5M: "1" }, { short: 300, long: 300 }],
    [{ DISABLE_PROMPT_CACHING: "1" }, undefined],
    [{ DISABLE_PROMPT_CACHING_HAIKU: "1" }, undefined],
    // The request path reports an invalid value; the catalog must not throw.
    [{ CLAUDE_CODE_PROMPT_CACHE_TTL: "2h" }, undefined],
  ];
  for (const [env, expected] of cases) {
    assert.deepEqual(declaredPromptCache(env, "claude-haiku-5-5"), expected, JSON.stringify(env));
    if (expected) {
      const child = buildChildEnv({ baseEnv: env, relayUrl: "http://127.0.0.1:1", body: {} });
      assert.equal(child["CLAUDE_CODE_PROMPT_CACHE_TTL"], expected.short === 3600 ? "1h" : "5m");
    }
  }
  assert.deepEqual(declaredPromptCache({ DISABLE_PROMPT_CACHING_HAIKU: "1" }, "claude-opus-5-5[1m]"), { short: 3600, long: 3600 });
});

test("a restored snapshot carries the current lifetime, not the stored one", async (t) => {
  withCacheEnv(t, { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m", DISABLE_PROMPT_CACHING_HAIKU: "1" });
  const stored = ["claude-haiku-5-5", "claude-opus-5-5"].map(id => ({
    ...base, id, name: id, api: "claude-native", reasoning: true, contextWindow: 1, maxTokens: 1,
    promptCache: { short: 300, long: 3600 },
  })) as AnyModel[];
  const provider = createClaudeNativeProvider(() => {});
  await provider.refreshModels!({
    signal: new AbortController().signal,
    allowNetwork: false,
    force: false,
    stored: { models: stored, checkedAt: 1 },
    publish: async ({ update }: { update: () => void }) => { update(); return true; },
  } as unknown as RefreshModelsContext);
  const lifetimes = Object.fromEntries(provider.getModels!().map(model => [model.id, model.promptCache]));
  assert.deepEqual(lifetimes, { "claude-haiku-5-5": undefined, "claude-opus-5-5": { short: 300, long: 300 } });
});
