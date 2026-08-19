import { lookup as dnsLookup } from "node:dns/promises";
/**
 * The REAL transport, against a real socket — the half no fixture can stand in for.
 *
 * `test/unit/source-fetcher.test.ts` drives the protocol rules through an injected transport, and
 * says in its own header that the ADDRESS rules belong to the real one. This is that: the pinning
 * `Agent`, its `connect.lookup`, and an actual TCP connection.
 *
 * WHY A NAME AND NOT AN IP LITERAL, which is the entire point of this file. `resolvePinned` skips
 * `dns.lookup` for a literal (`isIP(bare)` → the address IS the answer), so a fixture URL built on
 * `127.0.0.1` never executes the lookup callback at all. Every existing test used either that
 * literal or an injected transport, so the callback — the one piece of code that has to satisfy
 * Node's resolver contract — was never once run by the suite while being run by every real
 * verification in production. `localhost` is a NAME: it goes through `dns.lookup`, through the
 * callback, and through the socket. That difference is the bug this file exists to catch.
 *
 * No database: this is a socket test, and gating it on `DATABASE_URL` would mean the regression is
 * only caught in the runs that happen to have one.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SourceFetchError,
  fetchSource,
  undiciTransport,
} from "../../src/modules/services/verification/fetcher.service.js";

const PAGE =
  "<!doctype html><html><head><title>A real programme</title></head><body>Hi.</body></html>";

/** The refusal a target must produce — and a loud failure if it was fetched instead. */
async function refusalFor(url: string): Promise<SourceFetchError> {
  try {
    await fetchSource(url, { allowPrivateHosts: false, transport: undiciTransport });
  } catch (error) {
    if (error instanceof SourceFetchError) return error;
    throw error;
  }
  throw new Error(`${url} was fetched. It had to be refused.`);
}

describe("M3XPORT the pinning transport, over a real socket", () => {
  let origin: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    // Bound to the address `localhost` ITSELF resolves to first, rather than to a hard-coded
    // 127.0.0.1: the transport pins whatever the resolver puts first, so on a machine that answers
    // `::1` first a v4-only listener would be refused for a reason that has nothing to do with what
    // is under test.
    const [first] = await dnsLookup("localhost", { all: true });
    if (!first) throw new Error("localhost does not resolve on this machine");

    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, first.address, resolve));
    const { port } = server.address() as AddressInfo;
    origin = `http://localhost:${port}`;
    close = () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }, 30_000);

  afterAll(async () => {
    await close?.();
  });

  it("resolves a HOSTNAME, pins it, and completes the request", async () => {
    // Under `autoSelectFamily` — on by default since Node 20 — `net.connect` calls the pinned
    // `lookup` with `all: true` and expects an ARRAY of addresses. Answering with the legacy
    // two-argument shape put a string where the array belonged and the socket died with
    // "Invalid IP address: undefined", which is what every real verification in production hit.
    const fetched = await fetchSource(`${origin}/programme`, {
      allowPrivateHosts: true,
      transport: undiciTransport,
    });

    expect(fetched.status).toBe(200);
    expect(fetched.text).toContain("A real programme");
    expect(fetched.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fetched.truncated).toBe(false);
    expect(fetched.finalUrl).toBe(`${origin}/programme`);
  }, 30_000);

  it("still refuses that same hostname when private hosts are not allowed", async () => {
    // The pin is not loosened by the fix: `localhost` resolves to loopback, and loopback is refused
    // unless a test explicitly opts in. A transport that fetched this would be an SSRF hole, so the
    // two cases belong in one file — the fix must not have bought its success by relaxing anything.
    // The category carries WHY, which is what a failed run records, so the assertion names it.
    expect((await refusalFor(`${origin}/programme`)).category).toBe("address_refused:loopback");
  }, 30_000);

  it("refuses a name that resolves to the metadata address, by name", async () => {
    // The rebinding shape, as far as it can be driven offline: the classifier's verdict is about the
    // ADDRESS, so a name is no way around it. (`localtest.me` and friends need DNS; this one is the
    // literal, which exercises the other branch of `resolvePinned` — both must refuse.)
    const refusal = await refusalFor("http://169.254.169.254/latest/meta-data/");
    expect(refusal.category).toBe("address_refused:link-local");
  }, 30_000);
});
