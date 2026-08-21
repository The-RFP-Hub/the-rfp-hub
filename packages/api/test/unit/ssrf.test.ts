/**
 * THE OUTBOUND ADDRESS RULES.
 *
 * The verifier fetches a URL a stranger submitted, from inside the network. Every range below is
 * one an attacker would aim at, and `169.254.169.254` — the instance metadata endpoint, which
 * answers unauthenticated requests with credentials — is the one that turns an SSRF into a
 * compromise.
 *
 * The IPv4-mapped cases exist because a check that only understood dotted quads let
 * `::ffff:169.254.169.254` straight through. And the last case here is the design itself: this
 * function must be handed a RESOLVED ADDRESS, never a hostname, because validating a name and then
 * letting the connection resolve it again is the DNS-rebinding gap the pinned dispatcher exists to
 * close.
 */
import { describe, expect, it } from "vitest";
import {
  classifyAddress,
  isAllowedScheme,
  isPublicAddress,
} from "../../src/modules/shared/ssrf.js";

describe("isAllowedScheme", () => {
  it("permits http and https only", () => {
    expect(isAllowedScheme("http:")).toBe(true);
    expect(isAllowedScheme("HTTPS:")).toBe(true);
  });

  // The interesting ones are not network protocols: `file:` reads the container's filesystem and
  // `data:` would let the "source page" be whatever the submitter typed.
  it("refuses everything else by name", () => {
    for (const scheme of ["file:", "data:", "gopher:", "dict:", "ftp:", "ws:", "javascript:"]) {
      expect(isAllowedScheme(scheme), scheme).toBe(false);
    }
  });
});

describe("classifyAddress — IPv4", () => {
  it("allows ordinary public addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "203.0.114.1"]) {
      expect(classifyAddress(ip), ip).toMatchObject({ allowed: true, category: "public" });
    }
  });

  it("refuses every special-purpose range, and says which one", () => {
    const cases: [string, string][] = [
      ["0.0.0.0", "unspecified"],
      ["10.1.2.3", "private"],
      ["100.64.0.1", "cgnat"],
      ["127.0.0.1", "loopback"],
      ["127.1.2.3", "loopback"],
      ["169.254.169.254", "link-local"],
      ["172.16.0.1", "private"],
      ["172.31.255.254", "private"],
      ["192.0.0.1", "reserved"],
      ["192.0.2.1", "documentation"],
      ["192.168.1.1", "private"],
      ["198.18.0.1", "benchmark"],
      ["198.51.100.1", "documentation"],
      ["203.0.113.1", "documentation"],
      ["224.0.0.1", "multicast"],
      ["255.255.255.255", "reserved"],
    ];
    for (const [ip, category] of cases) {
      const verdict = classifyAddress(ip);
      expect(verdict.allowed, ip).toBe(false);
      expect(verdict.category, ip).toBe(category);
      expect(verdict.reason, ip).toContain(ip);
    }
  });

  // 172.16/12 is a twelve-bit prefix, not a whole /8: 172.15 and 172.32 are public, and a check
  // written as `a === 172` would wrongly refuse both.
  it("gets the boundaries of 172.16/12 and 100.64/10 right", () => {
    expect(isPublicAddress("172.15.0.1")).toBe(true);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
    expect(isPublicAddress("100.63.255.255")).toBe(true);
    expect(isPublicAddress("100.128.0.1")).toBe(true);
  });
});

describe("classifyAddress — IPv6", () => {
  it("allows a public address", () => {
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("refuses the special-purpose ranges", () => {
    const cases: [string, string][] = [
      ["::", "unspecified"],
      ["::1", "loopback"],
      ["100::1", "discard"],
      ["2001:db8::1", "documentation"],
      ["fc00::1", "private"],
      ["fd12:3456::1", "private"],
      ["fe80::1", "link-local"],
      ["ff02::1", "multicast"],
    ];
    for (const [ip, category] of cases) {
      const verdict = classifyAddress(ip);
      expect(verdict.allowed, ip).toBe(false);
      expect(verdict.category, ip).toBe(category);
    }
  });

  // THE BYPASS: an IPv4 destination wearing an IPv6 literal. A check that only knew dotted quads
  // called this "some IPv6 address" and connected to the metadata endpoint.
  it("sees through IPv4-mapped and NAT64 forms to the address underneath", () => {
    const mapped = classifyAddress("::ffff:169.254.169.254");
    expect(mapped.allowed).toBe(false);
    expect(mapped.category).toBe("ipv4-mapped:link-local");

    expect(classifyAddress("::ffff:127.0.0.1").allowed).toBe(false);
    expect(classifyAddress("::ffff:10.0.0.1").allowed).toBe(false);
    expect(classifyAddress("64:ff9b::169.254.169.254").allowed).toBe(false);
    // …while a mapped PUBLIC address is still public.
    expect(classifyAddress("::ffff:8.8.8.8")).toMatchObject({ allowed: true });
  });

  it("ignores brackets and a zone id", () => {
    expect(classifyAddress("[::1]").allowed).toBe(false);
    expect(classifyAddress("fe80::1%eth0").category).toBe("link-local");
  });
});

describe("the input contract", () => {
  // Passing a hostname here is the rebinding bug this module exists to prevent, so it is refused
  // rather than resolved — loudly, with the reason.
  it("refuses a hostname, and explains why", () => {
    const verdict = classifyAddress("metadata.example.internal");
    expect(verdict.allowed).toBe(false);
    expect(verdict.category).toBe("not-an-address");
    expect(verdict.reason).toContain("RESOLVED address");
  });

  it("refuses garbage", () => {
    for (const value of ["", "999.999.999.999", "1.2.3", "::gg", "1.2.3.4.5"]) {
      expect(isPublicAddress(value), JSON.stringify(value)).toBe(false);
    }
  });
});
