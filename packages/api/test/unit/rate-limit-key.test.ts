/**
 * The address half of a rate-limit key, on its own.
 *
 * Behind a trusted proxy `request.ip` is a token out of `X-Forwarded-For`, so everything here is
 * potentially attacker-written text. Two properties have to hold for every input: it never lands in
 * the `acct:` namespace, and it never becomes a fresh bucket per connection.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { addressBucket } from "../../src/modules/routes/shared/rate-limit-key.js";

const INVALID = "ip:invalid";

describe("addressBucket", () => {
  it("leaves IPv4 exactly as it is, under the address namespace", () => {
    // A v4 address is not handed out 2^64 at a time; grouping it would only merge strangers.
    expect(addressBucket("203.0.113.9")).toBe("ip:203.0.113.9");
    expect(addressBucket("127.0.0.1")).toBe("ip:127.0.0.1");
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
    expect(bucket).toBe("ip:2001:db8:1:1::/64");
  });

  it("folds the two IPv6 forms that embed an IPv4 address back to it", () => {
    // Both have zeros where the /64 lives, so without the fold every such caller — which for the
    // mapped form is every v4 client of a dual-stack listener — would share one bucket.
    expect(addressBucket("::ffff:203.0.113.9")).toBe("ip:203.0.113.9");
    expect(addressBucket("::ffff:cb00:7109")).toBe("ip:203.0.113.9");
    expect(addressBucket("::203.0.113.9")).toBe("ip:203.0.113.9");
    expect(addressBucket("::ffff:198.51.100.1")).not.toBe(addressBucket("::ffff:203.0.113.9"));
  });

  it("ignores a scope id, which names an interface here rather than a caller there", () => {
    expect(addressBucket("fe80::1%eth0")).toBe(addressBucket("fe80::2"));
  });

  it("strips a port instead of minting a bucket per connection", () => {
    // A source port changes on every connection. One bucket per port is no limit at all.
    expect(addressBucket("203.0.113.9:4000")).toBe("ip:203.0.113.9");
    expect(addressBucket("203.0.113.9:4001")).toBe(addressBucket("203.0.113.9:4000"));
    expect(addressBucket("[2001:db8::1]:4000")).toBe(addressBucket("2001:db8::1"));
    expect(addressBucket("[2001:db8::1]")).toBe(addressBucket("2001:db8::1"));
  });

  it("ignores surrounding whitespace", () => {
    expect(addressBucket("  203.0.113.9  ")).toBe("ip:203.0.113.9");
    expect(addressBucket("\t2001:db8:1:1::1\n")).toBe(addressBucket("2001:db8:1:1::1"));
  });

  it("sends anything that is not an address to one fixed bucket", () => {
    // Never the caller's own text as a key: a forwarded value is attacker-written, and using it
    // verbatim means a bucket per string as well as a bucket the attacker can name.
    expect(addressBucket("not-an-address")).toBe(INVALID);
    expect(addressBucket("")).toBe(INVALID);
    expect(addressBucket("   ")).toBe(INVALID);
    expect(addressBucket("203.0.113.9, 198.51.100.1")).toBe(INVALID);
    expect(addressBucket("010.0.0.1")).toBe(INVALID);
    expect(addressBucket("2001:db8::1::2")).toBe(INVALID);
    expect(addressBucket("<script>")).toBe(INVALID);
  });

  it("never lets a forwarded value reach the account namespace", () => {
    // THE COLLISION THIS PREFIX EXISTS FOR. `acct:7` is one colon followed by digits, which is
    // also the shape of a host and a port — so it must not be split into a host either.
    for (const probe of ["acct:7", "acct:1", "acct:", "ip:203.0.113.9"]) {
      expect(addressBucket(probe)).toBe(INVALID);
      expect(addressBucket(probe).startsWith("acct:")).toBe(false);
    }
  });
});

describe("addressBucket behind a trusted proxy", () => {
  /** What Fastify hands the key generator as `request.ip` for a given `X-Forwarded-For`. */
  async function clientAddress(forwarded: string, socket: string): Promise<string> {
    const app = Fastify({ trustProxy: 1 });
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

  it("keeps a forged X-Forwarded-For out of the account namespace", async () => {
    // `trustProxy: 1` believes the token one hop in front of the socket peer, so this is what a
    // caller who can reach the proxy actually gets to write.
    expect(await clientAddress("acct:1", "10.0.0.5")).toBe("acct:1");
    expect(addressBucket(await clientAddress("acct:1", "10.0.0.5"))).toBe(INVALID);
  });

  it("selects the hop the count names, and buckets it", async () => {
    // Two hops with a count of one: the address BEFORE the last proxy, not the leftmost claim.
    expect(await clientAddress("198.51.100.1, 192.0.2.2", "10.0.0.5")).toBe("192.0.2.2");
    expect(addressBucket("192.0.2.2")).toBe("ip:192.0.2.2");
  });
});
