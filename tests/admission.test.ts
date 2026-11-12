import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AdmissionRelay } from "../src/admission.ts";
import { NATIVE_TOOL_CHANGES_BETA } from "../src/transcript.ts";

test("admits one upstream request and applies the tool-change beta and rewrite", async (t) => {
  let upstreamRequests = 0;
  let seenBeta = "";
  let seenBody: Record<string, unknown> | undefined;
  const upstream = createServer((request, response) => {
    upstreamRequests += 1;
    seenBeta = String(request.headers["anthropic-beta"] ?? "");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seenBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"type":"message_start","message":{"role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
          'data: {"type":"message_stop"}\n\n',
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const relay = await AdmissionRelay.create(
    `http://127.0.0.1:${address.port}`,
    5_000,
    {
      transformRequest: (body) => {
        const payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        payload["rewritten"] = true;
        return Buffer.from(JSON.stringify(payload));
      },
      betas: [NATIVE_TOOL_CHANGES_BETA],
    },
  );
  t.after(() => relay.close());

  const first = await fetch(`${relay.url}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "existing-beta",
    },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(first.status, 200);
  await first.text();
  assert.equal(upstreamRequests, 1);
  assert.equal(seenBeta, `existing-beta,${NATIVE_TOOL_CHANGES_BETA}`);
  assert.equal(seenBody?.["rewritten"], true);

  const second = await fetch(`${relay.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(second.status, 400);
  assert.match(await second.text(), /PI_MODEL_ADMISSION_CONSUMED/);
  assert.equal(upstreamRequests, 1);
  assert.equal(relay.used, true);
  assert.equal(relay.denied, 1);
});

const AUTH_ERROR = { type: "error", error: { type: "authentication_error", message: "OAuth access token has been revoked." } };
const SSE =
  'data: {"type":"message_start","message":{"role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
  'data: {"type":"message_stop"}\n\n';

type Answer = { status: number; body: unknown; requestId?: string };

/** Relay requests against an upstream that gives each answer in turn; the last one repeats. */
async function sequence(t: test.TestContext, answers: Answer[]) {
  let served = 0;
  const upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const answer = answers[Math.min(served, answers.length - 1)]!;
      served += 1;
      response.writeHead(answer.status, {
        "content-type": "application/json",
        ...(answer.requestId ? { "request-id": answer.requestId } : {}),
      });
      response.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const relay = await AdmissionRelay.create(`http://127.0.0.1:${address.port}`, 5_000);
  t.after(() => relay.close());
  const send = async (): Promise<number> => {
    const response = await fetch(`${relay.url}/v1/messages`, { method: "POST", body: "{}" });
    await response.text();
    return response.status;
  };
  return { relay, send, served: () => served };
}

test("admits one retry after a 401 authentication error and reports only that attempt", async (t) => {
  const { relay, send, served } = await sequence(t, [
    { status: 401, body: AUTH_ERROR, requestId: "req_first" },
    { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, requestId: "req_retry" },
  ]);
  assert.deepEqual([await send(), await send(), await send()], [401, 529, 400]);
  assert.equal(served(), 2);
  assert.equal(relay.admitted, 2);
  assert.equal(relay.denied, 1);
  assert.equal(relay.status, 529);
  assert.equal(relay.requestId, "req_retry");
  assert.equal(relay.errorText(), "Overloaded");

  const recovered = await sequence(t, [{ status: 401, body: AUTH_ERROR }, { status: 200, body: SSE }]);
  assert.deepEqual([await recovered.send(), await recovered.send()], [401, 200]);
  assert.equal(recovered.relay.capture.complete, true);
  assert.equal(recovered.relay.failure, null);
  assert.equal(recovered.relay.errorText(), "");
});

test("denies a retry after any other failure, and a second 401", async (t) => {
  const cases: Array<[string, Answer[]]> = [
    ["a 401 with another error type", [{ status: 401, body: { type: "error", error: { type: "permission_error", message: "no" } } }]],
    ["a 401 without a JSON body", [{ status: 401, body: "unauthorized" }]],
    ["a 401 past the body cap", [{ status: 401, body: JSON.stringify(AUTH_ERROR).padEnd(64 * 1024) + "x" }]],
    ["a rate limit", [{ status: 429, body: { type: "error", error: { type: "authentication_error", message: "x" } } }]],
  ];
  for (const [name, answers] of cases) {
    const { relay, send, served } = await sequence(t, answers);
    await send();
    assert.equal(await send(), 400, name);
    assert.equal(served(), 1, name);
    assert.equal(relay.admitted, 1, name);
  }

  // A retry while the 401 is still arriving is denied, even if its body so far parses.
  let finish: (() => void) | undefined;
  const open = createServer((request, response) => {
    request.resume();
    response.writeHead(401, { "content-type": "application/json" });
    response.write(JSON.stringify(AUTH_ERROR));
    finish = () => response.end();
  });
  await new Promise<void>((resolve) => open.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => open.close(() => resolve())));
  const openAddress = open.address();
  assert.ok(openAddress && typeof openAddress !== "string");
  const pending = await AdmissionRelay.create(`http://127.0.0.1:${openAddress.port}`, 5_000);
  t.after(() => pending.close());
  const first = await fetch(`${pending.url}/v1/messages`, { method: "POST", body: "{}" });
  const early = await fetch(`${pending.url}/v1/messages`, { method: "POST", body: "{}" });
  assert.equal(early.status, 400);
  await early.text();
  finish?.();
  await first.text();
  assert.equal(pending.admitted, 1);

  const { relay, send, served } = await sequence(t, [{ status: 401, body: AUTH_ERROR }]);
  assert.deepEqual([await send(), await send(), await send()], [401, 401, 400]);
  assert.equal(served(), 2);
  assert.equal(relay.admitted, 2);
  assert.equal(relay.status, 401);
  assert.equal(relay.denied, 1);
});
