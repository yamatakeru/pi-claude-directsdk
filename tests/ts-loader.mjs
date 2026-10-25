import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolve source `.js` specifiers to their `.ts` files for node:test. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const candidate = new URL(specifier.replace(/\.js$/u, ".ts"), context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
}
