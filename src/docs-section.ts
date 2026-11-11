/**
 * Replacement for Pi's `<docs>` prompt section.
 *
 * Anthropic rejects a request as third-party app usage when the child reports
 * a client label other than Claude Code's SDK default and the system prompt
 * carries Pi's docs section, whose list of topics and doc paths is the
 * fingerprint. See docs/usage.md.
 */

import type { Message, SystemMessage } from "@earendil-works/pi-ai/compat";
import { getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";

/** Pi's docs guidance as prose, without the topic-to-path list. */
export const DOCS_SECTION =
  "This session runs inside Pi. If the user asks about Pi itself, for example its SDK, extensions, themes, " +
  "skills, or terminal UI, look the answer up in Pi's own files instead of guessing; other tasks do not need them. " +
  `The README is at ${getReadmePath()}, the guides are under ${getDocsPath()}, ` +
  `and runnable samples of extensions, custom tools, and SDK use are under ${getExamplesPath()}. ` +
  "Relative paths such as docs/... or examples/... point into those folders, not into the user's project. " +
  "Open docs/docs.json first: it lists every guide by title, covering subjects like prompt templates, " +
  "TUI components, keybindings, SDK integrations, custom providers, adding models, packages, " +
  "environment variables, MCP servers, and codemode. " +
  "The codemode guide also covers classifiers, image models, and other models that do not chat. " +
  `For extensions, also read the matching sample under ${getExamplesPath()}/extensions, ` +
  "since the extension guide treats those samples as the implementation reference. " +
  "Before building anything for Pi, read the guides and samples that apply, read each guide to the end, " +
  "and follow the links it gives to related guides.";

/** The section as Pi renders a custom section into the prompt. */
const RENDERED_DOCS_SECTION = `<docs>\n${DOCS_SECTION}\n</docs>`;

function withoutDocs(message: SystemMessage): SystemMessage {
  const { sections, ...rest } = message;
  const { docs: _docs, ...others } = sections ?? {};
  return Object.keys(others).length > 0 ? { ...rest, sections: others } : rest;
}

/**
 * Replace every `docs` section in the transcript's system messages.
 *
 * The transcript keeps whatever docs section the model active at the time
 * received: Pi's default when the session started on another provider, or
 * when another extension calls this provider while a different model is the
 * session model. A later update that leaves the replaced section unchanged is
 * dropped, so switching providers adds no mid-conversation section update.
 * Returns `messages` itself when no system message has a docs section.
 */
export function replaceDocsSections(messages: Message[]): Message[] {
  let current: string | null | undefined;
  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== "system" || !message.sections || !("docs" in message.sections)) {
      return message;
    }
    changed = true;
    const docs = message.sections["docs"] === null ? null : RENDERED_DOCS_SECTION;
    if (docs === current) {
      return withoutDocs(message);
    }
    current = docs;
    return { ...message, sections: { ...message.sections, docs } };
  });
  return changed ? result : messages;
}
