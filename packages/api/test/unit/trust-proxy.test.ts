import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildTrustProxy, isNonPublicAddress } from "../../src/modules/shared/trust-proxy.js";

async function clientAddress(
  configured: number | string[] | undefined,
  forwarded: string,
  socket: string,
): Promise<string> {
  const app = Fastify({ trustProxy: buildTrustProxy(configured) });
  app.get("/", async (request) => ({ ip: request.ip }));
  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { "x-forwarded-for": forwarded },
      remoteAddress: socket,
    });
    return res.json<{ ip: string }>().ip;
  } finally {
    await app.close();
  }
}

describe("isNonPublicAddress", () => {
  it.each([
    "10.1.2.3",
    "172.16.0.9",
    "172.31.255.255",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.10.1",
    "::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:10.0.0.5",
  ])("treats %s as non-public", (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each([
    "203.0.113.9",
    "172.32.0.1",
    "8.8.8.8",
    "2001:db8::1",
    "::ffff:203.0.113.9",
    "nope",
    "",
  ])("treats %s as public or unknown", (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });
});

describe("a hop count behind a private peer", () => {
  it("reads the address the proxy saw, not the leftmost claim", async () => {
    expect(await clientAddress(1, "198.51.100.1, 192.0.2.2", "10.0.0.5")).toBe("192.0.2.2");
  });

  it("ignores X-Forwarded-For from a peer on a public address", async () => {
    expect(await clientAddress(1, "192.0.2.77", "203.0.113.9")).toBe("203.0.113.9");
    expect(await clientAddress(3, "192.0.2.77, 192.0.2.78", "203.0.113.9")).toBe("203.0.113.9");
  });

  it("believes no more entries than the count names", async () => {
    expect(await clientAddress(2, "198.51.100.1, 192.0.2.2, 192.0.2.3", "10.0.0.5")).toBe(
      "192.0.2.2",
    );
  });

  it("passes an address list and an unset value through untouched", async () => {
    expect(buildTrustProxy(undefined)).toBeUndefined();
    expect(buildTrustProxy(["10.0.0.0/8"])).toEqual(["10.0.0.0/8"]);
    expect(await clientAddress(["10.0.0.0/8"], "192.0.2.2", "10.0.0.5")).toBe("192.0.2.2");
  });
});
