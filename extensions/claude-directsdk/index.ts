/** Claude CLI supplies authentication; Pi owns the transcript and tools. */
import { normalizeContext, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { getDocsPath, getExamplesPath, getReadmePath, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDirectSdkProvider, PROVIDER_ID, streamSimple } from "../../src/provider.js";

/**
 * Pi's default prompt routes the model to Pi's docs by name. Anthropic rejects that
 * prompt as third-party app usage when the child reports a client label other than
 * Claude Code's SDK default, so this provider sends the same guidance as prose instead.
 * It keeps the README, docs, and examples paths and routes topics through docs/docs.json,
 * but leaves out the topic-to-path list and Pi's bullet layout, which match the fingerprint (#30).
 */
const DOCS_SECTION =
  "This session runs inside Pi. If the user asks about Pi itself, for example its SDK, extensions, themes, " +
  "skills, or terminal UI, look the answer up in Pi's own files instead of guessing. " +
  `The README is at ${getReadmePath()}, the guides are under ${getDocsPath()}, ` +
  `and runnable samples of extensions, custom tools, and SDK use are under ${getExamplesPath()}. ` +
  "Relative paths such as docs/... or examples/... point into those folders, not into the user's project. " +
  "Open docs/docs.json first: it lists every guide by title, covering subjects like prompt templates, " +
  "TUI components, keybindings, SDK integrations, custom providers, adding models, packages, " +
  "environment variables, MCP servers, and codemode. Before building anything for Pi, read the guides and " +
  "samples that apply, read each guide to the end, and follow the links it gives to related guides.";

export default function (pi: ExtensionAPI) {
  let report = (message: string): void => { console.error(message); };
  pi.on("session_start", (_event, context) => {
    report = context.hasUI
      ? message => context.ui.notify(message, "warning")
      : message => { console.error(message); };
  });
  // Pi can dispatch a selected or overridden model while the live catalog is empty.
  registerApiProvider({
    api: PROVIDER_ID,
    stream: (model, context, options) => streamSimple(model, normalizeContext(context), options as SimpleStreamOptions),
    streamSimple: (model, context, options) => streamSimple(model, normalizeContext(context), options),
  }, PROVIDER_ID);
  // Only this transport reports a custom client label, so other providers keep Pi's prompt.
  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return;
    const options = event.systemPromptOptions;
    // A custom or forced prompt replaces Pi's sections; there is no docs section to swap.
    if (options.customPrompt || options.forceSystemPrompt) return;
    options.sections.docs = DOCS_SECTION;
  });
  pi.on("session_shutdown", () => { unregisterApiProviders(PROVIDER_ID); });
  pi.registerProvider(createDirectSdkProvider(message => report(message)));
}
