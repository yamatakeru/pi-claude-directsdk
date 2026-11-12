import assert from "node:assert/strict";
import test from "node:test";
import { buildChildEnv, checkEnvConflicts, TEST_UPSTREAM_ENV } from "../src/request.ts";
import { pickerChildEnv, setupChildEnv } from "../src/setup.ts";

test("rejects backend overrides without the test bypass", () => {
  assert.deepEqual(checkEnvConflicts({ ANTHROPIC_API_KEY: "secret", ANTHROPIC_AUTH_TOKEN: "secret" }), []);
  assert.deepEqual(checkEnvConflicts({ ANTHROPIC_BASE_URL: "https://example.test" }), [
    "ANTHROPIC_BASE_URL",
  ]);
  assert.deepEqual(checkEnvConflicts({ CLAUDE_CODE_USE_BEDROCK: "1" }), [
    "CLAUDE_CODE_USE_BEDROCK",
  ]);
  assert.deepEqual(checkEnvConflicts({ [TEST_UPSTREAM_ENV]: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:1" }), []);
});

test("API credentials never reach Claude Code without the test bypass", () => {
  const credentials = { ANTHROPIC_API_KEY: "a", ANTHROPIC_AUTH_TOKEN: "b", ANTHROPIC_FOUNDRY_API_KEY: "c" };
  const turn = (env: NodeJS.ProcessEnv) => buildChildEnv({ baseEnv: env, relayUrl: "http://127.0.0.1:1", body: {} });
  for (const child of [turn({ ...credentials, KEEP: "1" }), setupChildEnv({ ...credentials, KEEP: "1" }), pickerChildEnv({ ...credentials, KEEP: "1" })]) {
    assert.deepEqual(Object.keys(credentials).filter((name) => name in child), []);
    assert.equal(child["KEEP"], "1");
  }
  for (const child of [
    turn({ ...credentials, [TEST_UPSTREAM_ENV]: "1" }),
    setupChildEnv({ ...credentials, [TEST_UPSTREAM_ENV]: "1" }),
    pickerChildEnv({ ...credentials, [TEST_UPSTREAM_ENV]: "1" }),
  ]) {
    assert.deepEqual(Object.keys(credentials).filter((name) => !(name in child)), []);
  }
});
