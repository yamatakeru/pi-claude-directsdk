/**
 * Admission relay failures (#4, #7) and the request-rewrite failure path.
 * Upstreams are loopback HTTP fixtures; nothing leaves the machine.
 */

import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AdmissionRelay, formatRelayFailure } from "../src/admission.ts";

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

function post(url: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const req = request(`${url}/v1/messages`, { method: "POST" }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => (text += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      res.on("error", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", () => resolve({ status: 0, text: "" }));
    req.end(body);
  });
}

test("#4 a refused connection reports its code, address and connect phase", async () => {
  const closed = createServer();
  const upstream = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));

  const relay = await AdmissionRelay.create(upstream, 5_000);
  try {
    const res = await post(relay.url, "{}");
    assert.equal(res.status, 502);
    assert.equal(relay.failure?.phase, "connect");
    assert.equal(relay.failure?.code, "ECONNREFUSED");
    assert.equal(relay.failure?.address, "127.0.0.1");
    assert.equal(relay.failure?.message, null);
    assert.match(formatRelayFailure(relay.failure!), /ECONNREFUSED connect 127\.0\.0\.1:\d+ during connect$/);
  } finally {
    await relay.close();
  }
});

test("#4 AggregateError causes are listed in the formatted failure", () => {
  const failure = {
    name: "AggregateError",
    phase: "connect" as const,
    message: null,
    code: "ETIMEDOUT",
    syscall: null,
    address: null,
    port: null,
    causes: [
      { code: "ENETUNREACH", syscall: "connect", address: "2001:db8::1", port: 443 },
      { code: "ETIMEDOUT", syscall: "connect", address: "192.0.2.1", port: 443 },
    ],
  };
  assert.equal(
    formatRelayFailure(failure),
    "AggregateError ETIMEDOUT during connect " +
      "[ENETUNREACH connect [2001:db8::1]:443; ETIMEDOUT connect 192.0.2.1:443]",
  );
});

test("#7 an upstream dropped mid-response settles the relay", async () => {
  const upstreamServer = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: message_start\ndata: {}\n\n", () => res.socket?.destroy());
  });
  const upstream = await listen(upstreamServer);
  const relay = await AdmissionRelay.create(upstream, 5_000);
  try {
    // Without settling, the native response stays open until the timeout.
    const outcome = await Promise.race([
      post(relay.url, "{}").then(() => "settled"),
      new Promise((resolve) => setTimeout(resolve, 2_000, "hung")),
    ]);
    assert.equal(outcome, "settled");
    assert.equal(relay.status, 200);
    assert.equal(relay.failure?.phase, "response");
    assert.equal(relay.capture.complete, false);
  } finally {
    await relay.close();
    upstreamServer.closeAllConnections();
    await new Promise((resolve) => upstreamServer.close(resolve));
  }
});

test("a throwing request rewrite answers 500 before any upstream contact", async () => {
  let contacted = 0;
  const upstreamServer = createServer((_req, res) => {
    contacted++;
    res.writeHead(200);
    res.end();
  });
  const upstream = await listen(upstreamServer);
  const relay = await AdmissionRelay.create(upstream, 5_000, {
    transformRequest: () => {
      throw new Error("Native request lost an assistant boundary needed by system history");
    },
  });
  try {
    const first = await post(relay.url, "original");
    assert.equal(first.status, 500);
    assert.match(first.text, /Native request rewrite failed/);
    assert.equal(contacted, 0);
    // Only the error name and phase are kept, never its message.
    assert.equal(formatRelayFailure(relay.failure!), "Error during request-body");
    // Later native attempts are still denied locally.
    const denied = await post(relay.url, "retry");
    assert.equal(denied.status, 400);
    assert.match(denied.text, /PI_MODEL_ADMISSION_CONSUMED/);
  } finally {
    await relay.close();
    upstreamServer.closeAllConnections();
    await new Promise((resolve) => upstreamServer.close(resolve));
  }
});
