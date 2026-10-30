/**
 * The two URL rules the link-out surfaces lean on: which stored values may be offered as a link,
 * and what host a reader is told a link goes to.
 *
 * `isPublishableUrl` mirrors the API's `isPublishableUrl` (`api/src/modules/shared/url-policy.ts`);
 * the cases below are the ones that rule exists to refuse, plus the loopback exemption it keeps.
 * `linkHost` is what a button label and the `/leaving` page show, so its cases are the ways a URL
 * can name one place in its text and go to another.
 */
import { isPublishableUrl, linkHost } from "@/lib/url-policy";
import { describe, expect, it } from "vitest";

describe("isPublishableUrl", () => {
  it.each([
    "https://airtable.com/appX/shrY",
    "https://forms.example.org/apply?round=4#top",
    "HTTPS://EXAMPLE.ORG/",
    // Plaintext only where it never crosses a network: the API's loopback exemption.
    "http://localhost:3001/apply",
    "http://127.0.0.1:8080/apply",
    "http://api.localhost/apply",
    "http://[::1]:3000/",
  ])("accepts %s", (value) => {
    expect(isPublishableUrl(value)).toBe(true);
  });

  it.each([
    "http://example.org/apply",
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "mailto:grants@example.org",
    "ftp://example.org/apply",
    // The right scheme, but a relative reference: a consumer resolves it against its own base.
    "https:example.org/apply",
    "//example.org/apply",
    "/apply",
    "example.org/apply",
    " https://example.org/apply",
    "https://",
    "",
  ])("refuses %j", (value) => {
    expect(isPublishableUrl(value)).toBe(false);
  });

  it("refuses private network hosts over plaintext: they are not loopback", () => {
    expect(isPublishableUrl("http://192.168.1.10/apply")).toBe(false);
    expect(isPublishableUrl("http://printer.local/apply")).toBe(false);
  });
});

describe("linkHost", () => {
  it("names the whole host, lowercased, www. included", () => {
    expect(linkHost("https://www.typeform.com/to/abc")).toBe("www.typeform.com");
    expect(linkHost("https://tally.so/r/xyz")).toBe("tally.so");
    expect(linkHost("https://WWW.Example.ORG/Apply")).toBe("www.example.org");
    expect(linkHost("https://apply.example.org/round-4")).toBe("apply.example.org");
  });

  it.each([
    ["https://www.co.uk/", "www.co.uk"],
    ["https://www.github.io/", "www.github.io"],
    ["https://www.com./", "www.com."],
    ["https://www.com/", "www.com"],
  ])("never trims %s into a different registrable name", (url, host) => {
    expect(linkHost(url)).toBe(host);
  });

  it("keeps a non-default port in view", () => {
    expect(linkHost("https://example.org:8443/apply")).toBe("example.org:8443");
    expect(linkHost("https://example.org:443/apply")).toBe("example.org");
    expect(linkHost("http://localhost:3001/apply")).toBe("localhost:3001");
  });

  it("names the host the browser will connect to, not the one the text leads with", () => {
    expect(linkHost("https://airtable.com@evil.example/form")).toBe("evil.example");
    expect(linkHost("https://airtable.com:pw@evil.example/form")).toBe("evil.example");
  });

  it("shows a look-alike internationalized name as the punycode it really is", () => {
    // Cyrillic "а" in place of the Latin "a".
    expect(linkHost("https://аirtable.com/form")).toBe("xn--irtable-1fg.com");
  });

  it.each([
    null,
    undefined,
    "",
    "not a url",
    "javascript:alert(1)",
    "mailto:grants@example.org",
    "https:example.org/apply",
    "/apply",
    "https://",
  ])("has no honest answer for %j", (value) => {
    expect(linkHost(value)).toBeNull();
  });
});
