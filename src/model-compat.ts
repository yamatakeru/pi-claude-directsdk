/** Verified Anthropic model capabilities that the transport depends on. */
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const NATIVE_TOOL_CHANGES = new Map(
  getBuiltinModels("anthropic").map((model) => [
    model.id,
    model.compat?.supportsMidConvoToolChanges === true,
  ]),
);

/**
 * Whether the built-in Anthropic metadata marks this model as supporting
 * mid-conversation tool additions and removals. Unknown models keep the
 * collapsed request shape.
 */
export function supportsNativeToolChanges(modelId: string, compat?: unknown): boolean {
  const explicit = compat as { supportsMidConvoToolChanges?: unknown } | undefined;
  if (explicit?.supportsMidConvoToolChanges === true) {
    return true;
  }
  const base = modelId.replace(/\[1m\]$/u, "");
  return NATIVE_TOOL_CHANGES.get(base) === true;
}
