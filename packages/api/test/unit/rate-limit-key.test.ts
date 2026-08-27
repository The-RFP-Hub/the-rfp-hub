/**
 * The address half of a rate-limit key, on its own.
 *
 * `rateLimitKey` prefers the account and only falls back to the address, so this file is about the
 * fallback: WHAT an address has to be reduced to before it can stand for a caller. An IPv6 host
 * address cannot — the smallest allocation anyone receives is a /64, so keying on the full address
 * hands out a fresh bucket per request to anyone willing to increment the host bits. The table
 * below is the property `addressBucket` exists to have, and the mapped-IPv4 case is the trap:
 * folding `::ffff:a.b.c.d` naively into "first four groups" makes every mapped caller in the world
 * one bucket.
 */
import { describe, expect, it } from "vitest";
import { addressBucket } from "../../src/modules/routes/shared/rate-limit-key.js";

describe("addressBucket", () => {
  it("leaves IPv4 exactly as it is", () => {
    // A v4 address is not handed out 2^64 at a time; grouping it would only merge strangers.
    expect(addressBucket("203.0.113.9")).toBe("203.0.113.9");
    expect(addressBucket("127.0.0.1")).toBe("127.0.0.1");
  });

  it("groups every address in one /64 together", () => {
    const bucket = addressBucket("2001:db8:1:1::1");
    // The host half is the attacker's to choose, so none of it may reach the key.
    expect(addressBucket("2001:db8:1:1::2")).toBe(bucket);
    expect(addressBucket("2001:db8:1:1:ffff:ffff:ffff:ffff")).toBe(bucket);
    expect(addressBucket("2001:0db8:0001:0001:0000:0000:0000:0009")).toBe(bucket);
    // The network half is not: a different /64 is a different customer.
    expect(addressBucket("2001:db8:1:2::1")).not.toBe(bucket);
    expect(addressBucket("2001:db8:2:1::1")).not.toBe(bucket);
  });

  it("folds an IPv4-mapped address back to the IPv4 address it carries", () => {
    // Its first four groups are all zero. Without this branch every mapped caller — which is what
    // a dual-stack listener reports for a v4 client — would share one bucket.
    expect(addressBucket("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(addressBucket("::ffff:198.51.100.1")).not.toBe(addressBucket("::ffff:203.0.113.9"));
    expect(addressBucket("::ffff:203.0.113.9")).toBe(addressBucket("203.0.113.9"));
  });

  it("ignores a scope id, which names an interface here rather than a caller there", () => {
    expect(addressBucket("fe80::1%eth0")).toBe(addressBucket("fe80::2"));
  });

  it("passes anything it cannot parse through unchanged rather than collapsing it", () => {
    // A key that is merely odd is survivable; a key that silently becomes the same string for
    // every caller is a denial of service on all of them at once.
    expect(addressBucket("not-an-address")).toBe("not-an-address");
    expect(addressBucket("")).toBe("");
  });
});
