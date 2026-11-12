/** Register an empty catalog; refresh only after Pi allows network work. */
import type {
  Api, AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { Provider } from "@earendil-works/pi-ai";
import { nativeModel, PROVIDER_ID } from "./models.js";
import { lazyStream } from "./lazy-stream.js";
import { declaredPromptCache } from "./prompt-cache.js";

export { PROVIDER_ID };

export function createClaudeNativeProvider(report: (message: string) => void): Provider {
  let models: Model<Api>[] = [];
  let refreshedAt = 0;
  return {
    id: PROVIDER_ID,
    name: "Claude Native",
    baseUrl: "process://claude-native",
    auth: {
      apiKey: {
        name: "Claude CLI authentication",
        resolve: async () => ({ auth: { apiKey: "[REDACTED]" }, source: "Claude CLI" }),
      },
    },
    getModels: () => models,
    async refreshModels(context) {
      // This path must not import discovery, run a child, or contact the web.
      if (context.signal.aborted) return;
      if (!context.allowNetwork) {
        if (!models.length && context.stored?.checkedAt) {
          await context.publish({ update: () => {
            // The store is typed for every model type; this provider only persists chat models.
            models = context.stored!.models
              .filter((model): model is Model<Api> => (model.type ?? "chat") === "chat")
              .map(model => withPromptCache({ ...model, name: `${model.name} (last verified snapshot)` }));
            refreshedAt = context.stored!.checkedAt!;
          } });
        }
        return;
      }
      if (!context.force && Date.now() - refreshedAt < 15 * 60_000) return;
      const deadline = AbortSignal.timeout(12_000);
      const signal = AbortSignal.any([context.signal, deadline]);
      try {
        const [{ discoverModels }, { loadWebCatalog }] = await Promise.all([
          import("./discovery.js"), import("./web-catalog.js"),
        ]);
        const picker = await discoverModels(signal);
        const result = await loadWebCatalog(picker, signal);
        signal.throwIfAborted();
        const accepted = await context.publish({ persist: { models: result.models, checkedAt: Date.now() }, update: () => {
          models = result.models.map(withPromptCache);
          refreshedAt = Date.now();
        } });
        if (!accepted) return;
        if (result.warnings.length) {
          report(`Claude Native excluded models with incomplete metadata:\n${result.warnings.join("\n")}`);
        }
        if (result.withheld.length) {
          report(`Claude Native left optional features off because Anthropic's docs did not confirm them:\n${result.withheld.join("\n")}`);
        }
        if (!result.models.length) throw new Error("No Claude models have complete, verified metadata");
      } catch (error) {
        if (context.signal.aborted) throw error;
        await context.publish({ persist: null, update: () => { models = []; refreshedAt = 0; } });
        const message = `Claude Native catalog refresh failed: ${error instanceof Error ? error.message : error}. No pinned fallback is used.`;
        report(message);
        throw new Error(message, { cause: error });
      }
    },
    stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
    streamSimple,
  };
}

function withPromptCache(model: Model<Api>): Model<Api> {
  const { promptCache: _stale, ...rest } = model;
  const promptCache = declaredPromptCache(process.env, nativeModel(model.id, model.contextWindow));
  return promptCache ? { ...rest, promptCache } : rest;
}

export function streamSimple(
  model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return lazyStream(model, async () => {
    const { streamClaudeNative } = await import("./stream.js");
    return streamClaudeNative(model, context, options);
  });
}
