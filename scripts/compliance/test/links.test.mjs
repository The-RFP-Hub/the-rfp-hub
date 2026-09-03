/**
 * Markdown link extraction — the docs check's ability to name exactly which link is broken
 * depends on getting every href out of a file, inline and autolink alike, without duplicates.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractLinks,
  githubSlug,
  headingSlugs,
  isAbsoluteHttpLink,
  isAnchorLink,
  isUnresolvedReference,
  resolveRelativeLink,
} from "../links.mjs";

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

  it("resolves a reference-style link through its definition", () => {
    const md = "See [the guide][g] and [deploy].\n\n[g]: ./guide.md\n[deploy]: ./deployment.md\n";
    expect(extractLinks(md)).toEqual([
      { href: "./guide.md", kind: "reference" },
      { href: "./deployment.md", kind: "reference" },
    ]);
  });

  it("names a reference whose definition is missing instead of dropping it", () => {
    const [link] = extractLinks("See [the guide][missing].");
    expect(isUnresolvedReference(link.href)).toBe(true);
  });

  it("finds a bare URL written as prose", () => {
    expect(extractLinks("Fetch https://example.org/data.json for the dataset.")).toEqual([
      { href: "https://example.org/data.json", kind: "bare" },
    ]);
  });

  it("ignores URLs inside fenced and inline code", () => {
    const md = [
      "```sh safe-read",
      'curl -s "https://example.org/x"',
      "```",
      "",
      "`https://y.example`",
    ].join("\n");
    expect(extractLinks(md)).toEqual([]);
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
  const at = (href) =>
    resolveRelativeLink(href, { fileDir: "/repo/docs", repoRoot: "/repo", path });

  it("resolves a same-directory relative link against repoRoot", () => {
    expect(at("./api-integration.md")).toMatchObject({
      path: "docs/api-integration.md",
      fragment: undefined,
      escapesRepo: false,
    });
  });

  it("separates the fragment rather than discarding it", () => {
    expect(at("../GOVERNANCE.md#appeals")).toMatchObject({
      path: "GOVERNANCE.md",
      fragment: "appeals",
    });
  });

  it("returns null for a pure same-file anchor", () => {
    expect(at("#section")).toBeNull();
  });

  it("reports a ../ that walks out of the checkout", () => {
    // It may resolve on the author's disk and cannot resolve on the published mirror.
    expect(at("../../secrets/keys.md")).toMatchObject({ escapesRepo: true });
    expect(at("../../../etc/passwd")).toMatchObject({ escapesRepo: true });
  });
});

describe("githubSlug / headingSlugs", () => {
  it("lowercases, drops punctuation and hyphenates spaces", () => {
    expect(githubSlug("RFC process")).toBe("rfc-process");
    expect(githubSlug("What this is — and what it is not")).toBe(
      "what-this-is--and-what-it-is-not",
    );
    expect(githubSlug("`code` in a heading")).toBe("code-in-a-heading");
  });

  it("collects every heading level and suffixes repeats the way GitHub does", () => {
    const slugs = headingSlugs(
      ["# Deploy", "## Steps", "### Steps", "text", "## Steps"].join("\n"),
    );
    expect([...slugs]).toEqual(["deploy", "steps", "steps-1", "steps-2"]);
  });

  it("ignores headings inside a fenced block", () => {
    const slugs = headingSlugs(["# Real", "", "```sh", "# not a heading", "```"].join("\n"));
    expect([...slugs]).toEqual(["real"]);
  });
});
