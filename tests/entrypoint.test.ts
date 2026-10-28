import assert from "node:assert/strict";
import test from "node:test";
import { buildChildEnv, ENTRYPOINT_ENV } from "../src/request.ts";

const build = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  buildChildEnv({ baseEnv: env, relayUrl: "http://127.0.0.1:1", body: {} });

test("#23 the child leaves the label to the CLI and drops an inherited one", () => {
  assert.equal("CLAUDE_CODE_ENTRYPOINT" in build({ PATH: "/bin" }), false);
  // A Pi started from inside another Claude client must not inherit its identity.
  assert.equal("CLAUDE_CODE_ENTRYPOINT" in build({ CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }), false);
  assert.equal(
    "CLAUDE_CODE_ENTRYPOINT" in build({ [ENTRYPOINT_ENV]: "", CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }),
    false,
  );
});

test("an explicit override sets the label and replaces an inherited one", () => {
  assert.equal(
    build({ [ENTRYPOINT_ENV]: "my-tool", CLAUDE_CODE_ENTRYPOINT: "sdk-ts" })["CLAUDE_CODE_ENTRYPOINT"],
    "my-tool",
  );
});

test("an unusable override names the variable and the fix", () => {
  assert.throws(
    () => build({ [ENTRYPOINT_ENV]: "two words" }),
    /CLAUDE_DIRECTSDK_ENTRYPOINT must be 1-64 characters/,
  );
});
