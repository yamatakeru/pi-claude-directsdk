import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChildEnv,
  DEFAULT_ENTRYPOINT,
  ENTRYPOINT_ENV,
} from "../src/request.ts";

const build = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  buildChildEnv({ baseEnv: env, relayUrl: "http://127.0.0.1:1", body: {} });

test("the child reports this client, replacing an inherited label", () => {
  assert.equal(build({ PATH: "/bin" })["CLAUDE_CODE_ENTRYPOINT"], DEFAULT_ENTRYPOINT);
  // A Pi started from inside another Claude client must not inherit its identity.
  assert.equal(
    build({ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" })["CLAUDE_CODE_ENTRYPOINT"],
    DEFAULT_ENTRYPOINT,
  );
});

test("the child runs with native artifacts off, replacing an inherited value", () => {
  assert.equal(build({})["CLAUDE_CODE_DISABLE_ARTIFACT"], "1");
  assert.equal(build({ CLAUDE_CODE_DISABLE_ARTIFACT: "0" })["CLAUDE_CODE_DISABLE_ARTIFACT"], "1");
});

test("the override sets the label, and an empty override leaves the label to the CLI", () => {
  assert.equal(
    build({ [ENTRYPOINT_ENV]: "my-tool" })["CLAUDE_CODE_ENTRYPOINT"],
    "my-tool",
  );
  const unlabelled = build({ [ENTRYPOINT_ENV]: "", CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
  assert.equal("CLAUDE_CODE_ENTRYPOINT" in unlabelled, false);
});

test("on Windows the override is found under any case, elsewhere only exactly", () => {
  const lower = { pi_claude_native_entrypoint: "my-tool", claude_code_entrypoint: "sdk-cli" };
  const windows = buildChildEnv({ baseEnv: lower, relayUrl: "http://127.0.0.1:1", body: {}, platform: "win32" });
  assert.equal(windows["CLAUDE_CODE_ENTRYPOINT"], "my-tool");
  // The inherited label under another case is removed, not left beside the new one.
  assert.equal("claude_code_entrypoint" in windows, false);
  const empty = buildChildEnv({
    baseEnv: { pi_claude_native_entrypoint: "" },
    relayUrl: "http://127.0.0.1:1",
    body: {},
    platform: "win32",
  });
  assert.equal("CLAUDE_CODE_ENTRYPOINT" in empty, false);
  const linux = buildChildEnv({ baseEnv: lower, relayUrl: "http://127.0.0.1:1", body: {}, platform: "linux" });
  assert.equal(linux["CLAUDE_CODE_ENTRYPOINT"], DEFAULT_ENTRYPOINT);
});

test("an unusable override names the variable and the fix", () => {
  assert.throws(
    () => build({ [ENTRYPOINT_ENV]: "two words" }),
    /PI_CLAUDE_NATIVE_ENTRYPOINT must be 1-64 characters/,
  );
});
