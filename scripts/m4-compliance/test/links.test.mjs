/**
 * Markdown link extraction — the docs check's ability to name exactly which link is broken
 * depends on getting every href out of a file, inline and autolink alike, without duplicates.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { extractLinks, isAbsoluteHttpLink, isAnchorLink, resolveRelativeLink } from "../links.mjs";

describe("extractLinks", () => {
  it("finds inline links, ignoring a title", () => {
    const links = extractLinks('See [the guide](./guide.md "Guide") for details.');
    expect(links).toEqual([{ href: "./guide.md", kind: "inline" }]);
  });

  it("finds autolinks", () => {
    const links = extractLinks("Read <https://example.org/docs> directly.");
    expect(links).toEqual([{ href: "https://example.org/docs", kind: "autolink" }]);
  });

  it("finds both kinds in one document, without duplicates", () => {
    // Order is inline links first, then autolinks — extractLinks scans each kind with its own
    // pass rather than interleaving by source position, so that is what this asserts.
    const md = `
[a](./a.md)
[a](./a.md)
<https://example.org>
[b](https://example.org/b)
`;
    const links = extractLinks(md);
    expect(links).toEqual([
      { href: "./a.md", kind: "inline" },
      { href: "https://example.org/b", kind: "inline" },
      { href: "https://example.org", kind: "autolink" },
    ]);
  });

  it("returns nothing for plain prose", () => {
    expect(extractLinks("No links here at all.")).toEqual([]);
  });
});

describe("isAbsoluteHttpLink", () => {
  it("is true for http(s), false otherwise", () => {
    expect(isAbsoluteHttpLink("https://example.org")).toBe(true);
    expect(isAbsoluteHttpLink("http://example.org")).toBe(true);
    expect(isAbsoluteHttpLink("./relative.md")).toBe(false);
    expect(isAbsoluteHttpLink("#anchor")).toBe(false);
    expect(isAbsoluteHttpLink("mailto:a@example.org")).toBe(false);
  });
});

describe("isAnchorLink", () => {
  it("is true only for a same-document fragment", () => {
    expect(isAnchorLink("#section")).toBe(true);
    expect(isAnchorLink("./file.md#section")).toBe(false);
  });
});

describe("resolveRelativeLink", () => {
  it("resolves a same-directory relative link against repoRoot", () => {
    const resolved = resolveRelativeLink("./api-integration.md", {
      fileDir: "/repo/docs",
      repoRoot: "/repo",
      path,
    });
    expect(resolved).toBe("docs/api-integration.md");
  });

  it("strips a trailing fragment before resolving", () => {
    const resolved = resolveRelativeLink("../GOVERNANCE.md#appeals", {
      fileDir: "/repo/docs",
      repoRoot: "/repo",
      path,
    });
    expect(resolved).toBe("GOVERNANCE.md");
  });

  it("returns null for a pure same-file anchor", () => {
    expect(
      resolveRelativeLink("#section", { fileDir: "/repo/docs", repoRoot: "/repo", path }),
    ).toBeNull();
  });
});
