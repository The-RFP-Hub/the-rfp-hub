/**
 * The pure guts of `/logos/[slug]`: which URLs this server will fetch on a publisher's behalf
 * (the SSRF gate), and which response content types it will relay to a reader.
 */
import { acceptableLogoContentType, isSafeLogoUrl } from "@/lib/logo-proxy";
import { describe, expect, it } from "vitest";

describe("isSafeLogoUrl", () => {
  it("accepts ordinary http(s) logo hosts", () => {
    expect(isSafeLogoUrl("https://cdn.example.org/logo.png")).toBe(true);
    expect(isSafeLogoUrl("http://assets.example.com/logo.svg")).toBe(true);
    expect(isSafeLogoUrl("https://example.com:443/logo.png")).toBe(true);
    expect(isSafeLogoUrl("http://example.com:80/logo.png")).toBe(true);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isSafeLogoUrl("ftp://example.com/logo.png")).toBe(false);
    expect(isSafeLogoUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeLogoUrl("data:image/png;base64,AAAA")).toBe(false);
  });

  it("rejects unparseable strings", () => {
    expect(isSafeLogoUrl("not a url")).toBe(false);
    expect(isSafeLogoUrl("")).toBe(false);
  });

  it("rejects literal IPv4 hosts, decimal and alternate encodings", () => {
    expect(isSafeLogoUrl("http://127.0.0.1/logo.png")).toBe(false);
    expect(isSafeLogoUrl("http://10.0.0.5/logo.png")).toBe(false);
    expect(isSafeLogoUrl("http://192.168.1.1/logo.png")).toBe(false);
    expect(isSafeLogoUrl("http://0x7f000001/logo.png")).toBe(false);
    expect(isSafeLogoUrl("http://2130706433/logo.png")).toBe(false);
    expect(isSafeLogoUrl("http://017700000001/logo.png")).toBe(false);
    expect(isSafeLogoUrl("http://0.0.0.0/logo.png")).toBe(false);
  });

  it("rejects literal IPv6 hosts", () => {
    expect(isSafeLogoUrl("http://[::1]/logo.png")).toBe(false);
    expect(isSafeLogoUrl("http://[fe80::1]/logo.png")).toBe(false);
  });

  it("rejects localhost and reserved-looking TLDs", () => {
    expect(isSafeLogoUrl("http://localhost/logo.png")).toBe(false);
    expect(isSafeLogoUrl("http://localhost:3000/logo.png")).toBe(false);
    expect(isSafeLogoUrl("http://service.localhost/logo.png")).toBe(false);
    expect(isSafeLogoUrl("http://internal.local/logo.png")).toBe(false);
    expect(isSafeLogoUrl("http://backend.internal/logo.png")).toBe(false);
  });

  it("rejects non-standard ports", () => {
    expect(isSafeLogoUrl("http://example.com:8080/logo.png")).toBe(false);
    expect(isSafeLogoUrl("https://example.com:8443/logo.png")).toBe(false);
    expect(isSafeLogoUrl("http://example.com:22/logo.png")).toBe(false);
  });
});

describe("acceptableLogoContentType", () => {
  it("accepts the four allowed image types", () => {
    expect(acceptableLogoContentType("image/png")).toBe("image/png");
    expect(acceptableLogoContentType("image/jpeg")).toBe("image/jpeg");
    expect(acceptableLogoContentType("image/webp")).toBe("image/webp");
    expect(acceptableLogoContentType("image/svg+xml")).toBe("image/svg+xml");
  });

  it("ignores a trailing charset parameter", () => {
    expect(acceptableLogoContentType("image/svg+xml; charset=utf-8")).toBe("image/svg+xml");
    expect(acceptableLogoContentType("image/png;charset=binary")).toBe("image/png");
  });

  it("is case-insensitive on the media type", () => {
    expect(acceptableLogoContentType("Image/PNG")).toBe("image/png");
  });

  it("rejects everything else, including null", () => {
    expect(acceptableLogoContentType(null)).toBeNull();
    expect(acceptableLogoContentType("")).toBeNull();
    expect(acceptableLogoContentType("text/html")).toBeNull();
    expect(acceptableLogoContentType("image/gif")).toBeNull();
    expect(acceptableLogoContentType("application/octet-stream")).toBeNull();
    expect(acceptableLogoContentType("image/svg+xml+evil")).toBeNull();
  });
});
