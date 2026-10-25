/** Pi's thinking level reaches the CLI as `--effort` (#2). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildArgv, buildChildEnv, buildRequestBody, requestEffort } from "../src/request.ts";

const files = {
  systemPath: "s",
  settingsPath: "p",
  toolsPath: "t",
  mcpPath: "m",
  mcpConfigJson: "{}",
};

test("#2 the mapped effort is passed as --effort", () => {
  const { body } = buildRequestBody({
    tools: [],
    reasoning: "high",
    thinkingLevelMap: { high: "xhigh" },
  });
  assert.equal(requestEffort(body), "xhigh");
  const { args } = buildArgv({ claudeBin: "claude", nativeModelId: "m", files, effort: requestEffort(body) });
  assert.deepEqual(args.slice(-2), ["--effort", "xhigh"]);
});

test("#2 no effort means no --effort", () => {
  const { body } = buildRequestBody({ tools: [] });
  assert.equal(requestEffort(body), undefined);
  const { args } = buildArgv({ claudeBin: "claude", nativeModelId: "m", files, effort: requestEffort(body) });
  assert.equal(args.includes("--effort"), false);
});

test("#2 an inherited effort level or extra body does not reach the child", () => {
  const env = buildChildEnv({
    baseEnv: { CLAUDE_CODE_EFFORT_LEVEL: "medium", CLAUDE_CODE_EXTRA_BODY: "{}", KEEP: "1" },
    relayUrl: "http://127.0.0.1:1/admit/x",
    body: {},
  });
  assert.equal(env["CLAUDE_CODE_EFFORT_LEVEL"], undefined);
  assert.equal(env["CLAUDE_CODE_EXTRA_BODY"], undefined);
  assert.equal(env["KEEP"], "1");
});
