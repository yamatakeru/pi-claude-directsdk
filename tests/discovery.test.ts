import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverModels } from "../src/discovery.ts";

/** Records its environment, then prints the lines it is given. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const keys = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING", "DISABLE_AUTOUPDATER", "CLAUDE_CODE_USE_BEDROCK"];
fs.writeFileSync(process.env.FAKE_SEEN, JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]))));
process.stdin.resume();
process.stdin.on("end", () => {
  for (const line of JSON.parse(process.env.FAKE_LINES)) process.stdout.write(JSON.stringify(line) + "\\n");
});
`;

/** Rows as Claude Code 2.1.322 serves them first-party. */
const SERVED = [
  {
    value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks", supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "fable", resolvedModel: "claude-fable-5-2", displayName: "Fable 5.2",
    description: "For your toughest challenges", supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5",
    description: "Fastest for quick answers", supportsThinkingOff: true,
  },
];

const initialized = (models: unknown[]) => ({
  type: "control_response",
  response: { subtype: "success", request_id: "pi-picker", response: { models } },
});

async function discover(env: NodeJS.ProcessEnv, lines: unknown[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-native-discovery-")));
  try {
    const executable = join(root, "claude");
    await writeFile(executable, FAKE_CLAUDE, "utf8");
    await chmod(executable, 0o755);
    const seenPath = join(root, "seen.json");
    const run = discoverModels(AbortSignal.timeout(10_000), {
      PATH: process.env["PATH"],
      PI_CLAUDE_NATIVE_COMMAND: executable,
      FAKE_SEEN: seenPath,
      FAKE_LINES: JSON.stringify(lines),
      ...env,
    });
    const models = await run.catch((error: unknown) => error);
    // Without the record, discovery failed before the child ran: show why.
    const seenText = await readFile(seenPath, "utf8").catch(() => {
      throw models instanceof Error ? models : new Error("the fake Claude Code never ran");
    });
    return { models, seen: JSON.parse(seenText) as Record<string, string | null> };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("reads the served picker first-party, with feature flags on and self-updates off", async () => {
  const { models, seen } = await discover({}, [{ type: "system", subtype: "init" }, initialized(SERVED)]);
  assert.deepEqual(models, [
    {
      id: "claude-opus-5-5", alias: "default", label: "Default (recommended)",
      description: "Opus 5.5 · Best for everyday, complex tasks", supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "claude-fable-5-2", alias: "fable", label: "Fable 5.2", description: "For your toughest challenges",
      supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "claude-haiku-4-5-20251001", alias: "claude-haiku-4-5-20251001", label: "Haiku 4.5",
      description: "Fastest for quick answers",
    },
  ]);
  assert.deepEqual(seen, {
    ANTHROPIC_BASE_URL: null,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: null,
    DISABLE_TELEMETRY: null,
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_USE_BEDROCK: null,
  });
});

test("keeps the user's own opt-out of Claude Code's nonessential traffic", async () => {
  const { seen } = await discover(
    { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1" },
    [initialized(SERVED)],
  );
  assert.equal(seen["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1");
  assert.equal(seen["DISABLE_TELEMETRY"], "1");
});

test("behind another backend, keeps traffic off and sends Claude Code to the loopback guard", async () => {
  for (const env of [{ ANTHROPIC_BASE_URL: "https://gateway.example" }, { CLAUDE_CODE_USE_BEDROCK: "1" }]) {
    const { models, seen } = await discover(env, [initialized(SERVED)]);
    assert.ok(Array.isArray(models), String(models));
    assert.match(seen["ANTHROPIC_BASE_URL"] ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(seen["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1");
    assert.equal(seen["DISABLE_TELEMETRY"], "1");
    // A backend switch would take Claude Code past the guard to its own cloud client.
    assert.equal(seen["CLAUDE_CODE_USE_BEDROCK"], null);
  }
});

test("a model-turn line on stdout fails discovery", async () => {
  for (const type of ["assistant", "stream_event", "result"]) {
    for (const lines of [[initialized(SERVED), { type }], [{ type }, initialized(SERVED)]]) {
      const { models } = await discover({}, lines);
      assert.ok(models instanceof Error);
      assert.match(models.message, new RegExp(`^Claude started a model turn during model discovery \\(${type} record\\)`));
    }
  }
});
