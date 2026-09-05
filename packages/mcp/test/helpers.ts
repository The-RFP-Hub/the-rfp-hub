/**
 * Shared fixtures. Every credential in this directory is SYNTHETIC and clearly fake — no real
 * `rfph_` value may ever appear in a test file, because a fixture is as public as the repository.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpConfig } from "../src/config.js";
import { canonicalOrigin } from "../src/config.js";
import type { ToolError } from "../src/errors.js";

/**
 * Await a promise that must reject, and hand back the `ToolError`.
 *
 * `p.catch((e) => e)` widens the type to "the value or the error", which then needs a cast at
 * every assertion. Failing loudly when the promise RESOLVES matters too: a test that asserts on an
 * error message would otherwise pass silently against a call that unexpectedly succeeded.
 */
export async function rejection(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (err) {
    return err as ToolError;
  }
  throw new Error("expected the call to reject, but it resolved");
}

/** A key-shaped string that is not a key. The suffix says so out loud. */
export const FAKE_KEY = "rfph_TESTONLYnotarealkey000000000000";
export const OTHER_FAKE_KEY = "rfph_TESTONLYsecondfakekey00000000000";

export function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rfphub-mcp-test-"));
}

export function testConfig(overrides: Partial<McpConfig> = {}): McpConfig {
  const apiBase = overrides.apiBase ?? "https://api.example.test";
  return {
    apiBase,
    apiOrigin: overrides.apiOrigin ?? canonicalOrigin(apiBase),
    apiKey: overrides.apiKey !== undefined ? overrides.apiKey : FAKE_KEY,
    home: overrides.home ?? tempHome(),
    // Defaults to false so the printed commands stay flagless unless a test is about the flag.
    stateDirExplicit: overrides.stateDirExplicit ?? false,
    timeoutMs: overrides.timeoutMs ?? 20_000,
  };
}

/** A minimal document that passes the standard's schema. Used by the write-path tests. */
export function validDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specVersion: "1.0.0",
    id: "example-org:test-grant",
    title: "Test Grant Program",
    description: "A synthetic grant program used by this package's tests. Not a real program.",
    fundingType: "grant",
    status: "open",
    operatingOrganizations: [{ name: "Example Org", slug: "example-org" }],
    fundingInfo: { currency: "USD", minAward: 1000, maxAward: 50000 },
    fundingDetails: { fundingType: "grant" },
    source: { publisher: "example-org", ingestedVia: "submission" },
    ...overrides,
  };
}

/** One list item as the API serializes it: a full document minus `fundingDetails`. */
export function summaryItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { fundingDetails: _dropped, ...rest } = validDocument();
  return { ...rest, ...overrides };
}

export function listPage(
  items: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    items,
    page: 1,
    limit: 10,
    total: items.length,
    // `Math.max(1, …)` on the server: an empty page still reports 1.
    totalPages: Math.max(1, Math.ceil(items.length / 10)),
    ...overrides,
  };
}

export interface StubCall {
  url: string;
  init: RequestInit | undefined;
}

export interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: string;
}

export interface Stub {
  calls: StubCall[];
  /** The scope preflight's `GET /v1/me`, kept OUT of `calls` and the queue so every "nothing was
   * sent" assertion still speaks about the search, fetch and submission paths alone. */
  meCalls: StubCall[];
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
}

/** What `GET /v1/me` says about a key scoped exactly as the write path needs. */
export const WRITE_ONLY_CREDENTIAL = { credentialKind: "api_key", scopes: ["read", "write"] };

/** A `fetch` stand-in that answers from a queue and records what it was asked. */
export function stubFetch(responses: StubResponse[], options: { me?: StubResponse } = {}): Stub {
  const calls: StubCall[] = [];
  const meCalls: StubCall[] = [];
  let index = 0;
  const respond = (spec: StubResponse | undefined): Response => {
    if (spec === undefined) throw new Error("stubFetch: no response configured");
    const body = spec.raw ?? (spec.body === undefined ? "" : JSON.stringify(spec.body));
    const status = spec.status ?? 200;
    // 204/205/304 may carry no body at all — the `Response` constructor refuses even "".
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : body, {
      status,
      headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
    });
  };
  return {
    calls,
    meCalls,
    fetchImpl: async (url, init) => {
      if (new URL(url).pathname === "/v1/me") {
        meCalls.push({ url, init });
        return respond(options.me ?? { body: WRITE_ONLY_CREDENTIAL });
      }
      calls.push({ url, init });
      const spec = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return respond(spec);
    },
  };
}
