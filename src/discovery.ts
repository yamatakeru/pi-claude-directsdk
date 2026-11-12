/**
 * Read the account's model picker through Claude Code's `initialize`
 * handshake, without a model request or synchronous CLI probes.
 *
 * Claude Code serves the account's own picker (older models it still runs,
 * models gated per account) only first-party, so the handshake talks to
 * Anthropic directly. It writes only `initialize` and closes stdin, so there
 * is no user turn; a model-turn line on stdout fails discovery. When the
 * environment points Claude Code at another backend, the served picker is out
 * of reach anyway: the child keeps nonessential traffic off, and a loopback
 * guard that refuses every request stands in for the backend.
 */
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSupervised, type ChildHandle } from "./process.js";
import { pickerChildEnv, resolveClaude, setupChildEnv } from "./setup.js";
import { CONFLICTING_BACKEND_VARS, routesElsewhere } from "./request.js";
import { INSTALL_HINT } from "./errors.js";
import { isRecord } from "./types.js";

export interface DiscoveredModel {
  id: string;
  alias: string;
  label: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

/** Stdout records of a model turn, which a handshake without a user turn never prints. */
const MODEL_TURN_RECORDS = new Set(["assistant", "stream_event", "result"]);

export async function discoverModels(
  signal: AbortSignal,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveredModel[]> {
  signal.throwIfAborted();
  const guarded = routesElsewhere(baseEnv);
  const env = guarded ? guardedChildEnv(baseEnv) : pickerChildEnv(baseEnv);
  const resolved = resolveClaude(undefined, env);
  if (!resolved) throw new Error(INSTALL_HINT);
  let contacted = false;
  // Behind another backend, deny every request, even the first one.
  const guard = guarded
    ? createServer((request, response) => {
        if (request.method === "POST" && request.url?.split("?")[0] === "/v1/messages") contacted = true;
        response.writeHead(403).end("Model requests are disabled during discovery");
      })
    : undefined;
  if (guard) {
    await new Promise<void>((resolve, reject) => {
      guard.once("error", reject);
      guard.listen(0, "127.0.0.1", resolve);
    });
  }
  let cwd: string | undefined;
  let child: ChildHandle | undefined;
  let primaryError: unknown;
  try {
    cwd = await mkdtemp(join(tmpdir(), "pi-claude-native-picker-"));
    let childEnv = env;
    if (guard) {
      const address = guard.address();
      if (!address || typeof address === "string") throw new Error("Discovery guard has no address");
      childEnv = { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}` };
    }
    const [command = "", ...prefix] = resolved;
    child = spawnSupervised({
      command,
      args: [...prefix, "-p", "--model", "sonnet", "--input-format", "stream-json", "--output-format", "stream-json",
        "--verbose", "--tools", "", "--setting-sources", "", "--strict-mcp-config",
        "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-session-persistence"],
      env: childEnv,
      cwd,
      timeoutMs: 10_000,
      signal,
    });
    await child.writeLine(JSON.stringify({
      type: "control_request", request_id: "pi-picker", request: { subtype: "initialize" },
    }));
    child.closeStdin();
    let models: unknown;
    let bytes = 0;
    for (;;) {
      const line = await child.nextLine();
      if (line === null) break;
      bytes += Buffer.byteLength(line);
      if (bytes > 8 * 1024 * 1024) throw new Error("Claude discovery response exceeds 8 MiB");
      if (!line.startsWith("{")) continue;
      const row: unknown = JSON.parse(line);
      if (!isRecord(row)) continue;
      const type = row["type"];
      if (typeof type === "string" && MODEL_TURN_RECORDS.has(type)) {
        throw new Error(`Claude started a model turn during model discovery (${type} record); discovery stopped`);
      }
      if (type !== "control_response") continue;
      const response = row["response"];
      if (!isRecord(response) || response["request_id"] !== "pi-picker") continue;
      if (response["subtype"] === "error") throw new Error("Claude picker initialization failed; check claude auth status");
      const inner = response["response"];
      if (isRecord(inner)) models = inner["models"];
    }
    const exit = await child.wait();
    signal.throwIfAborted();
    if (contacted) throw new Error("Claude attempted an API request during model discovery; request blocked");
    if (exit.code !== 0) throw new Error(`Claude discovery exited with code ${exit.code}; check claude auth status`);
    if (!Array.isArray(models) || models.length === 0) throw new Error("Claude returned no model picker metadata");
    return models.map((row: unknown) => {
      if (!isRecord(row) || typeof row["resolvedModel"] !== "string" || typeof row["value"] !== "string") {
        throw new Error("Claude picker is missing resolvedModel or value; update Claude Code");
      }
      return {
        id: row["resolvedModel"].replace(/\[1m\]$/, ""),
        alias: row["value"],
        label: typeof row["displayName"] === "string" ? row["displayName"] : row["value"],
        description: typeof row["description"] === "string" ? row["description"] : "",
        ...(typeof row["supportsEffort"] === "boolean" ? { supportsEffort: row["supportsEffort"] } : {}),
        ...(Array.isArray(row["supportedEffortLevels"]) && row["supportedEffortLevels"].every(x => typeof x === "string")
          ? { supportedEffortLevels: row["supportedEffortLevels"] as string[] } : {}),
      };
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const errors: unknown[] = [];
    const cleanup = [
      async () => { if (child) { child.cancel(); await child.wait(); } },
      async () => {
        if (!guard) return;
        guard.closeAllConnections();
        // Bun also stops listening here; Node still needs an explicit close.
        if (!guard.listening) return;
        await new Promise<void>((resolve, reject) => guard.close(error => error ? reject(error) : resolve()));
      },
      async () => { if (cwd) await rm(cwd, { recursive: true, force: true }); },
    ];
    for (const action of cleanup) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) {
      if (primaryError !== undefined && !errors.includes(primaryError)) errors.unshift(primaryError);
      throw new AggregateError(errors, "Claude discovery cleanup failed");
    }
  }
}

/**
 * Environment of a guarded handshake. A backend switch would make Claude Code
 * use its own cloud client and bypass the guard, so the switches are dropped.
 */
function guardedChildEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = setupChildEnv(baseEnv);
  for (const name of CONFLICTING_BACKEND_VARS) delete env[name];
  return env;
}
