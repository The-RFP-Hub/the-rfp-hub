/**
 * The fetcher's protocol-level rules, driven through the injected transport: schemes, redirect
 * hops, the content-type allowlist, the byte cap's digest, and what the request carries.
 *
 * The ADDRESS rules are not here. They are a fact about a resolved address and belong to the real
 * transport, which `test/integration/verification.test.ts` drives against real loopback and
 * link-local targets. Splitting them this way is what makes both halves testable: this file needs
 * no socket, and that one needs no fixture.
 */
import { describe, expect, it } from "vitest";
import {
  SourceFetchError,
  type SourceTransport,
  VERIFIER_USER_AGENT,
  fetchSource,
} from "../../src/modules/services/verification/fetcher.service.js";

const PAGE = "<!doctype html><html><head><title>A programme</title></head><body>Hi.</body></html>";

function transport(
  pages: Record<string, { status?: number; headers?: Record<string, string>; body?: string }>,
  seen?: { url: string; headers: Record<string, string> }[],
): SourceTransport {
  return async (url, options) => {
    await options.onHop?.(url);
    seen?.push({ url, headers: options.headers });
    const page = pages[url] ?? { status: 404, body: "" };
    return {
      status: page.status ?? 200,
      headers: { "content-type": "text/html; charset=utf-8", ...(page.headers ?? {}) },
      bytes: Buffer.from(page.body ?? ""),
      truncated: false,
    };
  };
}

const options = { transport: transport({ "https://example.org/a": { body: PAGE } }) };

describe("source fetcher", () => {
  it("returns the page, its digest, and the hop it ended on", async () => {
    const result = await fetchSource("https://example.org/a", options);
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe("https://example.org/a");
    expect(result.text).toContain("A programme");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.redirects).toEqual([]);
  });

  it("carries an identifying agent and nothing that could be a credential", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    await fetchSource("https://example.org/a", {
      transport: transport({ "https://example.org/a": { body: PAGE } }, seen),
    });
    const headers = seen[0]?.headers ?? {};
    expect(VERIFIER_USER_AGENT).toBe(
      "RFPHubVerifier/1.0 (+https://github.com/The-RFP-Hub/the-rfp-hub)",
    );
    expect(headers).toMatchObject({
      "user-agent": VERIFIER_USER_AGENT,
      accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8",
      "accept-language": "en",
    });
    // A verifier that forwarded a credential would be handing it to whoever the submitter chose.
    for (const forbidden of ["authorization", "cookie", "referer"]) {
      expect(Object.keys(headers), forbidden).not.toContain(forbidden);
    }
  });

  it("refuses every scheme that is not http(s)", async () => {
    for (const url of [
      "file:///etc/passwd",
      "gopher://example.org/1",
      "data:text/html,<h1>hi</h1>",
      "ftp://example.org/x",
    ]) {
      await expect(fetchSource(url, options), url).rejects.toMatchObject({
        category: "scheme_not_allowed",
      });
    }
  });

  it("follows redirects by hand, and gives up at the hop budget", async () => {
    const chain = transport({
      "https://example.org/1": { status: 302, headers: { location: "/2" } },
      "https://example.org/2": { status: 301, headers: { location: "/3" } },
      "https://example.org/3": { body: PAGE },
    });
    const result = await fetchSource("https://example.org/1", { transport: chain });
    expect(result.finalUrl).toBe("https://example.org/3");
    expect(result.redirects).toEqual(["https://example.org/2", "https://example.org/3"]);
    // The requested URL is preserved, so the off-domain check compares the right two hosts.
    expect(result.requestedUrl).toBe("https://example.org/1");

    const loop = transport({
      "https://example.org/x": { status: 302, headers: { location: "/x" } },
    });
    await expect(
      fetchSource("https://example.org/x", { transport: loop, maxRedirects: 2 }),
    ).rejects.toMatchObject({ category: "too_many_redirects" });
  });

  /**
   * THE POLITENESS SEAM. A redirect is a request to a DIFFERENT server, so a caller pacing itself
   * on the entry's own URL alone would space thirty vanity domains perfectly and burst thirty
   * requests onto the one platform they all redirect to. `onHop` is how the verification service
   * hands its per-host pacer every hop; it fires after the scheme check, so a URL this fetcher
   * would never open is never waited on.
   */
  it("announces every hop before requesting it, and none it refuses outright", async () => {
    const seen: string[] = [];
    const onHop = async (url: string) => {
      seen.push(url);
    };

    await fetchSource("https://example.org/one", {
      transport: transport({
        "https://example.org/one": { status: 302, headers: { location: "https://b.example/two" } },
        "https://b.example/two": { status: 302, headers: { location: "https://c.example/three" } },
        "https://c.example/three": { body: PAGE },
      }),
      onHop,
    });
    expect(seen).toEqual([
      "https://example.org/one",
      "https://b.example/two",
      "https://c.example/three",
    ]);

    seen.length = 0;
    await expect(fetchSource("file:///etc/passwd", { ...options, onHop })).rejects.toBeInstanceOf(
      SourceFetchError,
    );
    expect(
      seen,
      "a scheme that is refused never reaches a server, so it is never waited on",
    ).toEqual([]);
  });

  it("refuses a redirect that names nowhere to go", async () => {
    const headless = transport({ "https://example.org/z": { status: 302 } });
    await expect(
      fetchSource("https://example.org/z", { transport: headless }),
    ).rejects.toMatchObject({ category: "redirect_without_location" });
  });

  /**
   * A `Location` THAT IS NOT A URL IS THE SERVER'S FAULT, AND PERMANENTLY SO. `new URL` throws a
   * native `TypeError` for `http://` and `//`, which an unclassified `catch` upstream records as
   * `transport_failure` — and verification treats that as TRANSIENT, so the entry is never stamped
   * and is re-fetched every night for as long as that server keeps answering the same way. It is a
   * property of the redirect, not of the network, so it carries its own category.
   */
  it("names a redirect whose Location is not a URL, rather than looking like a network failure", async () => {
    for (const location of ["http://", "//", "http://["]) {
      const error = await fetchSource("https://example.org/go", {
        transport: transport({
          "https://example.org/go": { status: 302, headers: { location } },
        }),
      }).catch((e: unknown) => e);

      expect(error, location).toBeInstanceOf(SourceFetchError);
      expect((error as SourceFetchError).category, location).toBe("redirect_malformed");
      expect((error as SourceFetchError).status, location).toBe(302);
      expect((error as SourceFetchError).message, location).toContain(location);
    }
  });

  it("refuses a body that is not a source page", async () => {
    const binary = transport({
      "https://example.org/v": { headers: { "content-type": "video/mp4" }, body: "not a page" },
    });
    await expect(fetchSource("https://example.org/v", { transport: binary })).rejects.toMatchObject(
      {
        category: "content_type_not_allowed",
      },
    );

    // An ABSENT content type is unstated, not wrong — plenty of real servers omit it.
    const bare = transport({ "https://example.org/w": { headers: {}, body: PAGE } });
    const result = await fetchSource("https://example.org/w", {
      transport: async (url, opts) => {
        const hop = await bare(url, opts);
        return { ...hop, headers: {} };
      },
    });
    expect(result.contentType).toBeNull();
    expect(result.text).toContain("A programme");
  });

  it("decodes a declared charset, and falls back rather than failing on a bad label", async () => {
    const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café" in latin1
    const result = await fetchSource("https://example.org/c", {
      transport: async () => ({
        status: 200,
        headers: { "content-type": "text/html; charset=iso-8859-1" },
        bytes: latin,
        truncated: false,
      }),
    });
    expect(result.text).toBe("café");

    const nonsense = await fetchSource("https://example.org/c", {
      transport: async () => ({
        status: 200,
        headers: { "content-type": "text/html; charset=not-a-charset" },
        bytes: Buffer.from("plain"),
        truncated: false,
      }),
    });
    expect(nonsense.text).toBe("plain");
  });

  it("carries the refusal category, so a failed run can record why", async () => {
    const error = await fetchSource("file:///etc/passwd", options).catch((e) => e);
    expect(error).toBeInstanceOf(SourceFetchError);
    expect(error.category).toBe("scheme_not_allowed");
  });
});
