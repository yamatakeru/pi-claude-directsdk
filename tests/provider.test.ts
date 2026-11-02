import assert from "node:assert/strict";
import test from "node:test";
import type { AnyModel, RefreshModelsContext } from "@earendil-works/pi-ai";
import { createClaudeNativeProvider } from "../src/provider.ts";

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
