import assert from "node:assert/strict";
import test from "node:test";
import { getDocsPath, getExamplesPath, getReadmePath, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import createExtension from "../extensions/claude-native/index.ts";
import { PROVIDER_ID } from "../src/models.ts";

/** Pi 1.5.0's docs section, abridged; its topic-to-path list is what Anthropic's server treats as a third-party app fingerprint. */
const PI_DOCS = [
  "Pi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):",
  "- When asked about: custom providers (docs/custom-provider.md), adding models (docs/models.md), packages (docs/packages.md), " +
    "codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)",
  "- Before implementing harness changes, read the relevant docs and examples in full, following related cross-references.",
].join("\n");

type PromptOptions = {
  customPrompt?: string;
  forceSystemPrompt?: string;
  sections: Record<string, string>;
};

function docsSectionAfterStart(
  provider: string | undefined,
  options: PromptOptions,
): string | undefined {
  const handlers = new Map<string, (event: unknown, context: unknown) => void>();
  const api = {
    on(event: string, handler: (event: unknown, context: unknown) => void): void {
      handlers.set(event, handler);
    },
    registerProvider(): void {},
    unregisterProvider(): void {},
  } as unknown as ExtensionAPI;
  createExtension(api);
  const handler = handlers.get("before_agent_start");
  assert.ok(handler, "extension registers a before_agent_start handler");
  handler({ systemPromptOptions: options }, provider === undefined ? {} : { model: { provider } });
  return options.sections["docs"];
}

test("a Claude Native turn sends Pi's docs guidance without the routing line", () => {
  const docs = docsSectionAfterStart(PROVIDER_ID, { sections: { docs: PI_DOCS } });
  assert.ok(docs, "the docs section is still present");
  assert.notEqual(docs, PI_DOCS);
  assert.equal(/docs\/[\w-]+\.md/u.test(docs), false, "no topic-to-path list");
  assert.equal(/pi packages/iu.test(docs), false);
  for (const path of [getReadmePath(), getDocsPath(), `${getExamplesPath()}/extensions`, "docs/docs.json"]) {
    assert.ok(docs.includes(path), `points to ${path}`);
  }
});

test("the replacement keeps what docs/docs.json titles cannot carry", () => {
  const docs = docsSectionAfterStart(PROVIDER_ID, { sections: { docs: PI_DOCS } })!;
  // docs.json titles the guide only "Codemode", so the route for these questions must be stated.
  assert.match(docs, /codemode guide also covers classifiers, image models/u);
  // Pi reads its docs only for questions about itself.
  assert.match(docs, /other tasks do not need them/u);
});

test("another provider keeps Pi's default docs section", () => {
  const docs = docsSectionAfterStart("anthropic", { sections: { docs: PI_DOCS } });
  assert.equal(docs, PI_DOCS);
});

test("a custom or forced prompt is left alone", () => {
  for (const options of [{ customPrompt: "Be brief.", sections: {} }, { forceSystemPrompt: "Be brief.", sections: {} }]) {
    assert.equal(docsSectionAfterStart(PROVIDER_ID, options), undefined);
    assert.equal("docs" in options.sections, false);
  }
});
