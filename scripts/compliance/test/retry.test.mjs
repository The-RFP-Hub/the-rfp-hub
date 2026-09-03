/**
 * One retry for the GitHub publication probes.
 *
 * A sign-off run failed the governance criterion with HTTP 502 on all four governance URLs; every one answered 200
 * moments later. These tests spawn a real server that fails once and then succeeds, because the
 * property being locked in is "the second request is actually made and its answer is the one
 * returned" — and, just as important, that a 404 is never asked twice.
 */
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request } from "../http.mjs";
import { RETRY_BACKOFF_MS, RETRY_HOSTS, isRetryable, requestPublished } from "../retry.mjs";

let server;
let origin;
let hits;
let behavior;

beforeEach(async () => {
  hits = [];
  behavior = () => ({ status: 200, body: "ok" });
  server = createServer((req, res) => {
    hits.push(req.url);
    const next = behavior(hits.length);
    if (next.destroy) {
      req.socket.destroy();
      return;
    }
    res.writeHead(next.status, { "content-type": "text/plain" });
    res.end(next.body ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** The host allowlist is the point of the helper, so tests opt 127.0.0.1 in explicitly. */
const retry = { retryHosts: ["127.0.0.1"], backoffMs: 5 };

describe("requestPublished", () => {
  it("retries a 502 once and returns the 200", async () => {
    behavior = (n) =>
      n === 1 ? { status: 502, body: "bad gateway" } : { status: 200, body: "ok" };
    const res = await requestPublished(`${origin}/GOVERNANCE.md`, {}, retry);
    expect(res.status).toBe(200);
    expect(hits).toHaveLength(2);
  });

  it("retries a transport failure once", async () => {
    behavior = (n) => (n === 1 ? { destroy: true } : { status: 200, body: "ok" });
    const res = await requestPublished(`${origin}/SKILL.md`, {}, retry);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(hits).toHaveLength(2);
  });

  it("gives up after ONE retry, returning the second answer", async () => {
    behavior = () => ({ status: 503, body: "still down" });
    const res = await requestPublished(`${origin}/GOVERNANCE.md`, {}, retry);
    expect(res.status).toBe(503);
    expect(hits).toHaveLength(2);
  });

  it("never retries a 404 — that IS the answer", async () => {
    behavior = () => ({ status: 404, body: "not found" });
    const res = await requestPublished(`${origin}/REVIEW-CRITERIA.md`, {}, retry);
    expect(res.status).toBe(404);
    expect(hits).toHaveLength(1);
  });

  it("never retries a 200", async () => {
    await requestPublished(`${origin}/PUBLISHERS.md`, {}, retry);
    expect(hits).toHaveLength(1);
  });

  it("does not retry a host outside the allowlist, even on a 502", async () => {
    behavior = () => ({ status: 502, body: "bad gateway" });
    const res = await requestPublished(`${origin}/elsewhere`, {}, { backoffMs: 5 });
    expect(res.status).toBe(502);
    expect(hits).toHaveLength(1);
  });

  it("waits the backoff before asking again", async () => {
    behavior = (n) => (n === 1 ? { status: 502 } : { status: 200, body: "ok" });
    const startedAt = Date.now();
    await requestPublished(
      `${origin}/GOVERNANCE.md`,
      {},
      { retryHosts: ["127.0.0.1"], backoffMs: 120 },
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
  });
});

describe("the behavior this replaces", () => {
  it("a plain request returns the 502 — which is how governance went red on four published documents", async () => {
    behavior = (n) =>
      n === 1 ? { status: 502, body: "bad gateway" } : { status: 200, body: "ok" };
    const res = await request(`${origin}/GOVERNANCE.md`, {});
    expect(res.status).toBe(502);
    expect(hits).toHaveLength(1);
  });
});

describe("isRetryable", () => {
  it("covers the two hosts that serve this project's published documents", () => {
    expect(RETRY_HOSTS).toEqual(["github.com", "raw.githubusercontent.com"]);
    expect(RETRY_BACKOFF_MS).toBe(2000);
    expect(isRetryable("https://github.com/x", { ok: true, status: 502 })).toBe(true);
    expect(isRetryable("https://raw.githubusercontent.com/x", { ok: false })).toBe(true);
  });

  it("is false for a 4xx, a 2xx, another host and an unparseable URL", () => {
    expect(isRetryable("https://github.com/x", { ok: true, status: 404 })).toBe(false);
    expect(isRetryable("https://github.com/x", { ok: true, status: 200 })).toBe(false);
    expect(isRetryable("https://api.ethrfps.app/x", { ok: true, status: 502 })).toBe(false);
    expect(isRetryable("not a url", { ok: true, status: 502 })).toBe(false);
  });
});
